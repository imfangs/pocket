import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, origin, refresh } from './fixture.mjs';

const results = [], startedAt = new Date().toISOString();
after(() => {
  const path = resolve(process.env.POCKET_MOTION_REPORT || '.local/qa/motion-continuity-2026-11-13/spec/browser.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
    planned: engines.length * 5, executed: results.length,
    status: results.some(item => !item.passed) ? 'failed' : results.length === engines.length * 5 ? 'passed' : 'partial',
    builds: [...new Set(results.map(item => item.build).filter(Boolean))], scenarios: results }, null, 2) + '\n');
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async (predicate, label = 'Controlled motion observation must arrive') => {
  const end = Date.now() + 8000;
  while (!await predicate()) { assert.ok(Date.now() < end, label); await new Promise(done => setTimeout(done, 15)); }
};
const line = page => page.locator('.collection-sync-line');
const mode = (page, value) => page.locator(`[data-collection-feedback="${value}"]`).waitFor();
const finishing = async page => line(page).evaluate(node => node.hasAttribute('data-finishing'));
const online = (page, value) => page.evaluate(value => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
  window.dispatchEvent(new Event(value ? 'online' : 'offline'));
}, value);

async function collection(page, h) {
  const state = { scope: 'smoke-ged', catalog: 'fresh', runtime: 'fresh', hold: false, calls: [], gates: [] };
  let time = Date.now();
  const threads = [ids.regular, ids.empty].map(id => ({ ...h.metadata(id), pocketPriority: false, codexPinned: false,
    pinned: false, hasUnreadTurn: false, needsInput: false }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, origin);
    const path = url.pathname; let data, status = 200;
    if (path.endsWith('/catalog') || path.endsWith('/sync')) {
      if (state.catalog === 'http-failure') { status = 503; data = { error: 'Synthetic transient connection' }; }
      else data = { threads: threads.map(thread => ({ ...thread, pocketContent: { ...thread.pocketContent, scope: state.scope } })),
        groups: [], projects: [{ id: 'fixture', name: '合成项目', paths: ['/synthetic'], order: 0, separator: false }],
        sourceInfo: { syncedAt: ++time, active: 2, archived: 0, total: 2, scope: 'synthetic',
          pocketRead: { available: true, scope: state.scope } },
        sourceError: state.catalog === 'cached-fallback' ? 'Synthetic cached source fallback' : null, csrfToken: 'synthetic-token' };
    } else if (path.endsWith('/task-statuses')) {
      data = state.runtime === 'http-failure' ? { error: 'Synthetic status failure' }
        : state.runtime === 'native-unavailable' ? { available: false, checkedAt: ++time, states: [] }
        : { available: true, checkedAt: ++time, states: threads.map(thread => ({ threadId: thread.id, status: 'idle', checkedAt: time })) };
      if (state.runtime === 'http-failure') status = 503;
    } else return await route.fallback();
    const call = { path, method: request.method(), scope: state.scope, status, ended: false, mode: state.catalog };
    state.calls.push(call);
    try {
      if (state.hold) { const gate = deferred(); call.gate = gate; state.gates.push(gate); await gate.promise; }
      await route.fulfill({ status, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'ged', 'cache-control': 'no-store' }, body: JSON.stringify(data) });
    } catch (error) { if (!page.isClosed() && !request.failure()) throw error; }
    finally { call.ended = true; }
  });
  state.release = () => { state.hold = false; state.gates.splice(0).forEach(gate => gate.resolve()); };
  h.motionCleanup = state.release;
  await refresh(page); await mode(page, 'idle');
  return state;
}
async function begin(page, state) {
  state.hold = true; const count = state.calls.length; await refresh(page);
  await until(() => state.calls.slice(count).some(call => /\/(catalog|sync)$/.test(call.path) && !call.ended));
  await mode(page, 'syncing');
  assert.equal(await finishing(page), false, 'Every new read immediately removes an old success tail');
}
async function frame(page) {
  return page.locator('.task-select[data-thread-id]').first().evaluate(node => ({ top: node.getBoundingClientRect().top,
    width: document.documentElement.scrollWidth, viewport: innerWidth, line: document.querySelector('.collection-sync-line').getBoundingClientRect().height }));
}
const record = (engine, name, options, run) => test(`${engine}: ${name}`, { timeout: 45000 }, async () => {
  const result = { engine, name, locale: options.locale, width: options.width, passed: false }; let h, cleanup, failure;
  try {
    h = await createHarness(engine, options); result.build = h.build;
    cleanup = await run(h);
    assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
  } catch (error) { failure = error; }
  finally {
    cleanup?.(); h?.motionCleanup?.();
    try { await h?.close(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
    result.passed = !failure; if (failure) result.error = failure.stack || String(failure); results.push(result);
  }
  if (failure) throw failure;
});

for (const engine of engines) for (const [locale, width] of [['zh-CN', 390], ['en-US', 320]]) {
  record(engine, `${locale}: same-scope success alone finishes the thin line and a new read interrupts it`, { locale, width }, async h => {
    const page = await h.open(null), state = await collection(page, h), before = await frame(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('.task-select').first().evaluate(node => { window.motionListRow = node; });
    await page.clock.install(); await page.clock.pauseAt(new Date());
    state.catalog = 'http-failure'; state.runtime = 'http-failure';
    await begin(page, state); state.release(); await mode(page, 'waiting');
    assert.equal(await finishing(page), false, 'Transport failure cannot be displayed as successful completion');
    state.catalog = 'cached-fallback'; state.runtime = 'native-unavailable';
    await begin(page, state); state.release(); await mode(page, 'waiting');
    assert.equal(await finishing(page), false, 'HTTP 200 with cached source/native-unavailable is not success');
    await begin(page, state); await online(page, false); state.release(); await mode(page, 'offline');
    assert.equal(await finishing(page), false, 'Cancellation/offline cannot leave a success tail');
    state.catalog = 'fresh'; state.runtime = 'fresh'; state.hold = true; await online(page, true); await mode(page, 'syncing');
    state.release(); await until(() => finishing(page), 'A validated same-scope successful read must expose its finishing phase');
    const css = await line(page).evaluate(node => ({ durations: node.getAnimations().map(animation => Number(animation.effect?.getTiming().duration)),
      opacity: getComputedStyle(node).opacity }));
    assert.ok(css.durations.some(value => value >= 120 && value <= 180), JSON.stringify(css));
    await begin(page, state); state.release(); await until(() => finishing(page));
    await page.clock.runFor(200); await until(async () => !await finishing(page)); await mode(page, 'idle');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await begin(page, state); state.release(); await page.clock.runFor(200); await mode(page, 'idle');
    assert.equal(await line(page).evaluate(node => node.getAnimations().length), 0);
    const after = await frame(page);
    assert.equal(after.line, before.line); assert.ok(after.line <= 3);
    assert.ok(Math.abs(after.top - before.top) <= 1); assert.ok(after.width <= after.viewport + 1);
    assert.equal(await page.locator('.task-select').first().evaluate(node => node === window.motionListRow), true);
    return () => state.release();
  });
}

for (const engine of engines) {
  record(engine, 'a replaced source cannot finish an old pending collection read', { locale: 'zh-CN', width: 390 }, async h => {
    const page = await h.open(null), state = await collection(page, h);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Let the authenticated reading cache persist, then hold the next initial
    // GET. A deliberate online sync can supersede it with the real POST route.
    await page.waitForTimeout(2250); state.hold = true; await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.task-select[data-thread-id]').first().waitFor();
    await until(() => state.calls.some(call => call.path.endsWith('/catalog') && !call.ended));
    await page.clock.install(); await page.clock.pauseAt(new Date());
    const old = state.calls.findLast(call => call.path.endsWith('/catalog') && !call.ended);
    await line(page).evaluate(node => {
      window.motionCompletions = [];
      new MutationObserver(() => { if (node.hasAttribute('data-finishing')) window.motionCompletions.push(Date.now()); })
        .observe(node, { attributes: true, attributeFilter: ['data-finishing'] });
    });
    state.scope = 'replacement-scope'; state.catalog = 'cached-fallback'; state.runtime = 'native-unavailable';
    const previous = state.calls.length; await refresh(page);
    await until(() => state.calls.slice(previous).some(call => call.path.endsWith('/sync') && !call.ended));
    const replacement = state.calls.findLast(call => call.path.endsWith('/sync') && !call.ended);
    assert.notEqual(replacement, old); state.hold = false; replacement.gate.resolve();
    await until(() => replacement.ended); await mode(page, 'waiting');
    old.gate.resolve(); await until(() => old.ended);
    await page.clock.runFor(220);
    assert.equal(await finishing(page), false);
    assert.deepEqual(await page.evaluate(() => window.motionCompletions), [], 'A stale successful reply cannot complete the replaced source');
    await mode(page, 'waiting'); return () => state.release();
  });
}

for (const engine of engines) for (const [locale, width] of [['zh-CN', 390], ['en-US', 320]]) {
  record(engine, `${locale}: composer motion belongs only to its tools and preserves editing and picker cancellation`, { locale, width, history: true }, async h => {
    const page = await h.open(); await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.waitForTimeout(350);
    const input = page.locator('.composer-input textarea'), tools = page.locator('.composer-actions'), messages = page.locator('.conversation-messages');
    await input.evaluate(node => { window.motionTextarea = node; });
    await input.click(); await page.locator('[data-composer-state="expanded"]').waitFor();
    const motion = await tools.evaluate(node => {
      const animations = node.getAnimations();
      return { count: animations.length, durations: animations.map(animation => Number(animation.effect?.getTiming().duration)),
        frames: animations.flatMap(animation => animation.effect?.getKeyframes?.() ?? []).map(frame => ({ opacity: frame.opacity, transform: frame.transform,
          properties: Object.keys(frame).filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key)) })) };
    });
    assert.ok(motion.count > 0); assert.deepEqual(motion.durations, [120]);
    assert.ok(motion.frames.some(frame => typeof frame.transform === 'string' && /translateY\([234](?:\.0+)?px\)/.test(frame.transform)), JSON.stringify(motion));
    assert.ok(motion.frames.every(frame => frame.properties.every(key => ['opacity', 'transform'].includes(key))));
    const layoutMotion = await page.locator('.composer-input textarea,.conversation-composer,.conversation-messages,.inspector').evaluateAll(nodes => nodes.map(node => ({
      tag: node.tagName, className: node.className, animation: getComputedStyle(node).animationName,
      transitions: getComputedStyle(node).transitionProperty, transitionDuration: getComputedStyle(node).transitionDuration,
      transform: getComputedStyle(node).transform, animations: node.getAnimations().map(animation => animation.effect?.getKeyframes?.() ?? []),
    })));
    for (const node of layoutMotion) {
      assert.equal(node.animation, 'none', JSON.stringify(node));
      if (node.transitionDuration.split(',').some(value => Number.parseFloat(value) > 0))
        assert.doesNotMatch(node.transitions, /(^|,)\s*(?:height|min-height|max-height|top|bottom|transform|all)\s*(,|$)/, JSON.stringify(node));
      assert.equal(node.animations.length, 0, JSON.stringify(node));
      assert.equal(node.transform, 'none', JSON.stringify(node));
    }
    await input.fill('New ordinary input remains stable. 中文输入。');
    await input.evaluate(node => { node.setSelectionRange(4, 9); node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })); });
    const before = await input.evaluate(node => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd }));
    await refresh(page); await page.waitForTimeout(180);
    assert.deepEqual(await input.evaluate(node => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd })), before);
    assert.equal(await input.evaluate(node => node === window.motionTextarea && document.activeElement === node), true);
    await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })));
    const chooser = page.waitForEvent('filechooser'); await page.locator('.attachment-picker').click(); await chooser;
    await page.locator('[data-attachment-input]').evaluate(node => node.dispatchEvent(new Event('cancel')));
    await input.click(); await input.evaluate(node => node.setSelectionRange(node.value.length, node.value.length));
    await input.pressSequentially(' Still editable.');
    assert.ok((await input.inputValue()).endsWith(' Still editable.'));
    assert.equal(await input.evaluate(node => node === window.motionTextarea), true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: locale === 'en-US' ? 'Collapse composer' : '收起输入', exact: true }).click();
    await page.locator('[data-composer-state="compact"]').waitFor(); await input.click(); await page.locator('[data-composer-state="expanded"]').waitFor();
    assert.equal(await tools.evaluate(node => node.getAnimations().length), 0);
    assert.equal(await input.evaluate(node => node === window.motionTextarea), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.equal(await messages.evaluate(node => getComputedStyle(node).animationName), 'none');
  });
}

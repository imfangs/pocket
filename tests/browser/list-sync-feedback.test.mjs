import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_LIST_SYNC_REPORT || '.local/qa/browser-list-sync/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const row = (page, id = ids.regular) => page.locator(`.task-select[data-thread-id="${id}"]`);
const order = page => page.locator('.task-select[data-thread-id]').evaluateAll(nodes => nodes.map(node => node.dataset.threadId));
const counts = async page => ({ unread: await page.locator('.unread-toggle small').textContent(), running: await page.locator('.running-toggle small').textContent() });
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Synthetic collection observation did not arrive');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
async function connection(page, online) {
  await page.evaluate(value => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  }, online);
}

// Test-local adapter; every other request still goes through the fixture's
// deny-by-default routes. No live Mac, source contents or native owner exists.
async function directory(page, h) {
  const state = { status: 'running', mode: 'fresh', catalogFailure: false, hold: null, timestamp: null, calls: [] };
  let tick = Date.now();
  const threads = [ids.regular, ids.empty].map(id => ({ ...h.metadata(id), pocketPriority: false, codexPinned: false,
    pinned: false, hasUnreadTurn: true, needsInput: true }));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data, status = 200;
    if (path.endsWith('/catalog') || path.endsWith('/sync')) {
      if (state.catalogFailure) { status = 503; data = { error: 'Synthetic collection connection failed' }; }
      else data = { threads, groups: [], projects: [{ id: 'fixture', name: '合成项目', paths: ['/synthetic'], order: 0, separator: false }],
        sourceInfo: { syncedAt: ++tick, active: threads.length, archived: 0, total: threads.length,
          scope: 'synthetic', pocketRead: { available: true, scope: 'smoke-ged' } }, sourceError: null, csrfToken: 'synthetic-token' };
    } else if (path.endsWith('/task-statuses')) {
      const checkedAt = tick = Math.max(tick + 1, state.timestamp ?? Date.now());
      data = state.mode === 'native-unavailable' ? { available: false, checkedAt, states: [] }
        : state.mode === 'http-failure' ? { error: 'Synthetic weak connection' }
        : { available: true, checkedAt, states: [{ threadId: ids.regular, status: state.status, checkedAt },
          { threadId: ids.empty, status: 'idle', checkedAt }] };
      if (state.mode === 'http-failure') status = 503;
    } else return route.fallback();
    const call = { path, method: request.method(), status, mode: state.mode, finished: false };
    state.calls.push(call);
    try {
      if (path.endsWith('/task-statuses')) {
        const hold = state.hold; state.hold = null;
        if (hold) await hold;
      }
      await route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: JSON.stringify(data) });
    } catch { /* Closing or superseding a read aborts only this synthetic wait. */ }
    finally { call.finished = true; }
  });
  await refresh(page);
  await row(page).locator('[data-state="running"]').waitFor();
  return state;
}
async function observe(page, state, mode) {
  state.mode = mode;
  const count = state.calls.length; await refresh(page);
  await until(() => state.calls.slice(count).some(call => call.path.endsWith('/task-statuses') && call.finished));
  await page.waitForTimeout(250);
}
async function snapshot(page) {
  return { order: await order(page), counts: await counts(page), top: await row(page).evaluate(node => node.getBoundingClientRect().top) };
}
const readOnly = h => assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'));
function flow(engine, name, options, run) {
  test(`${engine}: ${name}`, { timeout: 40000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine, { visibility: true, ...options }), run, record: result => results.push(result) }));
}

async function thinLine(page, mode) {
  await page.locator(`[data-collection-feedback="${mode}"]`).waitFor();
  const geometry = await page.locator('.collection-sync-line').evaluate(node => ({ height: node.getBoundingClientRect().height,
    animation: getComputedStyle(node, '::after').animationName, opacity: getComputedStyle(node).opacity }));
  assert.ok(geometry.height > 0 && geometry.height <= 3, JSON.stringify(geometry));
  return geometry;
}

for (const engine of engines) {
  flow(engine, 'native status unavailability stays thin and preserves cached list activity instead of a retry row', {}, async h => {
    const page = await h.open(null), state = await directory(page, h), before = await snapshot(page);
    await row(page).evaluate(node => { window.originalRunningRow = node; });
    await observe(page, state, 'native-unavailable');
    const line = await thinLine(page, 'waiting');
    assert.equal(line.animation, 'none', 'Native unknown is a settled waiting state, not a perpetual request');
    const after = await snapshot(page);
    assert.deepEqual(after.order, before.order); assert.deepEqual(after.counts, before.counts);
    assert.equal(await row(page).locator('[data-state="running"]').count(), 1);
    assert.ok(Math.abs(after.top - before.top) <= 3, `Unavailable native status moved the reader ${after.top - before.top}px`);
    assert.equal(await page.getByText('状态尚未同步，显示上次同步的列表状态', { exact: true }).count(), 0);
    assert.equal(await page.locator('.collection-feedback-retry').count(), 0, 'A reachable native-status wait should not ask for another retry click');
    assert.equal(await row(page).evaluate(node => node === window.originalRunningRow), true);
    readOnly(h);
  });

  flow(engine, 'an intermittent transport failure keeps the reader and recovers without flashing an error block', {}, async h => {
    const page = await h.open(null), state = await directory(page, h), before = await snapshot(page);
    await observe(page, state, 'http-failure');
    await thinLine(page, 'waiting');
    const after = await snapshot(page);
    assert.deepEqual(after.order, before.order); assert.deepEqual(after.counts, before.counts);
    assert.ok(Math.abs(after.top - before.top) <= 3, `A transient read failure moved the reader ${after.top - before.top}px`);
    assert.equal(await page.locator('.collection-feedback-retry').count(), 0, 'One failed read remains a quiet automatic-retry state');
    state.status = 'idle'; await observe(page, state, 'fresh');
    await row(page).locator('[data-state="unread"]').waitFor();
    assert.equal(await row(page).locator('[data-state="running"]').count(), 0);
    assert.equal(await page.locator('.collection-feedback').count(), 0);
    readOnly(h);
  });

  flow(engine, 'explicit offline has one compact readable recovery notice while cached running stays unchanged', {}, async h => {
    const page = await h.open(null), state = await directory(page, h), before = await snapshot(page);
    await connection(page, false);
    const notice = page.locator('.collection-feedback');
    await page.locator('[data-collection-feedback="offline"]').waitFor({ timeout: 5000 });
    assert.equal(await notice.count(), 1);
    assert.deepEqual(await order(page), before.order); assert.deepEqual(await counts(page), before.counts);
    assert.equal(await row(page).locator('[data-state="running"]').count(), 1);
    const geometry = await notice.evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth,
      retry: node.querySelector('button')?.getBoundingClientRect().height, text: node.textContent }));
    assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry));
    assert.ok(geometry.retry >= 44, JSON.stringify(geometry));
    assert.ok(geometry.text.length < 70, 'The offline recovery message remains concise');
    assert.equal(await notice.locator('.collection-feedback-retry').isEnabled(), true, 'Offline still permits a deliberate read-only recheck');
    state.status = 'idle'; await connection(page, true);
    await row(page).locator('[data-state="unread"]').waitFor();
    await notice.waitFor({ state: 'detached' }); await thinLine(page, 'idle');
    readOnly(h);
  });

  flow(engine, 'request activity uses the same thin line and reduced motion remains readable in English', { width: 320, locale: 'en-US' }, async h => {
    const page = await h.open(null), state = await directory(page, h), before = await snapshot(page);
    let release; state.hold = new Promise(resolve => { release = resolve; });
    const count = state.calls.length; await refresh(page);
    await until(() => state.calls.slice(count).some(call => call.path.endsWith('/task-statuses') && !call.finished));
    const moving = await thinLine(page, 'syncing');
    assert.notEqual(moving.animation, 'none', 'Only an actual pending read animates the loading signal');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const line = await thinLine(page, 'syncing');
    assert.equal(line.animation, 'none', 'The loading signal respects reduced-motion');
    assert.ok(Math.abs((await snapshot(page)).top - before.top) <= 3);
    release(); await until(() => state.calls.slice(count).some(call => call.path.endsWith('/task-statuses') && call.finished));
    await thinLine(page, 'idle');
    await connection(page, false); await page.locator('[data-collection-feedback="offline"]').waitFor();
    const notice = page.locator('.collection-feedback');
    assert.match(await notice.textContent(), /offline/i);
    const width = await notice.evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth }));
    assert.ok(width.scroll <= width.width + 1, JSON.stringify(width));
    assert.deepEqual(await counts(page), before.counts); readOnly(h);
  });

  flow(engine, 'only sustained transport failure without a reachable collection route becomes an actionable warning', {}, async h => {
    const page = await h.open(null), state = await directory(page, h), before = await snapshot(page);
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    state.mode = 'http-failure'; state.catalogFailure = true;
    const readBoth = async (event = 'online') => {
      const count = state.calls.length;
      await page.evaluate(type => window.dispatchEvent(new Event(type)), event);
      await until(() => ['task-statuses', 'sync'].every(route => state.calls.slice(count).some(call => call.path.endsWith('/' + route) && call.finished)));
    };
    // Real foreground recovery resets its monotonic grace window. The clock
    // accelerates production timers without replacing health/feed callbacks.
    await readBoth('pageshow'); await page.clock.runFor(1000);
    await readBoth(); await page.clock.runFor(1000); await readBoth();
    await thinLine(page, 'waiting');
    assert.equal(await page.locator('.collection-feedback').count(), 0, 'Three failures alone cannot bypass elapsed grace');
    await page.clock.runFor(27999);
    assert.equal(await page.locator('[data-collection-feedback="unreachable"]').count(), 0);
    await page.clock.runFor(1);
    await page.locator('[data-collection-feedback="unreachable"]').waitFor();
    assert.equal(await page.locator('.collection-feedback').count(), 1);
    assert.equal(await page.locator('.collection-feedback-retry').isEnabled(), true);
    assert.deepEqual(await order(page), before.order); assert.deepEqual(await counts(page), before.counts);
    state.mode = 'fresh'; state.catalogFailure = false; state.status = 'idle'; state.timestamp = await page.evaluate(() => Date.now());
    await page.locator('.collection-feedback-retry').click();
    await thinLine(page, 'idle');
    assert.equal(await page.locator('.collection-feedback').count(), 0);
    readOnly(h);
  });

  flow(engine, 'a reachable catalog prevents status-only transport failures from claiming the Mac is disconnected', {}, async h => {
    const page = await h.open(null), state = await directory(page, h), before = await snapshot(page);
    await page.clock.install(); await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000)); state.mode = 'http-failure';
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await until(() => state.calls.at(-1)?.finished);
    for (let i = 0; i < 3; i++) {
      await observe(page, state, 'http-failure'); await page.clock.runFor(11000);
      await until(() => state.calls.at(-1)?.finished);
    }
    await thinLine(page, 'waiting');
    assert.equal(await page.locator('.collection-feedback').count(), 0);
    assert.equal(await page.locator('.collection-feedback-retry').count(), 0);
    assert.deepEqual(await order(page), before.order); assert.deepEqual(await counts(page), before.counts);
    readOnly(h);
  });
}

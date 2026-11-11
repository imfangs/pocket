import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_LIST_ACTIVITY_REPORT || '.local/qa/list-activity-cache-2026-11-10/browser.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const row = (page, id) => page.locator(`.task-select[data-thread-id="${id}"]`);
const order = page => page.locator('.task-select[data-thread-id]').evaluateAll(nodes => nodes.map(node => node.dataset.threadId));
const counts = async page => ({ unread: await page.locator('.unread-toggle small').textContent(), running: await page.locator('.running-toggle small').textContent() });
const until = async predicate => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Expected synthetic request did not arrive');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
};
async function online(page, value) {
  await page.evaluate(value => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  }, value);
}
async function directory(page, h) {
  const control = { scope: 'smoke-ged', status: 'running', failed: false, omitted: false, rowAt: null, hold: null, calls: [] };
  let catalogTick = Date.now(), statusTick = catalogTick;
  const threads = [ids.regular, ids.empty].map(id => ({ ...h.metadata(id), pocketPriority: false, codexPinned: false, pinned: false,
    pocketUnread: true, hasUnreadTurn: true, needsInput: true }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let data, status = 200;
    if (path.endsWith('/catalog') || path.endsWith('/sync')) data = { threads: threads.map(thread => ({ ...thread,
      pocketContent: { ...thread.pocketContent, scope: control.scope } })), groups: [],
      projects: [{ id: 'fixture', name: '合成项目', paths: ['/synthetic'], order: 0, separator: false }],
      sourceInfo: { syncedAt: ++catalogTick, active: 2, archived: 0, total: 2, scope: 'synthetic',
        pocketRead: { available: true, scope: control.scope } }, sourceError: null, csrfToken: 'synthetic-token' };
    else if (path.endsWith('/task-statuses')) {
      const checkedAt = statusTick = Math.max(statusTick + 1, Date.now());
      data = control.failed ? { error: 'synthetic weak network' } : { available: true, checkedAt,
        states: control.omitted ? [] : [{ threadId: ids.regular, status: control.status, checkedAt: control.rowAt ?? checkedAt },
          { threadId: ids.empty, status: 'idle', checkedAt }] };
      if (control.failed) status = 503;
      const hold = control.hold; control.hold = null;
      control.calls.push({ path, status, checkedAt, data });
      if (hold) await hold;
    } else return route.fallback();
    try { await route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: JSON.stringify(data) }); }
    catch { /* An identity switch intentionally aborts the previous read. */ }
  });
  await refresh(page);
  await row(page, ids.regular).locator('[data-state="running"]').waitFor();
  await page.waitForFunction(() => document.querySelector('.unread-toggle small')?.textContent === '1');
  return control;
}
function flow(engine, name, options, run) {
  test(`${engine}: ${name}`, { timeout: 40000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine, options), run, record: result => results.push(result) }));
}
const readOnly = h => assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path.endsWith('/sync')));

for (const engine of engines) {
  flow(engine, 'weak list status keeps order, filters and counts with thin sync feedback until a fresh idle', { visibility: true }, async h => {
    const page = await h.open(null), control = await directory(page, h), before = await order(page), initialCounts = await counts(page);
    await row(page, ids.regular).evaluate(node => { window.cachedRunningRow = node; });
    assert.deepEqual(initialCounts, { unread: '1', running: '1' });
    await online(page, false);
    await page.locator('[data-collection-feedback="offline"]').waitFor();
    assert.deepEqual(await order(page), before);
    assert.deepEqual(await counts(page), initialCounts);
    assert.equal(await page.locator('.collection-feedback').count(), 1);
    assert.equal(await row(page, ids.regular).locator('[data-state="unread"]').count(), 0);
    await page.locator('.running-toggle').click();
    assert.deepEqual(await order(page), [ids.regular]);
    assert.equal(await page.locator('.workspace-count').textContent(), '1');
    await page.locator('.running-toggle').click();
    assert.deepEqual(await order(page), before);
    control.failed = true; await online(page, true);
    const attempts = control.calls.length;
    await until(() => control.calls.some(call => call.status === 503));
    assert.deepEqual(await counts(page), initialCounts);
    assert.deepEqual(await order(page), before);
    await refresh(page);
    await until(() => control.calls.length > attempts);
    assert.deepEqual(await order(page), before);
    assert.equal(await page.evaluate(id => window.cachedRunningRow === document.querySelector(`.task-select[data-thread-id="${id}"]`), ids.regular), true);
    control.failed = false; control.status = 'unknown'; await refresh(page);
    await until(() => control.calls.at(-1)?.data.states?.[0]?.status === 'unknown');
    await page.waitForTimeout(60);
    assert.deepEqual(await counts(page), initialCounts);
    assert.deepEqual(await order(page), before);
    control.status = 'idle'; await refresh(page);
    await row(page, ids.regular).locator('[data-state="unread"]').waitFor();
    assert.equal(await row(page, ids.regular).locator('[data-state="running"]').count(), 0);
    assert.deepEqual(await counts(page), { unread: '2', running: '0' });
    assert.notDeepEqual(await order(page), before);
    await page.locator('[data-collection-feedback="idle"]').waitFor();
    assert.equal(await page.locator('.collection-feedback').count(), 0);
    readOnly(h);
  });

  flow(engine, 'confirmed waiting and per-thread unknown preserve the same list activity in English', { visibility: true, locale: 'en-US', width: 320 }, async h => {
    const page = await h.open(null), control = await directory(page, h);
    control.status = 'waiting_approval'; await refresh(page);
    await row(page, ids.regular).locator('[data-state="waiting_approval"]').waitFor();
    const before = await order(page), initialCounts = await counts(page);
    control.status = 'unknown'; await refresh(page);
    await page.locator('[data-collection-feedback="waiting"]').waitFor();
    await row(page, ids.regular).locator('[data-state="waiting_approval"]').waitFor();
    assert.deepEqual(await counts(page), initialCounts);
    assert.deepEqual(await order(page), before);
    const line = await page.locator('.collection-sync-line').evaluate(node => node.getBoundingClientRect().height);
    assert.ok(line <= 3, `Native partial state feedback occupied ${line}px`);
    assert.equal(await page.locator('.collection-feedback').count(), 0);
    await online(page, false);
    await page.locator('[data-collection-feedback="offline"]').waitFor();
    await row(page, ids.regular).locator('[data-state="waiting_approval"]').waitFor();
    assert.deepEqual(await order(page), before);
    assert.equal(await page.locator('.collection-feedback').count(), 1);
    const geometry = await page.locator('.collection-feedback').evaluate(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth,
      retry: node.querySelector('button').getBoundingClientRect().height }));
    assert.ok(geometry.scroll <= geometry.width + 1, JSON.stringify(geometry)); assert.ok(geometry.retry >= 44);
    readOnly(h);
  });

  flow(engine, 'new reading scope ignores both remembered running and a late old-scope response', { visibility: true }, async h => {
    const page = await h.open(null), control = await directory(page, h);
    let release; control.hold = new Promise(resolve => { release = resolve; });
    const attempts = control.calls.length; await refresh(page);
    await until(() => control.calls.length > attempts);
    control.scope = 'new-source'; control.status = 'unknown';
    await refresh(page);
    await row(page, ids.regular).locator('[data-state="unknown"]').waitFor();
    assert.equal(await row(page, ids.regular).locator('[data-state="running"]').count(), 0);
    release(); await page.waitForTimeout(80);
    assert.equal(await row(page, ids.regular).locator('[data-state="running"]').count(), 0);
    assert.deepEqual(await counts(page), { unread: '2', running: '0' });
    await online(page, false);
    assert.equal(await row(page, ids.regular).locator('[data-state="running"]').count(), 0);
    readOnly(h);
  });

  flow(engine, 'fresh same-turn terminal detail clears cached list running without reviving offline dots', { visibility: true }, async h => {
    const page = await h.open(null), control = await directory(page, h);
    const originalRunningAt = control.calls.at(-1).checkedAt;
    h.setRuntime(ids.regular, 'running');
    await row(page, ids.regular).click(); await page.locator('.conversation-working').waitFor();
    await online(page, false);
    await page.locator('.conversation-working').waitFor({ state: 'detached' });
    control.failed = true;
    h.patchHistory(ids.regular, { stopRequest: { requestId: 'confirmed-stop', targetTurnId: 'initial', status: 'stopped' } });
    await online(page, true);
    await page.locator('.conversation-working').waitFor({ state: 'detached' });
    await until(() => h.calls.some(call => call.action === 'history' && call.startedAt > originalRunningAt && call.finishedAt));
    await page.waitForTimeout(100);
    await page.locator('[data-inspector-close]').click();
    await row(page, ids.regular).waitFor();
    assert.equal(await row(page, ids.regular).locator('[data-state="running"]').count(), 0);
    control.failed = false; control.rowAt = originalRunningAt; control.status = 'running'; await refresh(page);
    await until(() => control.calls.at(-1)?.status === 200); await page.waitForTimeout(60);
    assert.equal(await row(page, ids.regular).locator('[data-state="running"]').count(), 0, 'old per-thread running cannot undo the accepted terminal history');
    readOnly(h);
  });
}

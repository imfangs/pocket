import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
const results = [];
after(() => {
  const path = resolve(process.env.POCKET_CACHE_ADOPTION_REPORT || '.local/qa/failed-turn-2026-11-11/cache-adoption-browser.json');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const now = Date.now();
const content = (revision, version) => ({ known: true, scope: 'smoke-ged', revision, version: version.repeat(64), messageId: `reply-${revision}` });
const body = (revision, checkedAt = now) => ({ source: 'rollout', checkedAt, messages: [
  { id: `query-${revision}`, role: 'user', turnId: `turn-${revision}`, text: `Synthetic query ${revision}` },
  { id: `reply-${revision}`, role: 'assistant', turnId: `turn-${revision}`, phase: 'final_answer', text: revision === 2 ? 'Old remembered answer' : 'Latest prefetched answer' },
], pocketContent: content(revision, revision === 2 ? 'a' : 'b'), hasMore: false });
const old = body(2);
function launchAdapter(engine, state) {
  return async options => {
    const browser = await ({ chromium, webkit })[engine].launch(options), original = browser.newContext.bind(browser);
    browser.newContext = async settings => {
      const context = await original(settings), register = context.route.bind(context);
      context.route = (pattern, handle) => register(pattern, async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/catalog' || path === '/api/sync') {
          const h = state.harness;
          const thread = { ...h.metadata(ids.regular), pocketContent: content(state.fresh ? 3 : 2, state.fresh ? 'b' : 'a'), hasUnreadTurn: state.fresh, needsInput: state.fresh };
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store', 'X-Pocket-Machine': 'ged' },
            body: JSON.stringify({ threads: [thread, h.metadata(ids.empty)], groups: [], projects: [{ id: 'fixture', name: '合成项目', paths: ['/synthetic'], order: 0, separator: false }],
              sourceInfo: { syncedAt: Date.now(), active: 2, total: 2, scope: 'synthetic', pocketRead: { available: true, scope: 'smoke-ged' } }, sourceError: null, csrfToken: 'synthetic-token' }) });
        }
        if (path === `/api/tasks/${ids.regular}/transcript`) {
          if (state.hold) await state.held;
          const data = state.fresh ? body(3, now + 5000) : old;
          await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: JSON.stringify(data) });
          if (state.fresh) state.prefetched++;
          return;
        }
        return handle(route);
      });
      return context;
    };
    return browser;
  };
}
const seen = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pocket.read.v1.'))
  .map(key => JSON.parse(localStorage.getItem(key))).find(entry => entry.latest?.messageId === 'reply-3')?.seen?.revision);
async function warm(page, state) {
  state.fresh = true; await refresh(page);
  const end = Date.now() + 8000;
  while (!state.prefetched) { if (Date.now() > end) throw new Error('No real background prefetch arrived'); await new Promise(resolve => setTimeout(resolve, 20)); }
  // The real reader has returned the response into bounded L1 before the
  // debounce publishes it to IDB. The reopening still uses the same App/cache.
  await page.waitForTimeout(100);
  const cacheEnd = Date.now() + 5000;
  while (!await page.evaluate(threadId => new Promise(resolve => {
    const request = indexedDB.open('pocket-reading-cache-v1');
    request.onerror = () => resolve(false);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('entries')) { db.close(); resolve(false); return; }
      const tx = db.transaction('entries', 'readonly'), get = tx.objectStore('entries').getAll();
      get.onsuccess = () => { const found = get.result.find(record => record.kind === 'transcript' && record.threadId === threadId);
        state = found ? JSON.parse(found.json).pocketContent?.revision === 3 : false; };
      let state = false;
      tx.oncomplete = () => { db.close(); resolve(state); }; tx.onerror = tx.onabort = () => { db.close(); resolve(false); };
    };
  }), ids.regular)) {
    if (Date.now() > cacheEnd) throw new Error('Prefetch response did not warm the real reading cache version 3');
    await page.waitForTimeout(50);
  }
}
for (const engine of engines) for (const selectOld of [false, true]) test(`${engine}: ${selectOld ? 'user selection wins over' : 'opening adopts'} a newer prefetched version while old memory and both live reads remain`, { timeout: 30000 }, async () => {
  const state = { fresh: false, hold: false, prefetched: 0, harness: null, release: null };
  state.held = new Promise(resolve => { state.release = resolve; });
  await runScenario({ engine, name: selectOld ? 'user selection wins over a newer prefetched version' : 'opening adopts a newer prefetched version',
    create: async () => {
      const h = await createHarness(engine, { launch: launchAdapter(engine, state) }); state.harness = h;
      h.patchHistory(ids.regular, { ...old, source: 'desktop', resumeState: 'resumed', runtime: 'idle', canSend: false, canStop: false,
        latestTurnId: 'turn-2', latestTurnStatus: 'completed', activeTurnId: null, pendingRequests: [], turnTiming: { turnId: 'turn-2', status: 'completed', startedAt: now - 1000, observedAt: now, durationMs: 1000 } });
      return h;
    }, record: result => results.push(result), run: async h => {
      try {
        const page = await h.open(); await page.getByText('Old remembered answer', { exact: true }).waitFor();
        await page.locator('[data-inspector-close]').click(); await page.locator('.inspector').waitFor({ state: 'detached' });
        await warm(page, state);
        assert.notEqual(await seen(page), 3, 'Background prefetch never marks a version seen');
        const gate = h.pause('history', { repeat: true }); state.hold = true;
        if (selectOld) await page.evaluate(() => {
          const observer = new MutationObserver(() => {
            const root = document.querySelector('.conversation-messages');
            const text = [...(root?.querySelectorAll('p') ?? [])].find(node => node.textContent === 'Old remembered answer');
            if (!text) return;
            const range = document.createRange(); range.selectNodeContents(text); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
            window.cacheSelectionChosen = true; observer.disconnect();
          });
          observer.observe(document.querySelector('#root'), { subtree: true, childList: true });
        });
        await page.locator(`[data-thread-id="${ids.regular}"]`).click();
        if (selectOld) {
          await page.waitForFunction(() => window.cacheSelectionChosen); await page.waitForTimeout(250);
          assert.equal(await page.getByText('Latest prefetched answer', { exact: true }).count(), 0);
          assert.equal(await page.evaluate(() => getSelection().toString()), 'Old remembered answer');
        } else {
          await page.getByText('Latest prefetched answer', { exact: true }).waitFor({ timeout: 2500 });
          assert.equal(await page.getByText('Old remembered answer', { exact: true }).count(), 0);
          await page.waitForFunction(() => Object.keys(localStorage).filter(key => key.startsWith('pocket.read.v1.'))
            .some(key => JSON.parse(localStorage.getItem(key)).seen?.messageId === 'reply-3'), undefined, { timeout: 2500 });
          assert.equal(await seen(page), 3, 'Only the exact visible cache version becomes locally read after its entry motion settles');
        }
        assert.equal(await page.locator('.conversation-working, .stop-execution').count(), 0, 'Cached preview supplies no native control or running animation');
        assert.equal(h.calls.some(call => call.action === 'messages' && call.method === 'POST' || call.action.startsWith('stop')), false);
        gate.release();
      } finally { state.release(); }
    } });
});

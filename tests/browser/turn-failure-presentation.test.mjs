import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
const results = [];
after(() => {
  const path = resolve(process.env.POCKET_FAILURE_REPORT || '.local/qa/failed-turn-2026-11-11/browser.json'); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const busy = 'We’re currently experiencing high demand, which may cause temporary errors.';
const messages = [
  { id: 'failed-query', role: 'user', turnId: 'failed-turn', text: 'A synthetic query that previously failed.' },
  { id: 'failed-progress', role: 'assistant', turnId: 'failed-turn', phase: 'commentary', text: 'Synthetic process before failure.' },
];
const failure = { turnId: 'failed-turn', message: busy, code: 'internal_server_error', additionalDetails: '<script>not executed</script>' };
function history(rows, latestTurnId = 'failed-turn', status = 'failed') {
  return { source: 'desktop', resumeState: 'resumed', runtime: status === 'inProgress' ? 'active' : 'idle', canSend: true,
    checkedAt: Date.now(), messages: rows, latestTurnId, latestTurnStatus: status, activeTurnId: status === 'inProgress' ? latestTurnId : null,
    pendingRequests: [], turnFailures: [failure], turnTiming: { turnId: latestTurnId, status, startedAt: Date.now() - 1000, observedAt: Date.now(), durationMs: status === 'failed' ? 1000 : null } };
}
function adapter(engine, state) {
  return async options => {
    const browser = await ({ chromium, webkit })[engine].launch(options), original = browser.newContext.bind(browser);
    browser.newContext = async settings => {
      const context = await original(settings), register = context.route.bind(context);
      context.route = (pattern, handle) => register(pattern, async route => {
        if (new URL(route.request().url()).pathname.endsWith('/task-statuses')) {
          state.reads++;
          return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store', 'X-Pocket-Machine': 'ged' },
            body: JSON.stringify({ available: true, checkedAt: Date.now(), states: [{ threadId: ids.regular, status: state.status, checkedAt: Date.now(), latestTurnId: state.turnId, statusSource: 'desktop' }] }) });
        }
        return handle(route);
      });
      return context;
    };
    return browser;
  };
}
for (const engine of engines) for (const running of [false, true]) {
  const name = running ? 'a new running turn keeps its live status while the previous failed reason stays at its boundary'
    : 'latest failed turn has a list badge and readable exact diagnostic without a resend action';
  test(`${engine}: ${name}`, { timeout: 30000 }, async () => {
    const state = { status: running ? 'running' : 'failed', turnId: running ? 'new-turn' : 'failed-turn', reads: 0 };
    await runScenario({ engine, name, create: () => createHarness(engine, { launch: adapter(engine, state) }), record: result => results.push(result), run: async h => {
      const rows = running ? [...messages, { id: 'new-query', role: 'user', turnId: 'new-turn', text: 'A new synthetic attempt.' },
        { id: 'new-progress', role: 'assistant', turnId: 'new-turn', phase: 'commentary', text: 'Synthetic new running process.' }] : messages;
      h.patchHistory(ids.regular, history(rows, state.turnId, running ? 'inProgress' : 'failed'));
      h.patchTranscript(ids.regular, { source: 'rollout', checkedAt: Date.now(), messages: rows, turnFailures: [failure],
        turnTiming: { turnId: state.turnId, status: running ? 'inProgress' : 'failed', startedAt: Date.now() - 1000, observedAt: Date.now(), durationMs: running ? null : 1000 } });
      const page = await h.open(null), row = page.locator(`[data-thread-id="${ids.regular}"]`);
      await row.locator(`[data-state="${state.status}"]`).waitFor({ timeout: 2500 });
      assert.equal(await row.locator('[data-state="failed"]').count(), running ? 0 : 1);
      await row.click();
      const card = page.locator('[data-turn-failure-id="failed-turn"]'); await card.waitFor({ timeout: 2500 });
      assert.match(await card.textContent(), /服务繁忙，本轮未能完成/);
      assert.equal(await card.locator('[data-message-id]').count(), 0, 'Failure is metadata, never a fake source message');
      await card.getByRole('button', { name: '查看错误详情' }).click();
      assert.match(await card.locator('pre').textContent(), /We’re currently experiencing high demand/);
      assert.match(await card.locator('pre').textContent(), /internal_server_error/);
      assert.equal(await card.locator('script').count(), 0);
      assert.match(await card.locator('pre').textContent(), /<script>not executed<\/script>/);
      assert.equal(await page.locator('.conversation-working').count(), running ? 1 : 0);
      const chronology = await page.locator('.conversation-live').evaluate(root => [...root.children].map(node => node.dataset.messageId || node.dataset.turnFailureId).filter(Boolean));
      assert.ok(chronology.indexOf('failed-progress') < chronology.indexOf('failed-turn'));
      if (running) assert.ok(chronology.indexOf('failed-turn') < chronology.indexOf('new-query'));
      await refresh(page); await page.waitForTimeout(200);
      assert.equal(await card.count(), 1, 'Repeated reads cannot duplicate the diagnostic');
      assert.equal(h.calls.some(call => call.action === 'messages' && call.method === 'POST' || call.action === 'open' || call.action === 'stop'), false);
    } });
  });
}

for (const engine of engines) test(`${engine}: a failed latest turn without messages replaces the contradictory empty view`, { timeout: 30000 }, async () => {
  const state = { status: 'failed', turnId: 'failed-turn', reads: 0 };
  await runScenario({ engine, name: 'a failed latest turn without messages replaces the contradictory empty view',
    create: () => createHarness(engine, { launch: adapter(engine, state) }), record: result => results.push(result), run: async h => {
      h.patchHistory(ids.regular, history([]));
      h.patchTranscript(ids.regular, { source: 'rollout', messages: [], checkedAt: Date.now(), turnFailures: [failure], turnTiming: { turnId: 'failed-turn', status: 'failed', startedAt: 10 } });
      const page = await h.open(); await page.locator('[data-turn-failure-id="failed-turn"]').waitFor({ timeout: 2500 });
      assert.equal(await page.getByText('从一句话开始', { exact: true }).count(), 0);
      assert.equal(await page.locator('.conversation-read-loading').count(), 0);
      assert.equal(await page.locator('[data-message-id]').count(), 0, 'No fake source message is needed to leave the empty view');
      assert.equal(await page.locator('.conversation-composer').getAttribute('data-composer-state'), 'compact');
      assert.equal(h.calls.some(call => call.action === 'messages' && call.method === 'POST'), false);
    } });
});

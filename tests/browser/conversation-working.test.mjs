import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_WORKING_REPORT || '.local/qa/browser-working/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const until = async predicate => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Synthetic request did not arrive');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const dots = page => page.locator('.conversation-working');
const shown = async page => { await dots(page).waitFor(); assert.equal(await dots(page).locator('.conversation-working-dot').count(), 3); };
const hidden = async page => { await dots(page).waitFor({ state: 'detached' }); };
function flow(engine, name, options, run) {
  test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine, options), run, record: result => results.push(result) }));
}

for (const engine of engines) {
  flow(engine, 'working dots use fresh native work and preserve one sent query row', {}, async h => {
    const gate = h.pause('history');
    h.setRuntime(ids.regular, 'running');
    const page = await h.open();
    await page.getByText('已有的合成回复', { exact: true }).waitFor();
    assert.equal(await dots(page).count(), 0, 'A transcript/cache cannot start the activity indicator');
    gate.release(); await shown(page);
    assert.equal(await dots(page).getAttribute('data-turn-id'), 'initial');
    assert.equal(await dots(page).getAttribute('aria-live'), 'polite');
    assert.equal(await dots(page).locator('.sr-only').textContent(), '正在运行');
    const animated = await dots(page).locator('.conversation-working-dot').evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node); return { name: style.animationName, duration: style.animationDuration, delay: style.animationDelay };
    }));
    assert.ok(animated.every(dot => dot.name === 'conversation-work-dot' && dot.duration === '1.2s'));
    assert.deepEqual(animated.map(dot => dot.delay), ['0s', '0.12s', '0.24s']);
    h.setRuntime(ids.regular, 'idle'); await refresh(page); await hidden(page);
    const input = page.locator('.conversation-composer textarea');
    await input.fill('三点状态的合成问题');
    await input.evaluate(node => { window.workingInputNode = node; });
    await page.locator('.conversation-composer button[type="submit"]').click();
    await until(() => h.calls.some(call => call.action === 'messages' && call.method === 'POST'));
    const requestId = h.calls.find(call => call.action === 'messages' && call.method === 'POST').requestId;
    await page.locator(`article[data-query-id="${requestId}"]`).waitFor();
    const row = await page.getByText('三点状态的合成问题', { exact: true }).evaluate(node => {
      window.workingQueryNode = node.closest('[data-message-id]'); return window.workingQueryNode.dataset.messageId;
    });
    assert.ok(row); assert.equal(await dots(page).count(), 0, 'Only posting/queuing does not claim remote work');
    h.accept(ids.regular, requestId); await refresh(page);
    await page.waitForFunction(id => document.querySelector(`article[data-query-id="${id}"]`)?.getAttribute('data-query-state') === 'accepted', requestId);
    assert.equal(await dots(page).count(), 0, 'Acceptance alone is not running');
    h.echo(ids.regular, requestId); h.setRuntime(ids.regular, 'running'); await refresh(page); await shown(page);
    assert.equal(await dots(page).getAttribute('data-turn-id'), 'sent');
    assert.equal(await page.evaluate(() => window.workingInputNode === document.querySelector('.conversation-composer textarea')), true);
    assert.equal(await page.evaluate(() => document.activeElement === window.workingInputNode), true);
    assert.equal(await page.evaluate(() => window.workingQueryNode === document.querySelector('[data-message-id="' + window.workingQueryNode.dataset.messageId + '"]')), true);
    assert.equal(await page.getByText('三点状态的合成问题', { exact: true }).count(), 1);
    assert.equal(await dots(page).evaluate(node => !!node.previousElementSibling), true);
    const bottom = await page.locator('.conversation-messages').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
    assert.ok(bottom <= 1, String(bottom));
    h.setRuntime(ids.regular, 'idle'); await refresh(page); await hidden(page);
    assert.equal(await page.evaluate(() => document.activeElement === window.workingInputNode), true);
    assert.equal(h.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
  });

  flow(engine, 'working dots distinguish blocked work, old stop identities and failed reads', {}, async h => {
    h.setRuntime(ids.regular, 'running');
    const page = await h.open(); await shown(page);
    h.patchHistory(ids.regular, { compaction: { active: true, latestId: 'compact' } }); await refresh(page); await hidden(page);
    h.patchHistory(ids.regular, { pendingRequests: [{ key: 'approval', kind: 'unsupported', reason: '合成等待确认', details: '', choices: [], cwd: '/synthetic' }] });
    await refresh(page); await hidden(page);
    h.patchHistory(ids.regular, { canSend: false, hint: '任务正在等待审批或输入，请在 Mac 的 Codex 中处理。', pendingRequests: [] });
    await refresh(page); await hidden(page);
    h.patchHistory(ids.regular, { canSend: false, hint: '思考强度尚待核对，请打开会话信息。' });
    await refresh(page); await shown(page);
    h.patchHistory(ids.regular, { stopRequest: { requestId: 'stop', targetTurnId: 'initial', status: 'accepted' } }); await refresh(page); await hidden(page);
    h.patchHistory(ids.regular, { stopRequest: { requestId: 'stop', targetTurnId: 'previous', status: 'accepted' } }); await refresh(page); await shown(page);
    h.patchHistory(ids.regular, { source: 'rollout', runtime: 'active' }); await refresh(page); await hidden(page);
    h.patchHistory(ids.regular, {}); await refresh(page); await shown(page);
    const visibilityGate = h.pause('history');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await hidden(page);
    h.setRuntime(ids.regular, 'idle');
    const visibilityRead = h.count('history');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await until(() => h.count('history') > visibilityRead);
    assert.equal(await dots(page).count(), 0, 'Returning from background cannot revive an old active snapshot');
    visibilityGate.release(); await hidden(page);
    h.setRuntime(ids.regular, 'running'); await refresh(page); await shown(page);
    const pageShowGate = h.pause('history'), pageShowRead = h.count('history');
    h.setRuntime(ids.regular, 'idle');
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await until(() => h.count('history') > pageShowRead);
    assert.equal(await dots(page).count(), 0, 'A pageshow refresh also needs a new owner read');
    pageShowGate.release(); await hidden(page);
    h.setRuntime(ids.regular, 'running'); await refresh(page); await shown(page);
    const oldReadGate = h.pause('history'), oldRead = h.count('history');
    await refresh(page); await until(() => h.count('history') > oldRead);
    h.setRuntime(ids.regular, 'idle');
    const resumedReadGate = h.pause('history'), resumedRead = h.count('history');
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await hidden(page);
    oldReadGate.release();
    await until(() => h.count('history') > resumedRead);
    assert.equal(await dots(page).count(), 0, 'A pre-pageshow active read cannot renew the resumed-page animation');
    resumedReadGate.release(); await hidden(page);
    h.setRuntime(ids.regular, 'running'); await refresh(page); await shown(page);
    h.failNextHistory(); await refresh(page); await hidden(page);
    await refresh(page); await shown(page);
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); });
    await hidden(page);
    await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
    await shown(page);
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.locator(`[data-thread-id="${ids.empty}"]`).click();
    await page.locator('.conversation-live').waitFor(); await hidden(page);
    assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
  });

  flow(engine, 'working dots remain at the true tail without moving older reading or reduced-motion input', { history: true, locale: 'en-US' }, async h => {
    h.setRuntime(ids.regular, 'running');
    const page = await h.open(); await shown(page);
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    assert.equal(await dots(page).locator('.sr-only').textContent(), 'Running');
    const reduced = await dots(page).locator('.conversation-working-dot').evaluateAll(nodes => nodes.map(node => {
      const style = getComputedStyle(node); return { name: style.animationName, transform: style.transform, color: style.backgroundColor };
    }));
    assert.ok(reduced.every(dot => dot.name === 'none' && dot.transform === 'none'));
    assert.ok(reduced.every(dot => dot.color === reduced[0].color));
    const root = page.locator('.conversation-messages');
    await root.evaluate(node => { node.scrollTop = 260; });
    await page.waitForTimeout(80);
    const top = await root.evaluate(node => node.scrollTop);
    await page.locator('[data-message-id]').first().evaluate(node => { window.workingReadingNode = node; });
    const input = page.locator('.conversation-composer textarea'); await input.focus(); await input.fill('Keep this draft and my reading position.');
    await input.evaluate(node => { window.workingFocusedInput = node; });
    h.patchHistory(ids.regular, { compaction: { active: true, latestId: 'compact' } }); await refresh(page); await hidden(page);
    h.patchHistory(ids.regular, {}); await refresh(page); await shown(page);
    assert.ok(Math.abs(await root.evaluate(node => node.scrollTop) - top) <= 1);
    assert.equal(await page.evaluate(() => window.workingReadingNode === document.querySelector('[data-message-id]')), true);
    assert.equal(await page.evaluate(() => window.workingFocusedInput === document.activeElement), true);
    assert.equal(await input.inputValue(), 'Keep this draft and my reading position.');
    assert.equal(await dots(page).evaluate(node => node.getBoundingClientRect().top > node.closest('.conversation-messages').getBoundingClientRect().bottom), true,
      'The animation stays at the actual tail rather than floating beside old content');
    assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
  });
}

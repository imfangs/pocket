import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, pullFromTop, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
const output = resolve(process.env.POCKET_BROWSER_REPORT || '.local/qa/browser-smoke/results.json');
after(() => { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify({ scenarios: results }, null, 2) + '\n'); });
const until = async predicate => {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Synthetic request did not arrive'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const info = page => page.getByRole('dialog', { name: '会话信息', exact: true });
const infoGeometry = page => info(page).locator('.conversation-info').evaluate(element => ({ height: element.getBoundingClientRect().height,
  closeFocused: document.activeElement === element.closest('dialog').querySelector('[aria-label="关闭对话框"]') }));
const openInfo = async page => { await page.locator('.inspector-title-trigger').click(); await info(page).waitFor(); await page.waitForTimeout(240); };
const closeInfo = async page => { await page.keyboard.press('Escape'); await info(page).waitFor({ state: 'detached' }); };

function flow(engine, name, options, run) {
  test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine, options), run, record: result => results.push(result) }));
}

for (const engine of engines) {
  flow(engine, 'list, detail and new-query focus remain connected', {}, async h => {
    const page = await h.open(null);
    const cspEnforced = await page.evaluate(() => new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 1000);
      document.addEventListener('securitypolicyviolation', event => {
        if (event.blockedURI === 'inline') { clearTimeout(timer); resolve(true); }
      }, { once: true });
      const script = document.createElement('script'); script.textContent = 'window.syntheticInlineScriptRan = true';
      document.body.appendChild(script);
    }));
    assert.equal(cspEnforced, true, 'The browser enforces the tested build CSP');
    assert.equal(await page.evaluate(() => window.syntheticInlineScriptRan === true), false);
    await page.locator(`[data-thread-id="${ids.regular}"]`).click();
    await page.getByText('已有的合成回复', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.locator('.inspector').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建会话', exact: true });
    await dialog.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('dialog textarea'));
    await dialog.locator('textarea').fill('合成新建草稿');
    assert.equal(await dialog.locator('textarea').inputValue(), '合成新建草稿');
    assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
  });

  flow(engine, 'information loading has stable height and fresh reopen uses its cache', {}, async h => {
    const gate = h.pause('automations'), page = await h.open();
    await page.getByText('已有的合成回复', { exact: true }).waitFor();
    await openInfo(page); await until(() => h.count('automations') === 1);
    const loading = await infoGeometry(page);
    gate.release(); await page.waitForFunction(() => document.querySelector('.thread-automations')?.getAttribute('aria-busy') === 'false');
    const ready = await infoGeometry(page);
    assert.ok(Math.abs(loading.height - ready.height) < 1, `${loading.height} → ${ready.height}`);
    assert.equal(ready.closeFocused, false);
    for (let count = 0; count < 2; count++) { await closeInfo(page); await openInfo(page); }
    assert.equal(h.count('automations'), 1); assert.equal(h.count('model-settings'), 1);
  });

  for (const [label, threadId] of [['existing', ids.regular], ['empty', ids.empty]]) {
    flow(engine, `${label} conversation keeps one query row through acceptance and late queue data`, {}, async h => {
      const page = await h.open(threadId);
      if (threadId === ids.regular) await page.getByText('已有的合成回复', { exact: true }).waitFor();
      const input = page.getByRole('textbox', { name: '发送消息', exact: true });
      await input.fill(`合成-${label}-唯一发送正文`);
      await page.locator('.conversation-composer button[type="submit"]').click();
      await until(() => h.calls.some(call => call.method === 'POST' && call.action === 'messages'));
      const call = h.calls.find(call => call.method === 'POST' && call.action === 'messages'), id = call.requestId;
      const row = page.locator(`article[data-query-id="${id}"]`);
      await row.waitFor(); assert.equal(await row.count(), 1);
      await row.evaluate(element => { window.syntheticQueryRow = element; });
      h.accept(threadId, id);
      await page.waitForFunction(id => document.querySelector(`article[data-query-id="${id}"]`)?.getAttribute('data-query-state') === 'accepted', id);
      h.echo(threadId, id); await refresh(page);
      await page.locator(`[data-message-id="echo-${id}"]`).waitFor();
      assert.equal(await row.count(), 1);
      assert.equal(await row.evaluate(element => element === window.syntheticQueryRow), true);
      h.staleQueue(threadId, id); const reads = h.count('history'); await refresh(page);
      await until(() => h.count('history') > reads); await page.waitForTimeout(160);
      assert.equal(await row.count(), 1);
      assert.equal(await page.locator(`[data-submission-id="${id}"], [data-outbox-id="${id}"]`).count(), 0);
      assert.equal(await row.evaluate(element => element === window.syntheticQueryRow), true);
      assert.equal(h.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
    });
  }

  flow(engine, 'top pull loads older history once and returning latest preserves the message root', { history: true }, async h => {
    const page = await h.open(); await page.locator('[data-message-id="history-239"]').waitFor();
    const root = page.locator('.conversation-messages');
    await root.evaluate(element => { window.syntheticMessagesRoot = element; element.scrollTop = 0; });
    await page.waitForTimeout(240); assert.equal(h.count('transcript-page'), 0);
    await pullFromTop(page);
    await page.waitForFunction(() => document.querySelectorAll('.earlier-history-messages [data-message-id]').length === 160);
    assert.equal(h.count('transcript-page'), 2);
    assert.equal(await root.evaluate(element => element === window.syntheticMessagesRoot), true);
    assert.equal(await page.locator('.earlier-history-messages [data-pocket-read-marker], .earlier-history-messages [data-query-id]').count(), 0);
    await root.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(280); assert.equal(h.count('transcript-page'), 2);
    await page.getByRole('button', { name: '返回最新消息', exact: true }).click();
    await page.locator('.earlier-history-messages').waitFor({ state: 'detached' });
    assert.equal(await root.evaluate(element => element === window.syntheticMessagesRoot), true);
    await page.waitForFunction(() => { const element = document.querySelector('.conversation-messages'); return element.scrollHeight - element.scrollTop - element.clientHeight < 2; });
  });

  for (const cause of ['move', 'input']) {
    flow(engine, `slow history results do not take over after ${cause}`, { history: true }, async h => {
      const page = await h.open(); await page.locator('[data-message-id="history-239"]').waitFor();
      const gate = h.pause('transcript-page'), root = page.locator('.conversation-messages');
      await pullFromTop(page); await until(() => h.count('transcript-page') === 1);
      if (cause === 'move') await root.evaluate(element => { element.scrollTop = 180; });
      else await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('慢读取期间保留的草稿');
      gate.release();
      await page.getByRole('button', { name: '查看已加载的消息', exact: true }).waitFor();
      assert.equal(await page.locator('.earlier-history-messages').count(), 0);
      assert.equal(h.count('transcript-page'), 2);
      if (cause === 'input') assert.equal(await page.getByRole('textbox', { name: '发送消息', exact: true }).inputValue(), '慢读取期间保留的草稿');
      await page.waitForTimeout(240);
      assert.equal(await page.locator('.earlier-history-messages').count(), 0);
      assert.equal(h.count('transcript-page'), 2);
      await page.getByRole('button', { name: '查看已加载的消息', exact: true }).click();
      await page.locator('.earlier-history-messages').waitFor();
      assert.equal(h.count('transcript-page'), 2, 'Prepared pages are reused without another request');
    });
  }
}

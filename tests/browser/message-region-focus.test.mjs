import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, engines, ids, refresh } from './fixture.mjs';

const shape = root => root.evaluate(node => ({
  active: document.activeElement === node, focusVisible: node.matches(':focus-visible'),
  outline: getComputedStyle(node).outlineStyle, origin: node.getAttribute('data-message-focus-origin'),
  scrollTop: node.scrollTop, selected: document.getSelection()?.toString() || '',
  retained: node === window.messageFocusRoot,
}));
const focusByTab = async page => {
  await page.locator('.inspector-title-trigger').focus();
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    if (await page.locator('.conversation-messages').evaluate(node => document.activeElement === node)) return;
  }
  throw new Error('Native Tab navigation did not reach the message region');
};

for (const engine of engines) {
  test(`${engine}: prose taps clear inherited viewport focus while keyboard reading and fresh text keep intent`, { timeout: 30000 }, async () => {
    const h = await createHarness(engine, { locale: 'en-US', history: true });
    try {
      const page = await h.open(), root = page.locator('.conversation-messages');
      const prose = page.locator('.conversation-message.assistant .message-markdown p').last();
      await root.evaluate(node => { window.messageFocusRoot = node; });
      await prose.click(); assert.equal((await shape(root)).outline, 'none');
      await focusByTab(page);
      await root.evaluate(node => { node.scrollTop = (node.scrollHeight - node.clientHeight) / 2; });
      await page.waitForTimeout(100);
      const keyboard = await shape(root); assert.equal(keyboard.origin, 'keyboard'); assert.equal(keyboard.outline, 'solid');
      assert.ok(keyboard.scrollTop > 0, 'Keyboard scrolling starts from a stable position rather than the native entry scroll');
      await page.keyboard.press('PageUp'); await page.waitForTimeout(250);
      assert.ok((await shape(root)).scrollTop < keyboard.scrollTop, 'The focused region still scrolls with the keyboard');
      await prose.tap(); const touch = await shape(root); assert.equal(touch.origin, 'pointer'); assert.equal(touch.outline, 'none');
      await page.keyboard.press('ArrowUp'); assert.equal((await shape(root)).outline, 'solid');
      await prose.click(); assert.equal((await shape(root)).outline, 'none');
      const input = page.locator('.conversation-composer textarea');
      await input.fill('Keep this draft, reading surface and input node.');
      await input.evaluate(node => { window.messageFocusInput = node; });
      await prose.tap(); assert.equal((await shape(root)).outline, 'none');
      await page.locator('.inspector-title-trigger').focus(); await page.waitForTimeout(50); await root.focus();
      assert.equal((await shape(root)).origin, 'programmatic'); assert.equal((await shape(root)).outline, 'none');
      await prose.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
      const selection = await shape(root); assert.ok(selection.selected.length);
      await refresh(page); await page.waitForTimeout(180);
      const fresh = await shape(root); assert.equal(fresh.retained, true); assert.equal(fresh.selected, selection.selected); assert.equal(fresh.outline, 'none');
      assert.equal(await input.inputValue(), 'Keep this draft, reading surface and input node.');
      assert.equal(await input.evaluate(node => node === window.messageFocusInput), true);
      await page.evaluate(() => document.getSelection()?.removeAllRanges());
      await page.locator('[data-inspector-close]').click(); await page.locator('.inspector').waitFor({ state: 'detached' });
      await page.locator(`[data-thread-id="${ids.empty}"]`).click(); await page.locator('.conversation-messages').waitFor();
      assert.equal(await page.locator('.conversation-messages').getAttribute('data-message-focus-origin'), 'programmatic');
      assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
    } finally { await h.close(); }
  });

  test(`${engine}: text/code controls keep their own keyboard ring and streaming never restores the prose outline`, { timeout: 30000 }, async () => {
    const h = await createHarness(engine, { locale: 'zh-CN' });
    const reply = 'Read this example.\n\n```text\nA keyboard-readable code sample.\n```\n\n| Name | State |\n| --- | --- |\n| Sample | Ready |\n\n' + 'A longer paragraph keeps the message area scrollable.\n\n'.repeat(30);
    const messages = [{ id: ids.regular + '-u', role: 'user', text: 'A synthetic question.', timestamp: Date.now() - 2000, turnId: 'initial' },
      { id: ids.regular + '-a', role: 'assistant', phase: 'final', text: reply, timestamp: Date.now() - 1000, turnId: 'initial' }];
    try {
      h.patchHistory(ids.regular, { messages });
      const page = await h.open(), root = page.locator('.conversation-messages');
      await page.locator('.message-markdown pre').waitFor();
      await root.evaluate(node => { window.messageFocusRoot = node; });
      await focusByTab(page);
      let child = false;
      for (let index = 0; index < 10; index++) {
        await page.keyboard.press('Tab');
        child = await page.locator('.message-markdown pre').evaluate(node => document.activeElement === node);
        if (child) break;
      }
      assert.equal(child, true);
      const code = await page.locator('.message-markdown pre').evaluate(node => ({ visible: node.matches(':focus-visible'), outline: getComputedStyle(node).outlineStyle }));
      assert.equal(code.visible, true); assert.notEqual(code.outline, 'none');
      assert.equal((await shape(root)).active, false, 'The child owns its focus instead of the viewport');
      await page.locator('.conversation-message.assistant .message-markdown p').last().tap();
      assert.equal((await shape(root)).outline, 'none');
      const text = reply + 'A fresh streaming continuation.';
      h.patchHistory(ids.regular, { messages: [{ ...messages[0] }, { ...messages[1], text }], runtime: 'active', latestTurnId: 'initial', activeTurnId: 'initial', latestTurnStatus: 'inProgress' });
      await refresh(page); await page.getByText('A fresh streaming continuation.', { exact: true }).waitFor();
      const live = await shape(root); assert.equal(live.retained, true); assert.equal(live.origin, 'pointer'); assert.equal(live.outline, 'none');
      assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
    } finally { await h.close(); }
  });
}

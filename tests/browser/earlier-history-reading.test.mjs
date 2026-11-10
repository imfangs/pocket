import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, engines } from './fixture.mjs';

const visibleAnchor = (root, id) => {
  const viewport = root.getBoundingClientRect();
  const node = [...root.querySelectorAll('[data-message-id]')].find(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (id ? node.dataset.messageId === id : rect.bottom > viewport.top && rect.top < viewport.bottom);
  });
  return { id: node?.dataset.messageId, offset: node ? node.getBoundingClientRect().top - viewport.top : null, top: root.scrollTop };
};

for (const engine of engines) test(`${engine}: a newer scroll before the historical loading commit keeps its position and subsequent shared anchor`, { timeout: 30000 }, async () => {
  const h = await createHarness(engine, { history: true });
  try {
    const page = await h.open();
    await page.locator('[data-message-id="history-239"]').waitFor();
    const root = page.locator('.conversation-messages'), gate = h.pause('transcript-page');
    // React's delegated handler publishes the loading notification before the
    // remaining native event listeners finish. Force a newer scroll in that
    // interval to reproduce the same store-notification/commit ownership race.
    await root.evaluate(element => {
      window.earlierReadingRoot = element;
      element.scrollTop = 140;
      element.dispatchEvent(new Event('scroll'));
      document.querySelector('#root').addEventListener('click', () => { element.scrollTop = 440; }, { once: true });
      [...element.querySelectorAll('button')].find(button => button.textContent === '加载更早消息').click();
    });
    const reading = await root.evaluate(visibleAnchor);
    assert.equal(reading.top, 440);
    await page.waitForTimeout(160);
    assert.equal(await root.evaluate(element => element.scrollTop), 440, 'loading UI must yield to the newer scroll');
    gate.release();
    await page.locator('.earlier-history-messages').waitFor();
    const after = await root.evaluate(visibleAnchor, reading.id);
    assert.equal(after.id, reading.id);
    assert.ok(Math.abs(after.offset - reading.offset) < 1, 'the requested prepend still preserves the new shared anchor');
    assert.equal(await root.evaluate(element => element === window.earlierReadingRoot), true);
    await root.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForTimeout(200);
    assert.equal(await root.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 2), true, 'reading can reach the latest end of the historical window');
    assert.equal(h.count('transcript-page'), 2, 'reading down cannot start another history page');
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.unexpected, []);
    assert.equal(h.calls.some(call => call.method !== 'GET' && call.path !== '/api/sync'), false, 'the fixture never submits a message or opens an owner');
  } finally { await h.close(); }
});

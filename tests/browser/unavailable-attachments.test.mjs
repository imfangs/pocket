import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_UNAVAILABLE_ATTACHMENTS_REPORT || '.local/qa/attachment-names-2026-11-14/browser.json');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2));
});

for (const engine of engines) for (const locale of ['zh-CN', 'en']) test(`${engine}: ${locale} native attachment names remain compact and noninteractive`, { timeout: 30000 }, () => runScenario({
  engine, name: `${locale} native attachment names`, create: () => createHarness(engine, { width: 320, locale }),
  run: async h => {
    const longName = 'review-' + 'long-name-'.repeat(15) + '.docx';
    h.seedThread(ids.regular, { messages: [
      { id: 'with-query', role: 'user', text: '审核好了\n\n[附件需在 Mac 中查看]', unavailableAttachments: [{ name: longName, kind: 'file' }], unavailableAttachmentPlaceholder: true, timestamp: Date.now() },
      { id: 'files-only', role: 'user', text: '[附件需在 Mac 中查看]', unavailableAttachments: [{ name: '截图 01.png', kind: 'image' }], unavailableAttachmentPlaceholder: true, timestamp: Date.now() },
    ] });
    const page = await h.open();
    const query = page.locator('[data-message-id="with-query"]'), only = page.locator('[data-message-id="files-only"]');
    await query.getByText('审核好了', { exact: true }).waitFor();
    await query.getByText(longName, { exact: true }).waitFor();
    await only.getByText('截图 01.png', { exact: true }).waitFor();
    const label = locale === 'en' ? 'View this attachment on your Mac' : '附件需在 Mac 中查看';
    assert.equal(await query.getByText(label, { exact: true }).count(), 1);
    assert.equal(await query.locator('img, a, .attachment-card button').count(), 0);
    const filename = query.locator('.attachment-name');
    assert.equal(await filename.getAttribute('title'), longName);
    assert.equal(await filename.evaluate(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) * 2 + 1), true);
    assert.equal(await page.locator('.conversation-messages').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    assert.equal(h.calls.filter(call => /\/images\/|\/files\/|\/attachments\//.test(call.path ?? '')).length, 0);
  }, record: result => results.push(result),
}));

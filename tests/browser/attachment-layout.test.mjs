import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createHarness, engines, ids } from './fixture.mjs';

const names = [
  '产品界面审查与改进记录—第一轮修订—最终版.pdf',
  '产品界面审查与改进记录—第一轮修订—最终版-补充.pdf',
];
const attachments = names.map((name, index) => ({
  id: `b7100000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  name, size: 42000, mime: 'application/pdf', kind: 'file', sha256: 'a'.repeat(64),
  url: `/api/tasks/${ids.regular}/attachments/b7100000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
}));

for (const engine of engines) test(`${engine}: draft attachment names remain distinguishable on touch and removal preserves the other file`, { timeout: 90000 }, async () => {
  for (const locale of ['zh-CN', 'en-US']) for (const width of [320, 390, 768]) for (const theme of ['light', 'dark']) {
    const h = await createHarness(engine, { width, locale });
    try {
      const page = await h.open();
      let remaining = [...attachments];
      await page.route(/\/api\/(?:machines\/[^/]+\/)?tasks\/[^/]+\/attachments(?:\/[^/?]+)?(?:\?.*)?$/, async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() === 'GET' && /\/attachments$/.test(url.pathname)) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ attachments: remaining }) });
        } else if (request.method() === 'DELETE') {
          remaining = remaining.filter(item => item.id !== url.pathname.split('/').at(-1));
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ removed: true }) });
        } else throw new Error('Unexpected attachment operation: ' + request.method() + ' ' + url.pathname);
      });
      await page.reload();
      await page.locator('.conversation-live').waitFor();
      await page.evaluate(value => { document.documentElement.dataset.theme = value; window.dispatchEvent(new Event('pocket-theme-changed')); }, theme);
      const drafts = page.locator('.draft-attachments');
      await drafts.locator('.attachment-card').nth(1).waitFor();
      const metrics = await drafts.locator('.attachment-name').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(), range = document.createRange();
        range.setStart(node.firstChild, Math.max(0, node.textContent.length - 12));
        range.setEnd(node.firstChild, node.textContent.length);
        return { name: node.textContent, width: box.width, scroll: node.scrollWidth, client: node.clientWidth,
          suffixVisible: [...range.getClientRects()].every(r => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1) };
      }));
      assert.deepEqual(metrics.map(item => item.name), names);
      if (process.env.POCKET_ATTACHMENT_EVIDENCE && engine === 'chromium' && locale === 'zh-CN' && width === 320 && theme === 'light') {
        mkdirSync(process.env.POCKET_ATTACHMENT_EVIDENCE, { recursive: true });
        await page.screenshot({ path: process.env.POCKET_ATTACHMENT_EVIDENCE + '/actual-app.png' });
      }
      for (const item of metrics) {
        assert.equal(item.suffixVisible, true, 'Touch users must see the distinguishing filename suffix: ' + JSON.stringify(item));
        assert.ok(item.scroll <= item.client + 1, JSON.stringify(item));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const remove = drafts.locator('.attachment-controls button').first();
      await remove.scrollIntoViewIfNeeded();
      const hit = await remove.evaluate(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height }; });
      assert.ok(hit.width >= 44 && hit.height >= 44, JSON.stringify(hit));
      await remove.click();
      await drafts.locator(`[data-attachment-id="${attachments[0].id}"]`).waitFor({ state: 'detached' });
      assert.equal(await drafts.locator('.attachment-card').count(), 1);
      assert.equal(await drafts.locator('.attachment-name').textContent(), names[1]);
      assert.deepEqual(h.errors, []);
      assert.deepEqual(h.unexpected, []);
    } finally { await h.close(); }
  }
});

for (const engine of engines) test(`${engine}: long filename survives failed, unknown and verified upload states without resending verification`, { timeout: 30000 }, async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const h = await createHarness(engine, { width: 320, locale });
    try {
      const page = await h.open(), bytes = Buffer.from('Synthetic attachment for the browser regression.');
      const name = 'Product-interface-audit-notes_first-revision_final-supplement.pdf';
      let uploads = 0, metadataReady = false;
      await page.route(/\/api\/(?:machines\/[^/]+\/)?tasks\/[^/]+\/attachments\/[^/?]+(?:\?.*)?$/, async route => {
        const request = route.request(), url = new URL(request.url()), id = url.pathname.split('/').at(-1);
        if (request.method() === 'PUT') {
          uploads++;
          await route.fulfill({ status: uploads === 1 ? 422 : 502, contentType: 'application/json', body: JSON.stringify({ error: uploads === 1 ? '附件上传未完成，请重试。' : '连接暂时中断，请核对上传结果。' }) });
        } else if (request.method() === 'GET' && url.searchParams.has('metadata')) {
          await route.fulfill({ status: metadataReady ? 200 : 409, contentType: 'application/json', body: JSON.stringify(metadataReady ? {
            id, name, size: bytes.length, mime: 'application/pdf', kind: 'file', sha256: createHash('sha256').update(bytes).digest('hex'),
            url: `/api/tasks/${ids.regular}/attachments/${id}`,
          } : { error: '附件仍在上传，请稍后核对。' }) });
        } else if (request.method() === 'DELETE') await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ removed: true }) });
        else throw new Error('Unexpected attachment operation: ' + request.method() + ' ' + url.pathname);
      });
      await page.locator('[data-attachment-input]').setInputFiles({ name, mimeType: 'application/pdf', buffer: bytes });
      const drafts = page.locator('.draft-attachments');
      await drafts.locator('[data-upload-status="failed"]').waitFor();
      const checkLayout = async () => {
        const geometry = await drafts.locator('.attachment-card').evaluate(node => {
          const r = node.getBoundingClientRect(), name = node.querySelector('.attachment-name'), details = node.querySelector('.attachment-details').getBoundingClientRect();
          const actions = node.querySelector('.attachment-controls').getBoundingClientRect();
          return { text: name.textContent, clipped: name.scrollWidth > name.clientWidth,
            actionsYieldToText: node.querySelectorAll('button').length < 2 || actions.top >= details.bottom - 1,
            controls: [...node.querySelectorAll('button')].map(n => { const b = n.getBoundingClientRect(); return { width: b.width, height: b.height, withinCard: b.left >= r.left - 1 && b.right <= r.right + 1 }; }) };
        });
        assert.equal(geometry.text, name); assert.equal(geometry.clipped, false, JSON.stringify(geometry));
        assert.equal(geometry.actionsYieldToText, true, 'Narrow cards move both actions below the readable text after a live state change: ' + JSON.stringify(geometry));
        assert.ok(geometry.controls.every(item => item.width >= 44 && item.height >= 44 && item.withinCard), JSON.stringify(geometry));
      };
      await checkLayout();
      const retry = drafts.locator('.attachment-controls button').first();
      await retry.focus(); await page.keyboard.press('Enter');
      await drafts.locator('[data-upload-status="unknown"]').waitFor();
      await checkLayout();
      metadataReady = true;
      await drafts.locator('.attachment-controls button').first().click();
      await drafts.locator('[data-upload-status="uploaded"]').waitFor();
      await checkLayout();
      assert.equal(uploads, 2, 'Verification must never re-upload an ambiguous attachment');
      await drafts.locator('.attachment-controls button').click();
      await drafts.waitFor({ state: 'detached' });
      assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
    } finally { await h.close(); }
  }
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
import { syntheticPng, imageSha256 } from './helpers/synthetic-png.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_FILE_IMAGE_REPORT || '.local/qa/browser-file-image-preview/scenarios.json');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const filePath = '/synthetic/page-preview.jpg', bodyPath = '/synthetic/body.png';
const file = { url: `/api/tasks/${ids.regular}/files/${'f'.repeat(64)}`, name: 'page-preview.jpg' };
const original = { url: `/api/tasks/${ids.regular}/files/${'c'.repeat(64)}`, name: 'notes.pdf' };
const bodySrc = `/api/tasks/${ids.regular}/images/${'a'.repeat(64)}`;
const attachmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', attachmentSrc = `/api/tasks/${ids.regular}/attachments/${attachmentId}`;
const png = syntheticPng({ width: 160, height: 100 });
const attachment = { id: attachmentId, name: 'Attached image.png', size: png.length, mime: 'image/png', kind: 'image', sha256: imageSha256(png), url: attachmentSrc, previewUrl: attachmentSrc + '?preview=1', previewSha256: imageSha256(png), previewMime: 'image/png', previewSize: png.length };
const messageId = 'synthetic-file-image', imageSrc = file.url + '/image';
const makeMessage = extra => ({ id: messageId, role: 'assistant', phase: 'final', turnId: 'file-image-turn', timestamp: Date.now(),
  text: `![Body image](${bodyPath})\n\n[Page preview](${filePath})\n\n[Ordinary file](/synthetic/notes.pdf)`,
  files: { [filePath]: file, '/synthetic/notes.pdf': original }, images: { [bodyPath]: bodySrc }, attachments: [attachment], ...extra });
const install = (h, messages = [makeMessage()]) => { h.patchHistory(ids.regular, { messages }); h.patchTranscript(ids.regular, { messages }); };
const row = page => page.locator(`[data-message-id="${messageId}"]`);
const viewer = page => page.locator('dialog[data-image-viewer]');
const fileCard = page => row(page).locator('.message-file').filter({ hasText: file.name });
const previewButton = page => fileCard(page).locator('.message-file-button[aria-haspopup="dialog"]');
const sha = value => createHash('sha256').update(value).digest('hex');

async function start(h, media) {
  const page = await h.open(null), reads = [];
  await page.route(/^blob:https:\/\/pocket\.test\//, route => route.continue());
  // All image bytes originate from this synthetic canvas, never a user file.
  const synthetic = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
    const context = canvas.getContext('2d'); context.fillStyle = '#567899'; context.fillRect(0, 0, 160, 100);
    return { jpeg: canvas.toDataURL('image/jpeg').split(',')[1], png: canvas.toDataURL('image/png').split(',')[1] };
  });
  const jpeg = Buffer.from(synthetic.jpeg, 'base64');
  await page.route(/\/api\/tasks\/[^/]+\/(?:images\/[a-f0-9]{64}|files\/[a-f0-9]{64}(?:\/image)?|attachments\/[a-f0-9-]{36})(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    reads.push({ path, type: route.request().resourceType(), query: url.search, method: route.request().method() });
    if (media && await media({ route, path, reads, jpeg, png })) return;
    assert.ok([file.url, original.url, imageSrc, bodySrc, attachmentSrc].includes(path), 'Only synthetic issued media may be read');
    await route.fulfill({ status: 200, contentType: path === imageSrc ? 'image/jpeg' : path === file.url || path === original.url ? 'application/octet-stream' : 'image/png',
      headers: { 'Cache-Control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: path === imageSrc || path === file.url ? jpeg : path === original.url ? Buffer.from('Synthetic notes') : png });
  });
  await page.goto(page.url() + '&task=' + ids.regular); await row(page).waitFor(); return { page, reads, jpeg };
}
async function ready(page) {
  await page.waitForFunction(() => { const image = document.querySelector('dialog[data-image-viewer] img');
    return image?.complete && image.naturalWidth === 160 && image.style.visibility === 'visible'; }, undefined, { timeout: 2500 });
}
async function position(page, index, total = 3) {
  await page.waitForFunction(({ index, total }) => document.querySelector('.image-viewer-counter')?.textContent === `${index} / ${total}`, { index, total }, { timeout: 1800 });
}
function flow(engine, locale, width, name, run) {
  test(`${engine}: ${locale} ${width}px ${name}`, { timeout: 20000 }, () => {
    const evidence = {};
    return runScenario({ engine, name: `${locale} ${width}px ${name}`, create: () => createHarness(engine, { locale, width }),
      run: h => run(h, evidence), record: result => results.push({ ...result, evidence }) });
  });
}

for (const engine of engines) {
  for (const [locale, width] of [['zh-CN', 390], ['en-US', 320]]) {
    flow(engine, locale, width, 'registered JPEG file offers compact preview, bounded original download and the same message gallery', async (h, evidence) => {
      install(h); const { page, reads, jpeg } = await start(h);
      evidence.originalControlLabels = await fileCard(page).getByRole('button').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
      evidence.previewButtons = await previewButton(page).count();
      assert.equal(evidence.previewButtons, 1, 'A registered JPEG file needs a preview rather than only a download card');
      assert.equal(await fileCard(page).locator('img').count(), 0, 'The compact file card does not download or display a thumbnail automatically');
      assert.equal(reads.filter(read => [file.url, imageSrc].includes(read.path)).length, 0, 'No image-file bytes are read before its action');
      const controls = await fileCard(page).getByRole('button').evaluateAll(elements => elements.map(element => {
        const box = element.getBoundingClientRect(); return { width: box.width, height: box.height, left: box.left, right: box.right }; }));
      for (const box of controls) assert.ok(box.height >= 44 && box.width >= 44 && box.left >= 0 && box.right <= width, JSON.stringify(box));
      const input = page.locator('.conversation-composer textarea'); await input.fill('Unsent image-file draft');
      await input.evaluate(element => { window.fileImageInput = element; element.setSelectionRange(2, 9); });
      await previewButton(page).click(); await viewer(page).waitFor(); await position(page, 2); await ready(page);
      await viewer(page).evaluate(element => { window.fileImageDialog = element; });
      assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), imageSrc);
      await page.keyboard.press('ArrowLeft'); await position(page, 1); await ready(page);
      assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), bodySrc);
      await page.keyboard.press('ArrowRight'); await position(page, 2); await page.keyboard.press('ArrowRight'); await position(page, 3); await ready(page);
      assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), attachmentSrc);
      assert.equal(await viewer(page).evaluate(element => element === window.fileImageDialog), true);
      await page.keyboard.press('Escape'); await viewer(page).waitFor({ state: 'detached' });
      assert.equal(await previewButton(page).evaluate(element => document.activeElement === element), true);
      assert.equal(await input.evaluate(element => element === window.fileImageInput && element.selectionStart === 2 && element.selectionEnd === 9), true);
      assert.equal(await input.inputValue(), 'Unsent image-file draft');
      const downloadStarted = page.waitForEvent('download'); await fileCard(page).locator('.message-file-download').click();
      const download = await downloadStarted, stream = await download.createReadStream(), chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.equal(download.suggestedFilename(), file.name); assert.equal(sha(Buffer.concat(chunks)), sha(jpeg));
      assert.equal(reads.filter(read => read.path === file.url).length, 1, 'The original registered file is downloaded exactly once');
      assert.equal(await viewer(page).count(), 0);
      evidence.downloadSha256 = sha(jpeg); evidence.controls = controls;
    });
  }

  flow(engine, 'zh-CN', 390, 'forged file routes and unsupported filenames stay inert or keep their existing download behavior', async (h, evidence) => {
    const forged = `/api/tasks/${ids.regular}/files/${'d'.repeat(64)}`;
    const text = `[raw JPEG](${file.url})\n\n[raw preview](${imageSrc})\n\n[external](https://pocket.test${imageSrc})\n\n[query](/synthetic/query.jpg)\n\n[cross-thread](/synthetic/other.jpg)\n\n[SVG](/synthetic/vector.svg)\n\n[HEIC](/synthetic/heic.heic)\n\n![Unissued image](${forged}/image)`;
    install(h, [makeMessage({ text, images: {}, attachments: [], files: {
      [filePath]: file, '/synthetic/query.jpg': { ...file, url: file.url + '?preview=1' },
      '/synthetic/other.jpg': { ...file, url: file.url.replace(ids.regular, ids.empty) },
      '/synthetic/vector.svg': { ...file, name: 'vector.svg' }, '/synthetic/heic.heic': { ...file, name: 'heic.heic' },
    } })]);
    const { page, reads } = await start(h);
    assert.equal(await row(page).locator('[aria-haspopup="dialog"]').count(), 1, 'Only the registered SVG gains its supported static preview');
    assert.equal(await row(page).locator('.message-file-download').count(), 0);
    assert.equal(await row(page).getByRole('button', { name: '下载文件：heic.heic', exact: true }).count(), 1);
    assert.equal(await row(page).getByRole('button', { name: '预览文件：vector.svg', exact: true }).count(), 1, 'SVG keeps a separate document preview and never enters the raster gallery');
    assert.equal(reads.length, 0); assert.equal(await viewer(page).count(), 0);
    assert.equal(await row(page).locator('a[href*="/files/"]').count(), 0);
    evidence.noImageFileReads = true;
  });

  flow(engine, 'en-US', 320, 'an expired image-file preview stays closable and can navigate to the other registered image', async h => {
    install(h); const { page } = await start(h, async ({ route, path }) => {
      if (path !== imageSrc) return false;
      await route.fulfill({ status: 410, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'ged' }, body: JSON.stringify({ error: 'Synthetic expired image' }) }); return true;
    });
    await previewButton(page).click(); await viewer(page).waitFor(); await position(page, 2); await viewer(page).locator('[role="alert"]').waitFor();
    await page.keyboard.press('ArrowRight'); await position(page, 3); await ready(page);
    assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), attachmentSrc);
    await page.keyboard.press('Escape'); await viewer(page).waitFor({ state: 'detached' });
    assert.equal(await previewButton(page).evaluate(element => document.activeElement === element), true);
  });
}

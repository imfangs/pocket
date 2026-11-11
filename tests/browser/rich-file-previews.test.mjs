import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
import { syntheticPreviewPdf } from '../fixtures/pdf-preview.mjs';
import { wav } from '../helpers/audio-fixtures.mjs';

const results = [];
after(() => { const path = resolve(process.env.POCKET_RICH_FILE_REPORT || '.local/qa/browser-rich-files/scenarios.json');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n'); });
const pdf = { name: 'Reading.pdf', path: '/synthetic/Reading.pdf', url: `/api/tasks/${ids.regular}/files/${'a'.repeat(64)}` };
const svg = { name: 'Drawing.svg', path: '/synthetic/Drawing.svg', url: `/api/tasks/${ids.regular}/files/${'b'.repeat(64)}` };
const sound = { name: 'Listen.wav', path: '/synthetic/Listen.wav', url: `/api/tasks/${ids.regular}/files/${'c'.repeat(64)}` };
const documentBytes = syntheticPreviewPdf();
const vector = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><script>parent.svgExecuted=true</script><rect width="200" height="100" fill="#345678"/><image href="https://external.invalid/private.png"/></svg>';
const install = h => {
  const messages = [{ id: 'rich-files', role: 'assistant', phase: 'final', turnId: 'rich-file-turn', timestamp: Date.now(),
    text: [pdf, svg, sound].map(file => `[${file.name}](${file.path})`).join('\n\n'), files: Object.fromEntries([pdf, svg, sound].map(file => [file.path, file])) }];
  h.patchHistory(ids.regular, { messages }); h.patchTranscript(ids.regular, { messages });
};
const openFile = (page, file) => page.locator('[data-message-id="rich-files"] .message-file-button').filter({ hasText: file.name }).click();
const dialog = page => page.locator('dialog[data-rich-file-preview]');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function flow(engine, locale, name, run) {
  test(`${engine}: ${locale} ${name}`, { timeout: 25000 }, () => {
    const evidence = {};
    return runScenario({ engine, name, create: () => createHarness(engine, { locale, width: locale === 'en-US' ? 320 : 390 }),
      run: h => run(h, evidence), record: value => results.push({ ...value, evidence }) });
  });
}
async function setup(h, handler) {
  install(h); const page = await h.open(null);
  await page.context().route(/^blob:https:\/\/pocket\.test\//, route => route.continue());
  await page.route(/\/api\/tasks\/[^/]+\/files\/[a-f0-9]{64}(?:\/audio)?$/, async route => {
    const path = new URL(route.request().url()).pathname;
    if (handler && await handler(route, path)) return;
    const body = path === pdf.url ? documentBytes : path === svg.url ? Buffer.from(vector) : path === sound.url ? wav() : null;
    assert.ok(body, path);
    await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'X-Pocket-Machine': 'ged', 'Cache-Control': 'no-store' }, body });
  });
  await page.goto(page.url() + '&task=' + ids.regular); await page.locator('[data-message-id="rich-files"]').waitFor(); return page;
}
for (const engine of engines) {
  flow(engine, 'zh-CN', 'PDF and sanitized SVG render in the file modal and download reuses the exact original', async (h, evidence) => {
    const page = await setup(h), input = page.locator('.conversation-composer textarea');
    await input.fill('Unsent document draft'); await input.evaluate(element => { window.richInput = element; element.setSelectionRange(2, 8); });
    let reads = 0; page.on('request', request => { if (new URL(request.url()).pathname === pdf.url) reads++; });
    await openFile(page, pdf); await dialog(page).waitFor();
    try { await page.waitForFunction(() => document.querySelector('dialog[data-rich-file-preview] canvas')?.width > 0); }
    catch (error) { evidence.failureText = await dialog(page).innerText(); evidence.pageErrors = h.errors; evidence.unexpected = h.unexpected; throw error; }
    assert.equal(await dialog(page).locator('[data-pdf-page]').count(), 3);
    assert.ok(await dialog(page).locator('canvas').count() <= 5);
    await page.evaluate(() => { window.richDownloads = []; const original = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { window.richDownloads.push(blob); return original(blob); }; HTMLAnchorElement.prototype.click = function () {}; });
    await dialog(page).locator('.text-file-toolbar button').first().click();
    await page.waitForFunction(() => window.richDownloads.length === 1);
    const bytes = await page.evaluate(async () => [...new Uint8Array(await window.richDownloads[0].arrayBuffer())]);
    assert.equal(sha(Buffer.from(bytes)), sha(documentBytes)); assert.equal(reads, 1);
    await page.keyboard.press('Escape'); await dialog(page).waitFor({ state: 'detached' });
    assert.equal(await input.evaluate(element => element === window.richInput && element.selectionStart === 2 && element.selectionEnd === 8), true);
    await openFile(page, svg); await page.waitForFunction(() => { const image = document.querySelector('dialog[data-rich-file-preview] img'); return image?.complete && image.naturalWidth === 200; });
    assert.equal(await page.evaluate(() => !!window.svgExecuted), false);
    assert.equal(await dialog(page).locator('.text-file-scroll script,.text-file-scroll iframe,.text-file-scroll svg').count(), 0, 'Authored SVG is an inert image; trusted toolbar icons remain ordinary controls');
    assert.match(await dialog(page).locator('img').getAttribute('src'), /^blob:https:\/\/pocket\.test\//);
    await page.keyboard.press('Escape'); await dialog(page).waitFor({ state: 'detached' });
    assert.equal(await input.inputValue(), 'Unsent document draft'); evidence.downloadReused = true; evidence.svgInert = true;
  });
  flow(engine, 'en-US', 'native audio loads bounded synthetic WAV metadata and closing releases playback', async (h, evidence) => {
    const audioBytes = wav(); const requests = [];
    const page = await setup(h, async (route, path) => {
      if (path !== sound.url + '/audio') return false;
      requests.push({ type: route.request().resourceType(), range: route.request().headers().range ?? null });
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '');
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(audioBytes.length - 1, Number(range[2])) : audioBytes.length - 1;
      await route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', headers: { 'X-Pocket-Machine': 'ged', 'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${audioBytes.length}` } : {}) }, body: audioBytes.subarray(start, end + 1) }); return true;
    });
    await openFile(page, sound); await page.waitForFunction(() => document.querySelector('dialog[data-rich-file-preview] audio')?.readyState >= 1);
    const media = dialog(page).locator('audio'); assert.equal(await media.getAttribute('autoplay'), null);
    await media.evaluate(element => { window.oldRichAudio = element; });
    assert.ok(await media.evaluate(element => Number.isFinite(element.duration) && element.duration > 0));
    await page.keyboard.press('Escape'); await dialog(page).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.oldRichAudio.paused && !window.oldRichAudio.getAttribute('src')), true);
    assert.ok(requests.length >= 1, 'The native audio element requests the registered audio endpoint'); evidence.requests = requests;
  });
}

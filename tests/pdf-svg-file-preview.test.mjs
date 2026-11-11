import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { syntheticPreviewPdf } from './fixtures/pdf-preview.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cacheDir = `.local/qa/pdf-svg-test-vite-${process.pid}`;
const vite = await createServer({ configFile: false, root, appType: 'custom', cacheDir, esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-pdf', 'dompurify'] }, server: { host: '127.0.0.1', port: 0, hmr: false } });
const harness = '<!doctype html><html><body><div style="width:320px;height:540px;overflow:auto" id="scroll"><div id="root"></div></div><script type="module" src="/tests/fixtures/pdf-svg-preview-client.tsx"></script></body></html>';
vite.middlewares.use(async (request, response, next) => {
  if (request.url === '/preview-fixture') {
    response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(request.url, harness)); return;
  }
  const resource = /^\/assets\/pdfjs\/(cmaps|standard_fonts|wasm)\/([\w.-]+)$/.exec(request.url ?? '');
  if (resource) {
    try { response.end(await readFile(`${root}/node_modules/pdfjs-dist/${resource[1]}/${resource[2]}`)); }
    catch { response.statusCode = 404; response.end(); } return;
  }
  next();
});
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
after(async () => { await vite.close(); await rm(`${root}/${cacheDir}`, { recursive: true, force: true }); });
const [{ default: Pdf }, { default: Svg }, pdf, svg] = await Promise.all([
  vite.ssrLoadModule('/src/PdfFileContent.tsx'), vite.ssrLoadModule('/src/SvgFileContent.tsx'), vite.ssrLoadModule('/src/pdfFilePreview.ts'), vite.ssrLoadModule('/src/svgFilePreview.ts'),
]);

test('PDF and SVG content modules can be imported and rendered without a browser', () => {
  assert.match(renderToStaticMarkup(createElement(Pdf, { blob: new Blob(['%PDF-1.7']) })), /pdf-file-content/);
  assert.match(renderToStaticMarkup(createElement(Svg, { blob: new Blob(['<svg/>']) })), /svg-file-content/);
});

test('PDF byte validation checks signature and bounded reads, and discards cancelled work', async () => {
  const valid = syntheticPreviewPdf();
  assert.deepEqual((await pdf.readPdfPreviewBlob(new Blob([valid]))).data, new Uint8Array(valid));
  await assert.rejects(pdf.readPdfPreviewBlob(new Blob(['<html>%PDF-1.7</html>'])), /有效的 PDF/);
  let reads = 0;
  await assert.rejects(pdf.readPdfPreviewBlob({ size: pdf.maxPdfPreviewBytes + 1, arrayBuffer() { reads++; } }), /较大/);
  assert.equal(reads, 0);
  const controller = new AbortController(); let finish;
  const pending = pdf.readPdfPreviewBlob({ size: valid.length, arrayBuffer() { return new Promise(resolve => { finish = resolve; }); } }, controller.signal);
  controller.abort(); finish(valid.buffer.slice(valid.byteOffset, valid.byteOffset + valid.byteLength));
  await assert.rejects(pending, { name: 'AbortError' });
});

test('PDF canvas plans retain container width while bounding density, dimensions and pixels', () => {
  for (const [width, height, container, ratio] of [[595, 842, 288, 3], [595, 842, 1600, 3], [400, 14000, 1024, 2]]) {
    const plan = pdf.pdfRenderPlan(width, height, container, ratio);
    assert.ok(plan.width <= container && plan.density <= 2);
    assert.ok(plan.width * plan.height * plan.density ** 2 <= pdf.maxPdfCanvasPixels + 0.001);
    assert.ok(plan.width * plan.density <= 4096 && plan.height * plan.density <= 4096);
  }
  for (const size of [[0, 100], [Infinity, 100], [15000, 15000], [1, 1000]]) assert.throws(() => pdf.pdfRenderPlan(...size, 320), /页面尺寸/);
  const selected = pdf.nearbyPdfPages(Array.from({ length: 200 }, (_, index) => ({ top: index * 80, bottom: index * 80 + 80 })), { top: 640, bottom: 1180 });
  assert.equal(selected.length, 5); assert.ok(selected.every(index => index >= 8 && index <= 14));
  const domRect = Object.create({ get top() { return 0; }, get bottom() { return 100; } });
  assert.deepEqual(pdf.nearbyPdfPages([domRect], { top: 0, bottom: 100 }), [0]);
});

test('SVG decoding enforces the byte limit before reading and rejects cancelled or malformed bytes', async () => {
  let reads = 0;
  await assert.rejects(svg.readSvgPreviewBlob({ size: svg.maxSvgPreviewBytes + 1, arrayBuffer() { reads++; } }), /较大/);
  assert.equal(reads, 0);
  await assert.rejects(svg.readSvgPreviewBlob(new Blob([new Uint8Array([0xff, 0x81, 0x80])])), /有效的 SVG/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(svg.readSvgPreviewBlob(new Blob(['<svg/>']), controller.signal), { name: 'AbortError' });
});

test('pinned PDF library and worker share a version and cancellation paths release resources', async () => {
  const library = JSON.parse(await readFile(`${root}/node_modules/react-pdf/package.json`, 'utf8'));
  const engine = JSON.parse(await readFile(`${root}/node_modules/pdfjs-dist/package.json`, 'utf8'));
  assert.equal(library.dependencies['pdfjs-dist'], engine.version);
  for (const path of ['build/pdf.worker.min.mjs', 'cmaps/UniGB-UCS2-H.bcmap', 'standard_fonts/LiberationSans-Regular.ttf']) assert.ok((await stat(`${root}/node_modules/pdfjs-dist/${path}`)).size > 0);
});

test('synthetic SVG and multi-page PDF render locally, preserve language state and clean up on close', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 700 }, deviceScaleFactor: 3 });
  page.setDefaultTimeout(10000);
  const requests = [], errors = [], consoleErrors = [];
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  try {
    await page.addInitScript(() => {
      window.createdWorkers = 0; window.activeWorkers = 0; window.createdUrls = []; window.revokedUrls = []; window.canvases = [];
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        constructor(...args) { super(...args); window.createdWorkers++; window.activeWorkers++; this.closed = false; }
        terminate() { if (!this.closed) { this.closed = true; window.activeWorkers--; } return super.terminate(); }
      };
      const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
      URL.createObjectURL = blob => { const url = create(blob); window.createdUrls.push(url); return url; };
      URL.revokeObjectURL = url => { window.revokedUrls.push(url); revoke(url); };
      const createElement = Document.prototype.createElement;
      Document.prototype.createElement = function(name, ...args) { const element = createElement.call(this, name, ...args); if (name === 'canvas') window.canvases.push(element); return element; };
    });
    await page.goto(origin + '/preview-fixture');
    await page.waitForFunction(() => !!window.previewHarness, null, { timeout: 10000 }).catch(error => {
      throw new Error(`Preview fixture did not initialize: ${JSON.stringify({ errors, consoleErrors, requests })}`, { cause: error });
    });
    const sanitation = await page.evaluate(() => {
      const good = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient><path id="p" d="M0 0H30V30Z"/></defs><use href="#p" fill="url(#g)"/><rect width="60" height="40" style="fill:blue;stroke:red"/></svg>';
      const malicious = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="120" height="80" onload="alert(1)"><script>alert(1)</script><foreignObject><iframe src="https://evil.example"/></foreignObject><style>@import "https://evil.example"</style><animate attributeName="width" values="1;90000"/><image href="/api/tasks/private"/><a href="https://evil.example"><rect/></a><use href="https://evil.example/a.svg#x"/><use xlink:href="file:///etc/private"/><path fill="url(https://evil.example/g)" stroke="url(/api/private)" style="background:url(https://evil.example);fill:red;animation:a 1s"/><path fill="url(&#92;68 ttps://evil.example)"/></svg>';
      const clean = window.previewHarness.sanitize(malicious).source;
      const allowed = window.previewHarness.sanitize(good).source;
      const denied = [];
      for (const source of ['<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private">]><svg xmlns="http://www.w3.org/2000/svg"/>', '<svg xmlns="http://www.w3.org/2000/svg" width="90000"/>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8192 8192"/>', '<svg xmlns="http://www.w3.org/2000/svg"><g></svg>']) {
        try { window.previewHarness.sanitize(source); denied.push(false); } catch { denied.push(true); }
      }
      window.previewHarness.showSvg(good); return { clean, allowed, denied };
    });
    assert.doesNotMatch(sanitation.clean, /script|foreignObject|onload|animate|https:\/\/evil|file:|\/api\/|background|animation/);
    assert.match(sanitation.allowed, /href="#p"/); assert.match(sanitation.allowed, /url\(#g\)/); assert.match(sanitation.allowed, /fill:blue;stroke:red/);
    assert.deepEqual(sanitation.denied, [true, true, true, true]);
    await page.waitForFunction(() => document.querySelector('.svg-file-content img')?.naturalWidth === 120);
    const svgUrl = await page.locator('.svg-file-content img').getAttribute('src');
    await page.evaluate(() => window.previewHarness.locale('en'));
    assert.equal(await page.locator('.svg-file-content img').getAttribute('src'), svgUrl);
    await page.evaluate(() => window.previewHarness.close());
    await page.waitForFunction(url => window.revokedUrls.includes(url), svgUrl);

    await page.evaluate(bytes => window.previewHarness.showPdf(bytes), [...syntheticPreviewPdf()]);
    await page.waitForFunction(() => document.querySelectorAll('.pdf-file-page-slot canvas').length === 3 && [...document.querySelectorAll('.pdf-file-page-slot canvas')].every(canvas => canvas.style.visibility === ''));
    const rendered = await page.evaluate(() => {
      const canvas = document.querySelector('.pdf-file-page-slot canvas'), pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      return { nonwhite: [...pixels].some((value, index) => index % 4 !== 3 && value < 220), workers: window.createdWorkers,
        sizes: [...document.querySelectorAll('.pdf-file-page-slot canvas')].map(canvas => ({ width: canvas.width, height: canvas.height, clientWidth: canvas.getBoundingClientRect().width })) };
    });
    assert.ok(rendered.nonwhite); assert.ok(rendered.workers > 0);
    assert.ok(rendered.sizes.every(size => size.clientWidth <= 320 && size.width * size.height <= pdf.maxPdfCanvasPixels));
    await page.evaluate(() => window.previewHarness.locale('zh'));
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.createdWorkers), rendered.workers);
    await page.evaluate(() => { window.renderedCanvases = [...document.querySelectorAll('.pdf-file-page-slot canvas')]; });
    await page.evaluate(() => window.previewHarness.close());
    await page.waitForFunction(() => window.activeWorkers === 0 && document.querySelectorAll('canvas').length === 0);
    assert.ok(await page.evaluate(() => window.renderedCanvases.every(canvas => canvas.width === 0 && canvas.height === 0)));
    const text = await page.evaluate(bytes => window.previewHarness.extractPdf(bytes), [...syntheticPreviewPdf()]);
    assert.equal(text.length, 3); assert.ok(text.every((value, index) => value.includes(`Pocket PDF page ${index + 1}`) && value.includes('中文测试')));

    await page.evaluate(bytes => window.previewHarness.showPdf(bytes), [...syntheticPreviewPdf({ pages: 203 })]);
    await page.waitForFunction(() => document.querySelectorAll('.pdf-file-page-slot').length === 50 && document.querySelector('canvas')?.style.visibility === '');
    assert.ok(await page.locator('canvas').count() <= 5);
    for (let index = 0; index < 3; index++) await page.locator('.pdf-file-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.pdf-file-page-slot').length === 200);
    await page.evaluate(() => document.getElementById('scroll').scrollTo(0, 20000));
    await page.waitForTimeout(150);
    assert.ok(await page.locator('canvas').count() <= 5);
    await page.evaluate(() => window.previewHarness.close());
    await page.waitForFunction(() => window.activeWorkers === 0);
    await page.evaluate(bytes => { window.holdPdfRendering = true; window.previewHarness.showPdf(bytes); }, [...syntheticPreviewPdf()]);
    await page.waitForFunction(() => window.pendingPdfRenders > 0);
    await page.evaluate(() => { window.renderedCanvases = [...document.querySelectorAll('.pdf-file-page-slot canvas')]; window.previewHarness.close(); });
    await page.waitForFunction(() => window.activeWorkers === 0 && window.pendingPdfRenders === 0);
    assert.ok(await page.evaluate(() => window.cancelledPdfRenders > 0 && window.renderedCanvases.every(canvas => canvas.width === 0 && canvas.height === 0)));
    assert.ok(requests.every(request => request.method === 'GET' && (request.url.startsWith(origin) || request.url.startsWith('blob:' ))));
    assert.doesNotMatch(requests.map(request => request.url).join('\n'), /evil\.example|\/api\/tasks|file:/);
    assert.deepEqual(errors, []);
  } catch (error) {
    const state = await page.evaluate(() => ({ error: window.previewError, content: document.body.textContent?.slice(0, 1000), workers: window.activeWorkers,
      canvases: [...document.querySelectorAll('canvas')].map(canvas => ({ width: canvas.width, height: canvas.height, visibility: canvas.style.visibility, rect: canvas.getBoundingClientRect().toJSON() })),
      slots: [...document.querySelectorAll('.pdf-file-page-slot')].slice(0, 5).map(slot => slot.getBoundingClientRect().toJSON()) }));
    throw new Error(`PDF/SVG browser fixture failed: ${JSON.stringify({ state, errors, consoleErrors, recentRequests: requests.slice(-6) })}`, { cause: error });
  } finally { await browser.close(); }
});

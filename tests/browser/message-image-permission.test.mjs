import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_IMAGE_PERMISSION_REPORT || '.local/qa/local-visual-2026-11-11/frontend/browser-results.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const source = `/api/tasks/${ids.regular}/images/${'a'.repeat(64)}`;
const original = '/synthetic/card.png';
const permission = 'Mac 服务无权读取这张图片，请在电脑上检查文件访问权限';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const words = {
  'zh-CN': { retry: '重试', reason: permission },
  'en-US': { retry: 'Retry', reason: 'The Mac service cannot read this image. Check file access permissions on your computer.' },
};
const install = (h, machine = 'ged') => h.patchHistory(ids.regular, { messages: [{ id: 'permission-picture', role: 'assistant', phase: 'final',
  text: 'Synthetic permission recovery:\n\n![Reading card](<' + original + '>)', images: { [original]: source }, timestamp: Date.now(), turnId: 'permission' }] }, machine);
const decode = page => page.waitForFunction(() => {
  const image = document.querySelector('.message-image-frame img'); return image?.complete && image.naturalWidth === 1;
});
async function failureGeometry(picture) {
  const geometry = await picture.locator('.message-image-failed').evaluate(frame => {
    const box = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
    const text = frame.querySelector('[role="status"]'), range = document.createRange(); range.selectNodeContents(text);
    return { frame: box(frame), button: box(frame.querySelector('button')), lines: [...range.getClientRects()].map(rect =>
      ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })) };
  });
  for (const box of [geometry.button, ...geometry.lines])
    assert.ok(box.left >= geometry.frame.left - 1 && box.right <= geometry.frame.right + 1
      && box.top >= geometry.frame.top - 1 && box.bottom <= geometry.frame.bottom + 1, 'The permission reason and Retry fit inside the fixed image frame');
  return geometry;
}
function flow(engine, locale, width, name, run) {
  test(`${engine}: ${locale} ${width}px ${name}`, { timeout: 20000 }, () => {
    const evidence = {};
    return runScenario({ engine, name: `${locale} ${width}px ${name}`, create: () => createHarness(engine, { locale, width }),
      run: h => run(h, evidence), record: result => results.push({ ...result, evidence }) });
  });
}
for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) for (const width of [320, 390]) {
  flow(engine, locale, width, 'permission reason stays in the image frame and explicit retry decodes the same image', async (h, evidence) => {
    const machine = width === 320 ? 'wandou' : 'ged'; install(h, machine);
    const page = await h.open(null, machine), requests = []; let denied = true;
    await page.route('**/images/' + 'a'.repeat(64), async route => {
      const request = route.request(); requests.push({ path: new URL(request.url()).pathname, type: request.resourceType(), headers: request.headers() });
      await route.fulfill({ status: denied ? 403 : 200, contentType: denied ? 'application/json' : 'image/png',
        headers: { 'Cache-Control': 'no-store', 'X-Pocket-Machine': machine }, body: denied ? JSON.stringify({ error: permission }) : png });
    });
    await page.goto(page.url() + '&task=' + ids.regular);
    const picture = page.locator('.message-image');
    await picture.getByText(words[locale].reason, { exact: true }).waitFor({ timeout: 1500 });
    evidence.failureGeometry = await failureGeometry(picture);
    assert.equal(requests.length, 2, 'One image load and one diagnostic GET; no automatic retry');
    assert.deepEqual(requests.map(request => request.type), ['image', 'fetch']);
    const expectedPath = machine === 'ged' ? source : '/api/machines/' + machine + source.slice(4);
    assert.ok(requests.every(request => request.path === expectedPath), 'Both reads stay on the selected machine and original capability');
    assert.ok(requests[1].headers['x-pocket-client-version'], 'The diagnostic includes the client version');
    const input = page.locator('.conversation-composer textarea'); await input.fill('Unsent synthetic draft');
    await input.evaluate(element => { window.permissionComposer = element; element.setSelectionRange(2, 7);
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'synthetic' })); });
    const otherLanguage = locale === 'zh-CN' ? 'en' : 'zh-CN';
    await page.evaluate(value => { localStorage.setItem('pocket.language.v1', value);
      dispatchEvent(new StorageEvent('storage', { key: 'pocket.language.v1', newValue: value })); }, otherLanguage);
    const changed = locale === 'zh-CN' ? words['en-US'] : words['zh-CN'];
    await picture.getByText(changed.reason, { exact: true }).waitFor();
    evidence.translatedFailureGeometry = await failureGeometry(picture);
    assert.equal(await input.evaluate(element => element === window.permissionComposer && document.activeElement === element && element.selectionStart === 2 && element.selectionEnd === 7), true);
    await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'synthetic' })));
    assert.equal(requests.length, 2, 'Language changes translate the stored reason without another request');
    denied = false; await picture.getByRole('button', { name: changed.retry, exact: true }).click(); await decode(page);
    assert.equal(await picture.locator('.message-image-failed').count(), 0);
    assert.equal(await input.inputValue(), 'Unsent synthetic draft');
    const opener = picture.getByRole('button'); await opener.click();
    await page.locator('dialog[data-image-viewer]').waitFor();
    await page.waitForFunction(() => document.querySelector('dialog[data-image-viewer] img')?.naturalWidth === 1);
    await page.keyboard.press('Escape'); await page.locator('dialog[data-image-viewer]').waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
    evidence.geometry = await picture.evaluate(element => { const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, pageWidth: document.documentElement.scrollWidth, width: window.innerWidth }; });
    assert.ok(evidence.geometry.left >= -1 && evidence.geometry.right <= width + 1 && evidence.geometry.pageWidth <= width + 1);
    assert.ok(requests.every(request => request.path === expectedPath), 'The viewer and retry retain the same registered image');
    evidence.requests = requests.map(({ path, type }) => ({ path, type }));
  });
  flow(engine, locale, width, 'a delayed old diagnostic cannot replace a successful retry', async (h, evidence) => {
    install(h); let release, diagnosticStarted = false, imageReads = 0;
    const delayed = new Promise(done => { release = done; });
    // Model a transport that finishes despite cancellation, so the component's
    // generation guard is tested independently from native AbortController.
    await h.addInitScript(() => { const request = window.fetch.bind(window); window.fetch = (url, options) =>
      String(url).includes('/images/') ? request(url, { ...options, signal: undefined }) : request(url, options); });
    const page = await h.open(null);
    await page.route('**/images/' + 'a'.repeat(64), async route => {
      const request = route.request();
      if (request.resourceType() === 'fetch') { diagnosticStarted = true; await delayed;
        return route.fulfill({ status: 403, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'ged' }, body: JSON.stringify({ error: permission }) }); }
      imageReads++;
      await route.fulfill({ status: imageReads === 1 ? 403 : 200, contentType: imageReads === 1 ? 'application/json' : 'image/png',
        headers: { 'Cache-Control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: imageReads === 1 ? JSON.stringify({ error: permission }) : png });
    });
    try {
      await page.goto(page.url() + '&task=' + ids.regular);
      const retry = page.locator('.message-image').getByRole('button', { name: words[locale].retry, exact: true }); await retry.waitFor();
      const deadline = Date.now() + 1500;
      while (!diagnosticStarted && Date.now() < deadline) await page.waitForTimeout(20);
      assert.equal(diagnosticStarted, true, 'The real component starts a diagnostic after image failure');
      await retry.click(); await decode(page); release(); await page.waitForTimeout(180);
      assert.equal(await page.locator('.message-image-failed').count(), 0, 'The earlier error cannot overwrite successful retry');
      assert.equal(imageReads, 2); evidence.imageReads = imageReads; evidence.lateDiagnosticIgnored = true;
    } finally { release(); }
  });
}
for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) {
  flow(engine, locale, 390, 'a late diagnostic from the previous conversation cannot affect the next image', async (h, evidence) => {
    install(h);
    const nextSrc = `/api/tasks/${ids.empty}/images/${'b'.repeat(64)}`;
    h.patchHistory(ids.empty, { messages: [{ id: 'next-picture', role: 'assistant', phase: 'final', text: '![Next card](<' + original + '>)',
      images: { [original]: nextSrc }, timestamp: Date.now(), turnId: 'next-permission' }] });
    await h.addInitScript(() => { const request = window.fetch.bind(window); window.fetch = (url, options) =>
      String(url).includes('/images/') ? request(url, { ...options, signal: undefined }) : request(url, options); });
    let release, diagnosticStarted = false;
    const delayed = new Promise(done => { release = done; }), page = await h.open(null);
    await page.route('**/images/' + 'a'.repeat(64), async route => {
      if (route.request().resourceType() === 'fetch') { diagnosticStarted = true; await delayed; }
      await route.fulfill({ status: 403, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'ged' }, body: JSON.stringify({ error: permission }) });
    });
    await page.route('**/images/' + 'b'.repeat(64), route => route.fulfill({ status: 200, contentType: 'image/png',
      headers: { 'Cache-Control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: png }));
    try {
      await page.goto(page.url() + '&task=' + ids.regular);
      await page.locator('.message-image').getByRole('button', { name: words[locale].retry, exact: true }).waitFor();
      const deadline = Date.now() + 1500;
      while (!diagnosticStarted && Date.now() < deadline) await page.waitForTimeout(20);
      assert.equal(diagnosticStarted, true);
      await page.locator('[data-inspector-close]').click(); await page.locator('.inspector').waitFor({ state: 'detached' });
      await page.locator(`[data-thread-id="${ids.empty}"]`).click(); await decode(page);
      release(); await page.waitForTimeout(180);
      assert.equal(await page.locator('.message-image-failed').count(), 0);
      assert.equal(await page.locator('.message-image-frame img').getAttribute('src'), nextSrc);
      assert.equal(await page.locator('[data-message-id="next-picture"]').count(), 1); evidence.previousConversationIgnored = true;
    } finally { release(); }
  });
}

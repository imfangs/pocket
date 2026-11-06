import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_HTML_PREVIEW_REPORT || '.local/qa/browser-html-preview/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const words = {
  'zh-CN': { preview: '预览', source: '源码', close: '关闭文件预览', retry: '重试' },
  'en-US': { preview: 'Preview', source: 'Source', close: 'Close file preview', retry: 'Retry' },
};
const name = 'a-synthetic-document-for-mobile-preview.html';
const key = 'b'.repeat(64), imagePath = 'images/approved-card.png';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const regularHtml = `<!doctype html><html lang="zh-CN" data-theme="authored"><head><meta charset="utf-8"><title>Synthetic document</title>
<style>body{margin:0;color:#123456;background:#eef2ff;font:16px/1.5 system-ui}article{padding:20px}h1{font-size:24px}img{display:block}#spacer{height:1400px}</style></head>
<body class="authored-page"><article><h1>Rendered synthetic heading</h1><img id="approved" src="${imagePath}" alt="Approved synthetic image" width="1" height="1">
<details><summary>Native details</summary><p>Native details still work.</p></details><a id="fragment" href="#last">Read the footer</a>
<div id="spacer"></div><p id="last">Synthetic footer</p></article></body></html>`;

function flow(engine, locale, width, title, run) {
  test(`${engine}: ${locale} ${width}px ${title}`, { timeout: 30000 }, () => runScenario({ engine, name: `${locale} ${width}px ${title}`,
    create: () => createHarness(engine, { locale, width, safeFrameServiceWorkers: true }), run, record: result => results.push(result) }));
}
const bundle = (bytes, images = { [imagePath]: { type: 'image/png', base64: png } }) => ({
  schemaVersion: 1, name, sourceBase64: Buffer.from(bytes).toString('base64'), images, omittedImages: 0,
});
async function installFile(h, source, { previewStatus = () => 200, payload, original = Buffer.from(source), responseDelay } = {}) {
  const path = '/synthetic/' + name, file = { url: `/api/tasks/${ids.regular}/files/${key}`, name };
  h.patchHistory(ids.regular, { messages: [{ id: 'html-file', role: 'assistant', phase: 'final', turnId: 'initial', timestamp: Date.now(),
    text: `[Synthetic HTML document](<${path}>)`, files: { [path]: file } }] });
  const page = await h.open(), requests = [];
  assert.equal(await page.evaluate(async () => {
    const worker = navigator.serviceWorker;
    await worker.register('/synthetic-should-never-register-worker.js');
    return (await worker.getRegistrations()).length;
  }), 0, 'The opaque-frame fixture still prevents every actual service worker registration');
  await page.route(`**/files/${key}/preview`, async route => {
    const request = route.request(); assert.equal(request.method(), 'GET');
    assert.equal(new URL(request.url()).search, '', 'The client cannot provide an independent resource path');
    requests.push({ preview: true, method: request.method() });
    const status = previewStatus(requests.filter(item => item.preview).length);
    if (responseDelay) await responseDelay;
    try {
      await route.fulfill({ status, contentType: 'application/json', headers: { 'X-Pocket-Machine': new URL(page.url()).searchParams.get('machine'), 'Cache-Control': 'no-store' },
        body: JSON.stringify(status === 200 ? payload || bundle(original) : { error: '合成预览读取失败，请重试。' }) });
    } catch { requests.at(-1).aborted = true; }
  });
  await page.route(`**/files/${key}`, async route => {
    assert.equal(route.request().method(), 'GET'); requests.push({ preview: false, method: route.request().method() });
    await route.fulfill({ status: 200, contentType: 'application/octet-stream',
      headers: { 'X-Pocket-Machine': new URL(page.url()).searchParams.get('machine'), 'Content-Disposition': 'attachment' }, body: original });
  });
  return { page, file, requests, opener: page.locator('.message-file-button'), dialog: page.locator('dialog.text-file-viewer'), original };
}
async function captureDownloads(page) {
  await page.evaluate(() => {
    window.htmlPreviewDownloads = [];
    const create = URL.createObjectURL.bind(URL), click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = blob => {
      window.htmlPreviewDownloads.push({ blob });
      return create(blob);
    };
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.htmlPreviewDownloads.at(-1).name = this.download; return; }
      return click.call(this);
    };
  });
}
async function downloadedBytes(page) {
  await page.waitForFunction(() => window.htmlPreviewDownloads?.length === 1);
  return page.evaluate(async () => {
    const download = window.htmlPreviewDownloads[0];
    return { name: download.name, bytes: Array.from(new Uint8Array(await download.blob.arrayBuffer())) };
  });
}
const frameContent = page => page.frameLocator('dialog.text-file-viewer iframe');
async function readFrame(page) {
  const iframe = page.locator('dialog.text-file-viewer iframe'); await iframe.waitFor();
  await frameContent(page).getByRole('heading', { name: 'Rendered synthetic heading', exact: true }).waitFor();
  return iframe;
}
async function closePreview(page, locale) {
  await page.getByRole('button', { name: words[locale].close, exact: true }).click();
  await page.locator('dialog.text-file-viewer').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.matches('.message-file-button'));
}

for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) for (const width of [320, 390]) {
  flow(engine, locale, width, 'HTML opens as an isolated styled page and source/download reuse the original bytes', async h => {
    const bytes = Buffer.from('\ufeff' + regularHtml), f = await installFile(h, regularHtml, { original: bytes });
    const input = f.page.locator('.conversation-composer textarea');
    await input.fill('Keep this unsent synthetic draft.'); await input.blur();
    await input.evaluate(element => { window.htmlPreviewDraft = element; });
    await captureDownloads(f.page); await f.opener.click();
    const iframe = await readFrame(f.page), modes = f.dialog.locator('.html-file-modes');
    assert.equal(await iframe.getAttribute('sandbox'), '');
    assert.equal(await iframe.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(await iframe.evaluate(element => element.classList.contains('ph-no-capture') && !!element.closest('.ph-no-capture')), true);
    assert.ok((await iframe.getAttribute('title')).includes(name));
    assert.equal(await modes.getByRole('button', { name: words[locale].preview, exact: true }).getAttribute('aria-pressed'), 'true');
    const image = frameContent(f.page).locator('#approved');
    await image.evaluate(element => element.decode());
    assert.equal(await image.evaluate(element => element.naturalWidth), 1);
    const styles = await frameContent(f.page).locator('body').evaluate(element => ({ color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor, authored: element.className, root: element.ownerDocument.documentElement.dataset.theme }));
    assert.deepEqual(styles, { color: 'rgb(18, 52, 86)', background: 'rgb(238, 242, 255)', authored: 'authored-page', root: 'authored' });
    await frameContent(f.page).getByText('Native details', { exact: true }).click();
    assert.equal(await frameContent(f.page).locator('details').getAttribute('open'), '');
    await iframe.evaluate(element => { window.htmlPreviewFrame = element; });
    await frameContent(f.page).locator('body').evaluate(element => element.ownerDocument.defaultView.scrollTo(0, 300));
    const beforeScroll = await frameContent(f.page).locator('body').evaluate(element => element.ownerDocument.defaultView.scrollY);
    await modes.getByRole('button', { name: words[locale].source, exact: true }).click();
    assert.equal(await f.dialog.locator('.html-file-source pre').textContent(), regularHtml);
    assert.equal(await f.dialog.locator('.html-file-source script').count(), 0);
    assert.equal(await iframe.evaluate(element => element === window.htmlPreviewFrame), true);
    await modes.getByRole('button', { name: words[locale].preview, exact: true }).click();
    assert.equal(await iframe.evaluate(element => element === window.htmlPreviewFrame), true);
    assert.equal(await frameContent(f.page).locator('body').evaluate(element => element.ownerDocument.defaultView.scrollY), beforeScroll);
    assert.equal(f.requests.length, 1, 'Mode changes do not reread the HTML or its image bundle');
    const switched = locale === 'zh-CN' ? 'en' : 'zh-CN', switchedWords = words[locale === 'zh-CN' ? 'en-US' : 'zh-CN'];
    await f.page.evaluate(value => {
      localStorage.setItem('pocket.language.v1', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'pocket.language.v1', newValue: value }));
      window.dispatchEvent(new CustomEvent('pocket-set-theme', { detail: 'dark' }));
    }, switched);
    await modes.getByRole('button', { name: switchedWords.source, exact: true }).waitFor();
    assert.equal(await iframe.evaluate(element => element === window.htmlPreviewFrame), true);
    assert.equal(f.requests.length, 1, 'Appearance and language changes do not restart file reads');
    const geometry = await f.dialog.evaluate(element => [...element.querySelectorAll('.text-file-toolbar button,.html-file-modes button')].map(button => {
      const box = button.getBoundingClientRect(), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { left: box.left, right: box.right, width: box.width, height: box.height, hit: button.contains(hit) };
    }));
    assert.ok(geometry.every(box => box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= width && box.hit));
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await f.dialog.locator('.text-file-toolbar button').first().click();
    const download = await downloadedBytes(f.page);
    assert.equal(download.name, name); assert.deepEqual(Buffer.from(download.bytes), bytes);
    assert.equal(f.requests.length, 1, 'Downloading uses original HTML bytes, never bundle JSON or another GET');
    await closePreview(f.page, locale === 'zh-CN' ? 'en-US' : 'zh-CN');
    assert.equal(await input.inputValue(), 'Keep this unsent synthetic draft.');
    assert.equal(await input.evaluate(element => element === window.htmlPreviewDraft), true);
    assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'), 'Preview operations cannot create a turn or send a query');
  });
}

const hostileHtml = `<!doctype html><html><head><title>Hostile synthetic document</title><meta http-equiv="refresh" content="0;url=https://preview-attack.invalid/refresh">
<base href="https://preview-attack.invalid/"><link rel="stylesheet" href="https://preview-attack.invalid/style"><style>@import url('https://preview-attack.invalid/import');body{background-image:url('/api/private-css')}h1{color:#123456}</style></head>
<body onload="parent.htmlParentMarker='changed'"><h1>Rendered synthetic heading</h1><script>parent.htmlParentMarker='changed';fetch('https://preview-attack.invalid/script');top.location='https://preview-attack.invalid/top'</script>
<img src="/api/private-image" srcset="https://preview-attack.invalid/srcset 2x" onerror="parent.htmlParentMarker='changed'">
<iframe src="https://preview-attack.invalid/frame" srcdoc="<script>parent.alert(1)</script>"></iframe><object data="https://preview-attack.invalid/object"></object>
<noscript><a id="noscript-attack" href="/api/private-noscript">Noscript link</a><img src="https://preview-attack.invalid/noscript"></noscript>
<template shadowrootmode="open"><a href="/api/private-template">Template link</a><iframe src="https://preview-attack.invalid/template"></iframe></template>
<form action="/api/private-form" method="post"><input id="fake-input" name="query"><button id="fake-submit" formaction="https://preview-attack.invalid/submit">Submit</button></form>
<a id="external-attack" href="https://preview-attack.invalid/link" ping="https://preview-attack.invalid/ping" target="_top" download>External link</a>
<svg width="240" height="60"><a id="smil-attack" href="#safe"><set attributeName="href" to="/api/private-smil" begin="0s"></set><text x="10" y="30">SMIL link</text></a><image href="https://preview-attack.invalid/svg-image"></image></svg>
<details><summary>Native details</summary><p>Native details still work.</p></details><p id="safe">Safe anchor</p></body></html>`;

for (const engine of engines) {
  flow(engine, 'en-US', 390, 'hostile HTML stays inert, opaque and inside its document without external or private requests', async h => {
    const f = await installFile(h, hostileHtml, { payload: bundle(Buffer.from(hostileHtml), {}) });
    await f.page.evaluate(() => { window.htmlParentMarker = 'intact'; });
    const cookieSentinel = 'synthetic-parent-cookie-4ac519';
    assert.ok((await f.page.evaluate(value => {
      document.cookie = `htmlPreviewParent=${value}; Path=/; SameSite=Lax; Secure`;
      return document.cookie;
    }, cookieSentinel)).includes(cookieSentinel), 'The parent cookie must exist as a positive control');
    const pageUrl = f.page.url(); await f.opener.click(); const iframe = await readFrame(f.page), frame = frameContent(f.page);
    assert.equal(await frame.locator('script,base,link,iframe,object,embed,svg set,svg animate').count(), 0);
    const policies = frame.locator('meta[http-equiv]');
    assert.equal(await policies.count(), 1, 'Only the generated restrictive CSP may survive');
    assert.equal((await policies.getAttribute('http-equiv')).toLowerCase(), 'content-security-policy');
    assert.ok((await policies.getAttribute('content')).includes("script-src 'none'"));
    assert.equal(await frame.locator('#fake-input').isDisabled(), true);
    assert.equal(await frame.locator('#fake-submit').isDisabled(), true);
    assert.equal(await frame.locator('#external-attack').getAttribute('href'), null);
    assert.equal(await frame.locator('#external-attack').getAttribute('ping'), null);
    await frame.locator('#external-attack').click();
    await frame.locator('#smil-attack').click();
    await frame.getByText('Native details', { exact: true }).click();
    await f.page.waitForTimeout(150);
    assert.equal(f.page.url(), pageUrl);
    assert.equal(await f.page.evaluate(() => window.htmlParentMarker), 'intact');
    assert.equal(await iframe.evaluate(element => { try { void element.contentWindow.document.body; return false; } catch { return true; } }), true,
      'The file document cannot share the parent origin or credentials');
    const cookie = await frame.locator('body').evaluate(element => {
      try { return { denied: false, value: element.ownerDocument.cookie }; }
      catch { return { denied: true, value: '' }; }
    });
    assert.ok(cookie.denied || !cookie.value.includes(cookieSentinel), 'The iframe cannot read the actual parent cookie');
    assert.equal(f.requests.length, 1); assert.deepEqual(h.unexpected, []);
    await f.dialog.locator('.html-file-modes').getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(await f.dialog.locator('.html-file-source pre').textContent(), hostileHtml);
    assert.equal(await f.dialog.locator('.html-file-source script').count(), 0);
    await closePreview(f.page, 'en-US');
  });

  flow(engine, 'en-US', 1280, 'real replay snapshots block private srcdoc and source while recording a public control', async h => {
    const sentinel = 'SYNTHETIC-PRIVATE-HTML-CONTENT-7b32e91c', source = regularHtml.replace('Rendered synthetic heading', `Rendered synthetic heading</h1><p>${sentinel}</p><h1>`);
    const f = await installFile(h, source);
    const recorder = readFileSync(new URL('../../node_modules/posthog-js/dist/rrweb.js', import.meta.url));
    await f.page.route('**/synthetic-html-recorder.mjs', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: recorder }));
    await f.page.evaluate(async () => {
      const recorder = await import('/synthetic-html-recorder.mjs');
      const control = document.createElement('div'); control.setAttribute('data-html-recording-control', 'public-control-was-recorded'); document.body.append(control);
      window.htmlReplayEvents = [];
      window.htmlReplayRecorder = recorder;
      window.htmlReplayStop = recorder.record({ emit: event => window.htmlReplayEvents.push(event), blockClass: 'ph-no-capture',
        maskAllInputs: true, maskTextSelector: '*', recordCrossOriginIframes: false });
    });
    try {
      await f.opener.click(); await readFrame(f.page);
      await f.page.evaluate(() => window.htmlReplayRecorder.takeFullSnapshot());
      await f.dialog.locator('.html-file-modes').getByRole('button', { name: 'Source', exact: true }).click();
      await f.dialog.locator('.html-file-source pre').waitFor();
      await f.page.evaluate(() => window.htmlReplayRecorder.takeFullSnapshot());
      await f.page.waitForTimeout(100);
      const snapshots = await f.page.evaluate(() => JSON.stringify(window.htmlReplayEvents));
      assert.ok(snapshots.includes('public-control-was-recorded'), 'This must be an active real recorder, not an empty mock');
      assert.ok(snapshots.includes('ph-no-capture'));
      assert.equal(snapshots.includes(sentinel), false, 'Neither initial srcdoc attributes nor the source view may enter replay');
      assert.equal(snapshots.includes('sourceBase64'), false);
      assert.equal(snapshots.includes(png), false, 'Embedded private image bytes cannot enter replay');
      assert.equal(f.requests.length, 1);
    } finally { await f.page.evaluate(() => window.htmlReplayStop?.()); }
  });

  flow(engine, 'zh-CN', 320, 'an older Mac falls back to the original read and still supports source and exact download', async h => {
    const f = await installFile(h, regularHtml, { previewStatus: () => 404 });
    await captureDownloads(f.page); await f.opener.click(); await readFrame(f.page);
    assert.deepEqual(f.requests.map(item => item.preview), [true, false]);
    assert.equal(await f.dialog.locator('.html-file-note').count(), 1);
    await f.dialog.locator('.html-file-modes').getByRole('button', { name: '源码', exact: true }).click();
    assert.equal(await f.dialog.locator('.html-file-source pre').textContent(), regularHtml);
    await f.dialog.locator('.text-file-toolbar button').first().click();
    assert.deepEqual(Buffer.from((await downloadedBytes(f.page)).bytes), Buffer.from(regularHtml));
    assert.equal(f.requests.length, 2);
    await closePreview(f.page, 'zh-CN');
  });

  flow(engine, 'zh-CN', 390, 'a failed HTML read retries in place and a late closed read cannot recreate the viewer', async h => {
    const f = await installFile(h, regularHtml, { previewStatus: attempt => attempt === 1 ? 503 : 200 });
    await f.opener.click(); await f.dialog.getByRole('alert').waitFor();
    assert.equal(await f.dialog.locator('iframe').count(), 0);
    await f.dialog.getByRole('button', { name: '重试', exact: true }).click(); await readFrame(f.page);
    assert.equal(f.requests.length, 2);
    await closePreview(f.page, 'zh-CN');
    let release;
    const gate = new Promise(done => { release = done; });
    await f.page.route(`**/files/${key}/preview`, async route => {
      await gate;
      try { await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'ged' }, body: JSON.stringify(bundle(Buffer.from(regularHtml))) }); } catch { /* The owning read is intentionally aborted on close. */ }
    });
    try {
      await f.opener.click(); await f.dialog.getByRole('status').waitFor();
      await closePreview(f.page, 'zh-CN'); release(); await f.page.waitForTimeout(150);
      assert.equal(await f.page.locator('dialog.text-file-viewer').count(), 0);
      assert.equal(await f.page.locator('.inspector').count(), 1);
    } finally { release(); }
  });

  flow(engine, 'en-US', 390, 'preview limits preserve the independent original download instead of saving an error bundle', async h => {
    const original = Buffer.from('<!doctype html><html><body>' + 'x'.repeat(1024 * 1024) + '</body></html>');
    const f = await installFile(h, '', { original, previewStatus: () => 413 });
    await captureDownloads(f.page); await f.opener.click(); await f.dialog.getByRole('alert').waitFor();
    assert.equal(await f.dialog.locator('iframe').count(), 0);
    await f.dialog.locator('.text-file-toolbar button').first().click();
    const download = await downloadedBytes(f.page);
    assert.equal(download.name, name); assert.deepEqual(Buffer.from(download.bytes), original);
    assert.deepEqual(f.requests.map(item => item.preview), [true, false, false], 'The bounded source fallback fails before the separate full download');
    await closePreview(f.page, 'en-US');
  });
}

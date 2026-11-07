import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
import pocketWorker from '../../edge/worker.mjs';
import { htmlPreviewSandbox, htmlPreviewShellPath, interactiveHtmlPolicy } from '../../shared/html-runtime-policy.mjs';

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
<select id="category" onchange="applyFilters()"><option value="all">All</option><option value="work">Work</option><option value="hobby">Hobby</option></select>
<input id="search" placeholder="Search synthetic cards"><p id="count"></p><section id="cards">
<p data-category="work" data-search="alpha">Alpha</p><p data-category="work" data-search="beta">Beta</p><p data-category="hobby" data-search="chess">Chess</p></section>
<button id="inline-event" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Inline event</button>
<input id="escape-guard" aria-label="Author handled Escape"><p id="escape-result"></p>
<button id="open-native-dialog" onclick="document.querySelector('#own-dialog').showModal()">Open guest dialog</button>
<dialog id="own-dialog"><p>Guest native dialog</p><button onclick="this.closest('dialog').close()">Close guest dialog</button></dialog>
<div id="spacer"></div><p id="last">Synthetic footer</p></article><script>
window.previewBootCount=(window.previewBootCount||0)+1;
function applyFilters(){let n=0;const group=document.querySelector('#category').value,q=document.querySelector('#search').value.trim().toLowerCase();for(const card of document.querySelectorAll('#cards p')){card.hidden=!((group==='all'||card.dataset.category===group)&&card.dataset.search.includes(q));if(!card.hidden)n++}document.querySelector('#count').textContent=String(n)}
document.querySelector('#search').addEventListener('input',applyFilters);applyFilters();document.body.dataset.started='yes';
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&event.target.id==='escape-guard'){event.preventDefault();document.querySelector('#escape-result').textContent='Consumed by author'}});
</script></body></html>`;

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
  const page = await h.open(), requests = [], shellRequests = [], shellResponses = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === htmlPreviewShellPath) shellRequests.push({ method: request.method(), hash: url.hash, query: url.search, data: request.postData() });
  });
  page.on('response', response => {
    if (new URL(response.url()).pathname === htmlPreviewShellPath) shellResponses.push(response.headers()['content-security-policy']);
  });
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
  return { page, file, requests, shellRequests, shellResponses, opener: page.locator('.message-file-button'), dialog: page.locator('dialog.text-file-viewer'), original };
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
  flow(engine, locale, width, 'interactive HTML filters and inline events work while source/download reuse the original bytes', async h => {
    const bytes = Buffer.from('\ufeff' + regularHtml), f = await installFile(h, regularHtml, { original: bytes });
    const input = f.page.locator('.conversation-composer textarea');
    await input.fill('Keep this unsent synthetic draft.'); await input.blur();
    await input.evaluate(element => { window.htmlPreviewDraft = element; });
    await captureDownloads(f.page); await f.opener.click();
    const iframe = await readFrame(f.page), modes = f.dialog.locator('.html-file-modes');
    assert.equal(await iframe.getAttribute('sandbox'), htmlPreviewSandbox);
    assert.equal(await iframe.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(await iframe.evaluate(element => element.classList.contains('ph-no-capture') && !!element.closest('.ph-no-capture')), true);
    assert.ok((await iframe.getAttribute('title')).includes(name));
    assert.ok((await iframe.getAttribute('src')).startsWith(htmlPreviewShellPath + '#'));
    assert.equal(await iframe.getAttribute('srcdoc'), null, 'The document travels only through the bound client-memory handshake');
    assert.deepEqual(f.shellRequests, [{ method: 'GET', hash: '', query: '', data: null }], 'No HTML content or handshake nonce is uploaded with the public shell');
    assert.deepEqual(f.shellResponses, [interactiveHtmlPolicy], 'The exact shell receives the actual Worker policy while Pocket keeps its own CSP');
    assert.equal(await modes.getByRole('button', { name: words[locale].preview, exact: true }).getAttribute('aria-pressed'), 'true');
    const image = frameContent(f.page).locator('#approved');
    await image.evaluate(element => element.decode());
    assert.equal(await image.evaluate(element => element.naturalWidth), 1);
    const styles = await frameContent(f.page).locator('body').evaluate(element => ({ color: getComputedStyle(element).color,
      background: getComputedStyle(element).backgroundColor, authored: element.className, root: element.ownerDocument.documentElement.dataset.theme }));
    assert.deepEqual(styles, { color: 'rgb(18, 52, 86)', background: 'rgb(238, 242, 255)', authored: 'authored-page', root: 'authored' });
    await frameContent(f.page).locator('body[data-started="yes"]').waitFor();
    assert.equal(await frameContent(f.page).locator('#count').textContent(), '3');
    await frameContent(f.page).locator('#category').selectOption('work');
    assert.equal(await frameContent(f.page).locator('#count').textContent(), '2');
    await frameContent(f.page).locator('#search').fill('chess');
    assert.equal(await frameContent(f.page).locator('#count').textContent(), '0');
    await frameContent(f.page).locator('#category').selectOption('all');
    assert.equal(await frameContent(f.page).locator('#count').textContent(), '1');
    await frameContent(f.page).locator('#inline-event').click();
    assert.equal(await frameContent(f.page).locator('#inline-event').getAttribute('data-clicks'), '1');
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
    assert.equal(await frameContent(f.page).locator('#search').inputValue(), 'chess');
    assert.equal(await frameContent(f.page).locator('#count').textContent(), '1');
    assert.equal(await frameContent(f.page).locator('body').evaluate(element => element.ownerDocument.defaultView.previewBootCount), 1);
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

const assetOrigin = 'https://html-preview-assets.test';
const isolationHtml = `<!doctype html><html><head><title>Interactive isolation document</title>
<link rel="stylesheet" href="${assetOrigin}/style.css"><script src="${assetOrigin}/library.js"></script></head><body>
<h1>Rendered synthetic heading</h1><p id="remote-style">Remote CSS</p><img id="remote-image" src="${assetOrigin}/image.png" alt="Remote approved fixture image">
<input id="editable" value="Editable"><button id="inline-button" onclick="this.dataset.clicked='yes'">Inline button</button>
<button id="api-button" onclick="probeApi()">Try Pocket API</button><a id="top-link" href="${assetOrigin}/forbidden-top" target="_top">Try top navigation</a>
<button id="popup-button" onclick="window.open('${assetOrigin}/popup','preview-popup')">Open normal popup</button>
<p id="isolated-probes">Loading</p><p id="api-result">Waiting</p>
<script>
function attempt(run){try{return{denied:false,value:run()}}catch{return{denied:true,value:''}}}
window.isolationProbes={parent:attempt(()=>parent.document.querySelector('#html-parent-control').textContent),cookie:attempt(()=>document.cookie),storage:attempt(()=>localStorage.getItem('html-preview-parent-storage'))};
document.querySelector('#isolated-probes').textContent='Ready';
async function probeApi(){try{const response=await fetch('https://pocket.test/api/tasks/${ids.regular}/name',{credentials:'include'});window.privateApiStatus=response.status;window.privateApiResult=await response.text()}catch{window.privateApiResult='blocked'}document.querySelector('#api-result').textContent='Finished'}
</script></body></html>`;

for (const engine of engines) {
  flow(engine, 'en-US', 390, 'ordinary inline and HTTPS resources work while the opaque guest cannot read Pocket state or API', async h => {
    const f = await installFile(h, isolationHtml, { payload: bundle(Buffer.from(isolationHtml), {}) });
    const assetRequests = [], apiRequests = [];
    await f.page.context().route(assetOrigin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      assert.equal(route.request().method(), 'GET'); assetRequests.push(path);
      if (path === '/library.js') return route.fulfill({ status: 200, contentType: 'application/javascript', body: "window.cdnLibraryLoaded='yes'" });
      if (path === '/style.css') return route.fulfill({ status: 200, contentType: 'text/css', body: '#remote-style{color:rgb(21,43,65)}' });
      if (path === '/image.png') return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(png, 'base64') });
      if (path === '/popup') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><h1>Normal preview popup</h1>' });
      if (path === '/forbidden-top') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><h1>Converted top link popup</h1>' });
      assert.fail('Only deliberately requested fixture resources can load: ' + path);
    });
    let upstreamReads = 0;
    await f.page.route(`**/api/tasks/${ids.regular}/name`, async route => {
      const request = route.request(), headers = await request.allHeaders();
      apiRequests.push({ method: request.method(), origin: headers.origin, site: headers['sec-fetch-site'] });
      const response = await pocketWorker.fetch(new Request(request.url(), { method: request.method(), headers }), {
        NAVIGATOR_PUBLIC_ORIGIN: 'https://pocket.test', NAVIGATOR_REGISTRATION_SHA256: 'a'.repeat(64),
        NAVIGATOR_CONNECTION: { get: async () => { upstreamReads++; assert.fail('An opaque request cannot reach the authenticated upstream'); } },
      });
      assert.equal(response.status, 403, 'Use the actual Worker Origin policy, not a permissive API stub');
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    const cookieSentinel = 'synthetic-parent-cookie-4ac519', storageSentinel = 'synthetic-parent-storage-c79a82', parentSentinel = 'synthetic-parent-document-529bc3';
    const parentCookie = await f.page.evaluate(({ cookie, storage, parent }) => {
      document.cookie = `htmlPreviewParent=${cookie}; Path=/; SameSite=Lax; Secure`;
      localStorage.setItem('html-preview-parent-storage', storage);
      const control = document.createElement('div'); control.id = 'html-parent-control'; control.textContent = parent; document.body.append(control);
      return document.cookie;
    }, { cookie: cookieSentinel, storage: storageSentinel, parent: parentSentinel });
    assert.ok(parentCookie.includes(cookieSentinel), 'The parent cookie must exist as a positive control');
    const pageUrl = f.page.url(); await f.opener.click(); const iframe = await readFrame(f.page), frame = frameContent(f.page);
    await frame.locator('#isolated-probes').getByText('Ready', { exact: true }).waitFor();
    assert.equal(await iframe.getAttribute('sandbox'), htmlPreviewSandbox);
    assert.equal(await frame.locator('body').evaluate(element => element.ownerDocument.defaultView.cdnLibraryLoaded), 'yes');
    assert.equal(await frame.locator('#remote-style').evaluate(element => getComputedStyle(element).color), 'rgb(21, 43, 65)');
    await frame.locator('#remote-image').evaluate(element => element.decode());
    assert.equal(await frame.locator('#remote-image').evaluate(element => element.naturalWidth), 1);
    await frame.locator('#editable').fill('Updated in the guest');
    assert.equal(await frame.locator('#editable').inputValue(), 'Updated in the guest');
    await frame.locator('#inline-button').click(); assert.equal(await frame.locator('#inline-button').getAttribute('data-clicked'), 'yes');
    const probes = await frame.locator('body').evaluate(element => element.ownerDocument.defaultView.isolationProbes);
    assert.ok(probes.parent.denied || probes.parent.value !== parentSentinel);
    assert.ok(probes.cookie.denied || !probes.cookie.value.includes(cookieSentinel));
    assert.ok(probes.storage.denied || probes.storage.value !== storageSentinel);
    assert.equal(await iframe.evaluate(element => { try { void element.contentWindow.document.body; return false; } catch { return true; } }), true);
    await frame.locator('#api-button').click(); await frame.locator('#api-result').getByText('Finished', { exact: true }).waitFor();
    const apiResult = await frame.locator('body').evaluate(element => ({ status: element.ownerDocument.defaultView.privateApiStatus,
      result: element.ownerDocument.defaultView.privateApiResult }));
    assert.ok(apiResult.result === 'blocked' || apiResult.status === 403, 'A browser may expose a rejection body, but never an authenticated API result');
    assert.equal(apiRequests.length, 1); assert.equal(apiRequests[0].origin, 'null'); assert.equal(upstreamReads, 0);
    assert.equal(await frame.locator('#top-link').getAttribute('target'), '_blank', 'Authored top navigation becomes an ordinary external window');
    const convertedPromise = f.page.waitForEvent('popup'); await frame.locator('#top-link').click(); const converted = await convertedPromise;
    try { await converted.getByRole('heading', { name: 'Converted top link popup', exact: true }).waitFor(); } finally { await converted.close(); }
    assert.equal(f.page.url(), pageUrl);
    const popupPromise = f.page.waitForEvent('popup'); await frame.locator('#popup-button').click(); const popup = await popupPromise;
    try { await popup.getByRole('heading', { name: 'Normal preview popup', exact: true }).waitFor(); } finally { await popup.close(); }
    assert.ok(assetRequests.includes('/library.js') && assetRequests.includes('/style.css') && assetRequests.includes('/image.png') && assetRequests.includes('/popup'));
    assert.ok(assetRequests.includes('/forbidden-top'));
    assert.equal(f.requests.length, 1); assert.deepEqual(h.unexpected, []);
    await f.dialog.locator('.html-file-modes').getByRole('button', { name: 'Source', exact: true }).click();
    assert.equal(await f.dialog.locator('.html-file-source pre').textContent(), isolationHtml);
    assert.equal(await f.dialog.locator('.html-file-source script').count(), 0);
    await closePreview(f.page, 'en-US');
  });

  flow(engine, 'en-US', 1280, 'real replay snapshots block private interactive HTML and source while recording a public control', async h => {
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
      assert.equal(snapshots.includes(sentinel), false, 'Neither interactive document contents nor the source view may enter replay');
      assert.equal(snapshots.includes('sourceBase64'), false);
      assert.equal(snapshots.includes(png), false, 'Embedded private image bytes cannot enter replay');
      assert.equal(f.requests.length, 1);
    } finally { await f.page.evaluate(() => window.htmlReplayStop?.()); }
  });

  flow(engine, 'en-US', 390, 'only the matching guest can close the preview and Escape restores the file entry', async h => {
    const f = await installFile(h, regularHtml); await f.opener.click(); const iframe = await readFrame(f.page);
    await frameContent(f.page).locator('body[data-started="yes"]').waitFor();
    const nonce = (await iframe.getAttribute('src')).split('#')[1];
    assert.match(nonce, /^[a-f0-9]{32}$/i);
    await f.page.evaluate(value => window.dispatchEvent(new MessageEvent('message', {
      origin: 'null', source: window, data: { type: 'pocket-html-preview-close', nonce: value },
    })), nonce);
    await frameContent(f.page).locator('body').evaluate(element => element.ownerDocument.defaultView.parent.postMessage({
      type: 'pocket-html-preview-close', nonce: '0'.repeat(32),
    }, 'https://pocket.test'));
    await f.page.waitForTimeout(100); assert.equal(await f.dialog.count(), 1, 'Source and nonce mismatches cannot drive host UI');
    const guest = frameContent(f.page);
    await guest.locator('#escape-guard').focus(); await f.page.keyboard.press('Escape');
    await guest.locator('#escape-result').getByText('Consumed by author', { exact: true }).waitFor();
    await f.page.waitForTimeout(100); assert.equal(await f.dialog.count(), 1, 'An authored Escape handler keeps the host preview open');
    await guest.locator('#open-native-dialog').click(); await guest.locator('#own-dialog[open]').waitFor();
    await f.page.keyboard.press('Escape'); await guest.locator('#own-dialog').waitFor({ state: 'hidden' });
    await f.page.waitForTimeout(100); assert.equal(await f.dialog.count(), 1, 'Escape closes only the guest native dialog');
    await frameContent(f.page).locator('#inline-event').focus(); await f.page.keyboard.press('Escape');
    await f.dialog.waitFor({ state: 'detached' });
    await f.page.waitForFunction(() => document.activeElement?.matches('.message-file-button'));
    assert.equal(f.requests.length, 1);
  });

  flow(engine, 'zh-CN', 320, 'an older Mac falls back to the original read and still supports source and exact download', async h => {
    const f = await installFile(h, regularHtml, { previewStatus: () => 404 });
    // Without the new bundle, a normal relative web image is absent from the
    // public shell. Its expected 404 must not become an arbitrary file reader.
    await f.page.route('https://pocket.test/' + imagePath, route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Synthetic unavailable web asset' }));
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

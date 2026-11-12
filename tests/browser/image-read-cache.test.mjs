import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, origin } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
import { syntheticPng, imageSha256 } from './helpers/synthetic-png.mjs';

const baseline = process.env.POCKET_IMAGE_CACHE_EXPECTATION === 'baseline';
const results = [];
const reportPath = resolve(process.env.POCKET_IMAGE_CACHE_REPORT || '.local/qa/upload-flow-2026-11-12/cache-browser/results.json');
const startedAt = new Date().toISOString();
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({ baseline, startedAt, status: 'running', passed: false, scenarios: [] }, null, 2) + '\n');
after(() => {
  const passed = results.length > 0 && results.every(value => value.passed);
  writeFileSync(reportPath, JSON.stringify({ baseline, startedAt, finishedAt: new Date().toISOString(), status: passed ? 'passed' : 'failed', passed, scenarios: results }, null, 2) + '\n');
});
const png = syntheticPng(), secondPng = syntheticPng({ color: [210, 90, 60, 255] });
const thumbnail = syntheticPng({ width: 160, height: 100 });
const attachmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const attachmentUrl = `/api/tasks/${ids.regular}/attachments/${attachmentId}`;
const source = (index, thread = ids.regular) => `/api/tasks/${thread}/images/${index.toString(16).padStart(64, '0')}`;
const bodyA = source(1), bodyB = source(2), syntheticPath = '/synthetic/cache-card.png';
const uploaded = (overrides = {}) => ({ id: attachmentId, name: 'Synthetic uploaded image.png', size: png.length, mime: 'image/png', kind: 'image',
  sha256: imageSha256(png), url: attachmentUrl, previewUrl: attachmentUrl + '?preview=1', previewSha256: imageSha256(thumbnail),
  previewMime: 'image/png', previewSize: thumbnail.length, ...overrides });
const message = (id, extra = {}) => ({ id, role: 'assistant', phase: 'final', text: 'Synthetic uploaded picture.', turnId: 'image-cache-turn', timestamp: Date.now(), ...extra });
function install(h, messages, machine = 'ged', patch = {}) {
  const value = { messages, ...patch }; h.patchHistory(ids.regular, value, machine); h.patchTranscript(ids.regular, value, machine);
}
const withUpload = () => [message('cache-upload', { attachments: [uploaded()] })];
const withBody = () => [message('cache-inline', { text: `![Inline image](<${syntheticPath}>)`, images: { [syntheticPath]: bodyA } })];
const assets = () => new Map([[bodyA, png], [bodyB, secondPng], [attachmentUrl, png], [attachmentUrl + '?preview=1', thumbnail]]);
const viewer = page => page.locator('dialog[data-image-viewer]');
const thumbSelector = '.attachment-preview img, img.attachment-preview';
const mediaPath = url => {
  const match = /^\/api\/machines\/([^/]+)(\/.*)$/.exec(url.pathname);
  return { path: match ? '/api' + match[2] : url.pathname, machine: match?.[1] ?? 'ged', query: url.search };
};
async function serve(page, resources = assets(), intercept) {
  const reads = [];
  await page.route(/\/api\/(?:machines\/[^/]+\/)?tasks\/[^/]+\/(?:images\/[a-f0-9]{64}|attachments\/[a-f0-9-]{36})(?:\?preview=1)?$/, async route => {
    const request = route.request(), url = new URL(request.url()), { path, machine, query } = mediaPath(url);
    const record = { path, machine, query, type: request.resourceType(), accept: request.headers().accept, clientVersion: request.headers()['x-pocket-client-version'] };
    reads.push(record);
    const bytes = resources.get(path + query); assert.ok(bytes, 'Only a supplied synthetic image capability may be read');
    if (intercept && await intercept({ route, record, bytes })) return;
    record.status = 200; record.bytes = bytes.length;
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cache-Control': 'no-store', 'X-Pocket-Machine': machine }, body: bytes });
  });
  return reads;
}
async function start(h, resources = assets(), intercept, machine = 'ged') {
  const page = await h.open(null, machine);
  await page.route(/^blob:https:\/\/pocket\.test\//, route => route.continue());
  const reads = await serve(page, resources, intercept);
  await page.goto(`${origin}/?machine=${machine}&task=${ids.regular}`); await page.locator('.conversation-live').waitFor();
  return { page, reads };
}
async function readyImage(page, selector = 'dialog[data-image-viewer] img', width = 1200) {
  try {
    await page.waitForFunction(({ selector, width }) => {
      const image = document.querySelector(selector); return image?.complete && image.naturalWidth === width && (selector.includes('dialog') ? image.style.visibility === 'visible' : true);
    }, { selector, width }, { timeout: 4000 });
  } catch (error) {
    const pictures = await page.locator(selector).evaluateAll(images => images.map(image => ({ src: image.getAttribute('src'), registered: image.getAttribute('data-registered-source'), complete: image.complete, naturalWidth: image.naturalWidth, visibility: image.style.visibility })));
    throw new Error(`Synthetic image did not decode (${selector}, expected width ${width}): ${JSON.stringify(pictures)}`, { cause: error });
  }
}
async function openUpload(page) { await page.locator('.attachment-card[aria-haspopup="dialog"]').first().click(); await viewer(page).waitFor(); }
async function closeViewer(page) { await page.keyboard.press('Escape'); await viewer(page).waitFor({ state: 'detached' }); }
async function readDisk(page) {
  return page.evaluate(() => new Promise(resolve => {
    const request = indexedDB.open('pocket-image-read-cache-v1');
    request.onupgradeneeded = () => { request.transaction.abort(); resolve([]); };
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('images')) { db.close(); resolve([]); return; }
      const tx = db.transaction('images'), values = tx.objectStore('images').getAll();
      values.onsuccess = () => resolve(values.result.map(({ blob, data, ...record }) => ({ ...record,
        blobBytes: data instanceof ArrayBuffer ? data.byteLength : blob?.size, blobType: blob?.type ?? record.mime,
        storageRepresentation: data instanceof ArrayBuffer ? 'array-buffer' : 'legacy-blob' })));
      values.onerror = () => resolve([]); tx.oncomplete = () => db.close(); tx.onabort = () => db.close();
    };
  }));
}
async function until(action, check = value => value, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (true) { const value = await action(); if (check(value)) return value; if (Date.now() >= deadline) throw new Error('Synthetic condition did not settle'); await new Promise(done => setTimeout(done, 35)); }
}
async function captureUrls(h) {
  await h.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    window.imageCacheUrls = { created: [], revoked: [] };
    URL.createObjectURL = blob => { const url = create(blob); window.imageCacheUrls.created.push({ url, bytes: blob.size, mime: blob.type }); return url; };
    URL.revokeObjectURL = url => { window.imageCacheUrls.revoked.push(url); return revoke(url); };
  });
}
const numberReads = (reads, path, query = '') => reads.filter(read => read.path === path && read.query === query).length;
function flow(engine, number, name, run) {
  const locale = number % 2 ? 'zh-CN' : 'en-US', width = number % 2 ? 390 : 320;
  test(`${engine}: ${locale} ${width}px ${name}`, { timeout: 25000 }, () => {
    const evidence = {};
    return runScenario({ engine, name: `${locale} ${width}px ${name}`, create: () => createHarness(engine, { locale, width }),
      run: h => run(h, evidence, locale), record: result => results.push({ ...result, evidence }) });
  });
}

for (const engine of engines) {
  flow(engine, 1, 'inline and gallery share one read and a second opening reuses bytes', async (h, evidence) => {
    install(h, withBody()); const { page, reads } = await start(h); await readyImage(page, '.message-image-frame img');
    const opener = page.locator('.message-image-frame[aria-haspopup="dialog"]'); await opener.click(); await readyImage(page);
    const firstOpeningGets = numberReads(reads, bodyA); if (!baseline) assert.equal(firstOpeningGets, 1);
    assert.equal(await viewer(page).locator('img').getAttribute(baseline ? 'src' : 'data-registered-source'), bodyA);
    await closeViewer(page); await opener.click(); await readyImage(page); if (!baseline) assert.equal(numberReads(reads, bodyA), 1);
    if (!baseline) {
      assert.ok(reads.every(read => read.type === 'fetch' && read.clientVersion), 'The sole read carries the client version');
      assert.match(await viewer(page).locator('img').getAttribute('src'), /^blob:/);
    }
    evidence.firstOpeningGets = firstOpeningGets; evidence.gets = numberReads(reads, bodyA); evidence.bodyBytes = reads.reduce((sum, read) => sum + (read.bytes ?? 0), 0); evidence.singleImageBytes = png.length;
    evidence.transportTypes = [...new Set(reads.map(read => read.type))];
  });

  flow(engine, 2, 'uploaded thumbnail and original persist with their own verified content hashes', async (h, evidence) => {
    install(h, withUpload()); const { page, reads } = await start(h); await readyImage(page, '.attachment-preview img', 160);
    assert.equal(numberReads(reads, attachmentUrl, '?preview=1'), 1); assert.equal(numberReads(reads, attachmentUrl), 0);
    await openUpload(page); await readyImage(page); await closeViewer(page); await openUpload(page); await readyImage(page);
    assert.equal(numberReads(reads, attachmentUrl), 1); assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), attachmentUrl);
    const records = await until(() => readDisk(page), values => values.length === 2);
    assert.deepEqual(new Set(records.map(record => record.variant)), new Set(['preview', 'original']));
    assert.deepEqual(new Set(records.map(record => record.sha256)), new Set([imageSha256(png), imageSha256(thumbnail)]));
    assert.ok(records.every(record => record.machine === 'ged' && record.scope === 'smoke-ged' && record.threadId === ids.regular && record.bytes === record.blobBytes));
    assert.ok(records.every(record => record.storageRepresentation === 'array-buffer'), 'Both browsers persist portable binary bytes');
    assert.equal(JSON.stringify(records).includes('/api/tasks/'), false); evidence.records = records.map(({ blobBytes, variant, sha256, scope }) => ({ blobBytes, variant, sha256, scope })); evidence.gets = reads.length;
  });

  flow(engine, 3, 'inline and gallery join the same in-flight transfer without revoking the remaining view', async (h, evidence) => {
    install(h, withBody()); let release; const gate = new Promise(done => { release = done; }); await captureUrls(h);
    const { page, reads } = await start(h, assets(), async ({ route, record, bytes }) => {
      await gate; record.status = 200; record.bytes = bytes.length;
      try { await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'X-Pocket-Machine': record.machine }, body: bytes }); } catch { /* A cancelled old owner is expected. */ } return true;
    });
    try {
      await until(() => numberReads(reads, bodyA)); await page.locator('.message-image-frame').click(); await viewer(page).waitFor();
      assert.equal(numberReads(reads, bodyA), 1); await closeViewer(page); release(); await readyImage(page, '.message-image-frame img');
      const inlineUrl = await page.locator('.message-image-frame img').getAttribute('src');
      await page.locator('.message-image-frame').click(); await readyImage(page); assert.equal(await viewer(page).locator('img').getAttribute('src'), inlineUrl);
      await closeViewer(page); assert.equal(await page.evaluate(url => window.imageCacheUrls.revoked.includes(url), inlineUrl), false);
      assert.equal(numberReads(reads, bodyA), 1); evidence.singleflightGets = reads.length; evidence.inlineLeaseSurvived = true;
    } finally { release(); }
  });

  flow(engine, 4, 'authenticated cold reload measures real image cache reads and offline restoration', async (h, evidence) => {
    install(h, withUpload()); let offline = false; const { page, reads } = await start(h, assets(), async ({ route, record }) => {
      if (!offline) return false; record.status = 'offline'; await route.abort('internetdisconnected'); return true;
    });
    await readyImage(page, thumbSelector, 160); await openUpload(page); await readyImage(page); await closeViewer(page);
    if (baseline) {
      const before = reads.length; await page.reload(); await page.locator('.conversation-live').waitFor(); await readyImage(page, thumbSelector, 160);
      await openUpload(page); await readyImage(page);
      assert.equal(reads.length - before, 2, 'The old page reads the thumbnail and original again after reloading');
      evidence.initialGets = before; evidence.coldReloadGets = reads.length - before; evidence.persistedImageRecords = (await readDisk(page)).length;
      evidence.bodyBytes = reads.reduce((sum, read) => sum + (read.bytes ?? 0), 0); return;
    }
    await until(() => readDisk(page), values => values.length === 2); const before = reads.length; offline = true;
    await openUpload(page); await readyImage(page); await closeViewer(page); assert.equal(reads.length, before, 'Current authenticated page reuses its L1 Blob while media is offline');
    const authBefore = h.count('auth/status'); await page.reload(); await page.locator('.conversation-live').waitFor(); await readyImage(page, '.attachment-preview img', 160);
    await openUpload(page); await readyImage(page); assert.equal(reads.length, before, 'A new JS page uses persisted Blob bytes after real auth and metadata');
    assert.ok(h.count('auth/status') > authBefore, 'Cold restoration went through the actual auth-status gate');
    evidence.initialGets = before; evidence.coldReloadGets = reads.length - before; evidence.authStatusChecks = h.count('auth/status');
  });

  flow(engine, 5, 'unknown image metadata reuses only the live session and does not persist its URL', async (h, evidence) => {
    install(h, withBody()); const { page, reads } = await start(h); await readyImage(page, '.message-image-frame img');
    await page.locator('.message-image-frame').click(); await readyImage(page); await closeViewer(page); assert.equal(reads.length, 1);
    assert.deepEqual(await readDisk(page), []); await page.reload(); await readyImage(page, '.message-image-frame img');
    assert.equal(reads.length, 2); assert.deepEqual(await readDisk(page), []); evidence.beforeAndAfterReloadGets = reads.length;
  });

  flow(engine, 6, 'identical upload capabilities and hashes stay isolated across machines and current source scopes', async (h, evidence) => {
    install(h, withUpload(), 'ged'); install(h, withUpload(), 'wandou'); const { page, reads } = await start(h);
    await readyImage(page, '.attachment-preview img', 160); await openUpload(page); await readyImage(page); await closeViewer(page);
    await until(() => readDisk(page), values => values.length === 2);
    await page.goto(`${origin}/?machine=wandou&task=${ids.regular}`); await readyImage(page, '.attachment-preview img', 160);
    await openUpload(page); await readyImage(page); const records = await until(() => readDisk(page), values => values.length === 4);
    assert.deepEqual(reads.map(({ machine, query }) => [machine, query]), [['ged', '?preview=1'], ['ged', ''], ['wandou', '?preview=1'], ['wandou', '']]);
    assert.deepEqual(new Set(records.map(record => record.machine)), new Set(['ged', 'wandou'])); await closeViewer(page);
    const nextScope = 'smoke-wandou-switched', threads = Object.values(ids).map(id => ({ ...h.metadata(id, 'wandou'), pocketContent: { ...h.metadata(id, 'wandou').pocketContent, scope: nextScope } }));
    const catalog = { threads, groups: [], projects: [{ id: 'fixture', name: 'Synthetic project', paths: ['/synthetic'], order: 0, separator: false }],
      sourceInfo: { syncedAt: Date.now(), active: 2, archived: 0, total: 2, scope: 'synthetic', pocketRead: { available: true, scope: nextScope } }, sourceError: null, csrfToken: 'synthetic-token' };
    await page.route(/\/api\/machines\/wandou\/(?:catalog|sync)$/, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'wandou' }, body: JSON.stringify(catalog) }));
    install(h, withUpload(), 'wandou', { pocketContent: threads[0].pocketContent });
    await page.reload(); await readyImage(page, '.attachment-preview img', 160); await openUpload(page); await readyImage(page);
    assert.equal(reads.length, 6, 'Fresh source metadata requires independent image reads instead of reusing the previous source');
    const changed = await until(() => readDisk(page), values => values.length === 4 && values.filter(value => value.machine === 'wandou').every(value => value.scope === nextScope));
    assert.equal(changed.some(record => record.scope === 'smoke-wandou'), false); evidence.machineReads = reads.map(({ machine, query }) => ({ machine, query })); evidence.finalScopes = [...new Set(changed.map(value => value.scope))];
  });

  flow(engine, 7, 'bad content proof is rejected without disk fill and explicit retry fetches the verified original', async (h, evidence, locale) => {
    install(h, withUpload()); let bad = true; const { page, reads } = await start(h, assets(), async ({ route, record }) => {
      if (record.query || !bad) return false; record.status = 200; record.bytes = secondPng.length;
      await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'X-Pocket-Machine': record.machine }, body: secondPng }); return true;
    });
    await readyImage(page, '.attachment-preview img', 160); await openUpload(page);
    const retry = viewer(page).getByRole('button', { name: locale === 'en-US' ? 'Reload image' : '重新加载图片', exact: true }); await retry.waitFor();
    assert.equal((await readDisk(page)).some(record => record.variant === 'original'), false); bad = false; await retry.click(); await readyImage(page);
    assert.equal(numberReads(reads, attachmentUrl), 2); await until(() => readDisk(page), values => values.length === 2); evidence.originalGets = 2; evidence.rejectedProofWasNotSaved = true;
  });

  flow(engine, 8, 'a fixed 403 reason is shown once and explicit retry is not trapped in an error cache', async (h, evidence, locale) => {
    install(h, withBody()); let denied = true; const { page, reads } = await start(h, assets(), async ({ route, record }) => {
      if (!denied) return false; record.status = 403;
      await route.fulfill({ status: 403, contentType: 'application/json', headers: { 'X-Pocket-Machine': record.machine }, body: JSON.stringify({ error: 'Mac 服务无权读取这张图片，请在电脑上检查文件访问权限' }) }); return true;
    });
    const reason = locale === 'en-US' ? 'The Mac service cannot read this image. Check file access permissions on your computer.' : 'Mac 服务无权读取这张图片，请在电脑上检查文件访问权限';
    await page.locator('.message-image-failed').getByText(reason, { exact: true }).waitFor(); assert.equal(reads.length, 1); assert.equal(reads[0].type, 'fetch');
    denied = false; await page.locator('.message-image-failed').getByRole('button', { name: locale === 'en-US' ? 'Retry' : '重试', exact: true }).click();
    await readyImage(page, '.message-image-frame img'); await page.locator('.message-image-frame').click(); await readyImage(page); assert.equal(reads.length, 2);
    evidence.gets = reads.length; evidence.permissionResponseWasNotCached = true;
  });

  flow(engine, 9, 'loading gallery navigation keeps one dialog and ignores old Blob events', async (h, evidence) => {
    const paths = ['/synthetic/cache-first.png', '/synthetic/cache-second.png'];
    install(h, [message('cache-gallery', { text: paths.map((path, index) => `![Image ${index}](<${path}>)`).join('\n\n'), images: { [paths[0]]: bodyA, [paths[1]]: bodyB } })]);
    let release; const gate = new Promise(done => { release = done; });
    const { page, reads } = await start(h, assets(), async ({ route, record, bytes }) => {
      if (record.path !== bodyB) return false; await gate; record.status = 200;
      try { await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'X-Pocket-Machine': record.machine }, body: bytes }); } catch { /* Owner cancellation remains permitted. */ } return true;
    });
    try {
      await readyImage(page, '.message-image-frame img'); await page.locator('.message-image-frame').first().click(); await readyImage(page);
      await viewer(page).evaluate(dialog => { window.cacheGalleryDialog = dialog; window.oldCachePicture = dialog.querySelector('img'); });
      await page.keyboard.press('ArrowRight'); await until(() => numberReads(reads, bodyB));
      await page.evaluate(() => { window.oldCachePicture.dispatchEvent(new Event('error')); window.oldCachePicture.dispatchEvent(new Event('load')); });
      assert.equal(await viewer(page).evaluate(dialog => dialog === window.cacheGalleryDialog), true); assert.equal(await viewer(page).locator('[role="alert"]').count(), 0);
      release(); await readyImage(page); assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), bodyB);
      assert.equal(numberReads(reads, bodyB), 1); evidence.oldEventsIgnored = true; evidence.secondImageGets = 1;
    } finally { release(); }
  });

  flow(engine, 10, 'a full 32-image history reads nearby viewport images without bulk prefetching', async (h, evidence) => {
    const resources = new Map(), messages = Array.from({ length: 32 }, (_, index) => {
      const path = `/synthetic/cache-${index}.png`, src = source(index + 100); resources.set(src, png);
      return message('lazy-image-' + index, { text: `Synthetic image ${index}\n\n![Image ${index}](<${path}>)`, images: { [path]: src } });
    });
    install(h, messages); const { page, reads } = await start(h, resources); await page.locator('.message-image').last().waitFor();
    await until(() => reads.length); await page.waitForTimeout(250); const initial = reads.length;
    assert.ok(initial > 0 && initial <= 8, `Only nearby images load; actual ${initial} of 32`);
    assert.equal(await page.locator('.message-image').count(), 32);
    await page.locator('.conversation-messages').evaluate(element => { element.scrollTop = 0; }); await until(() => reads.length, value => value > initial);
    assert.ok(reads.length > initial && reads.length < 32); evidence.initialGets = initial; evidence.afterScrollGets = reads.length; evidence.registeredImages = 32;
  });

  flow(engine, 11, 'a media 401 removes authenticated views and clears already stored private thumbnails', async (h, evidence) => {
    install(h, withUpload()); await captureUrls(h); const { page, reads } = await start(h, assets(), async ({ route, record }) => {
      if (record.query) return false; record.status = 401; await route.fulfill({ status: 401, contentType: 'application/json', headers: { 'X-Pocket-Machine': record.machine }, body: JSON.stringify({ error: 'Synthetic auth expired' }) }); return true;
    });
    await readyImage(page, '.attachment-preview img', 160); await until(() => readDisk(page), values => values.length === 1);
    // A fast 401 can remove the viewer before it ever becomes visible. Verify
    // the final authentication boundary, not that transient dialog state.
    await page.locator('.attachment-card[aria-haspopup="dialog"]').first().click();
    await page.locator('.access-screen input[type="password"]').waitFor(); assert.equal(await viewer(page).count(), 0);
    assert.deepEqual(await until(() => readDisk(page), values => values.length === 0), []);
    const receipts = await page.evaluate(() => window.imageCacheUrls); assert.ok(receipts.created.every(value => receipts.revoked.includes(value.url)));
    evidence.originalStatus = reads.at(-1).status; evidence.diskAfter401 = 0; evidence.allUrlsRevoked = true;
  });

  flow(engine, 12, 'logout clears private image persistence and unauthenticated reload cannot show cached bytes', async (h, evidence, locale) => {
    install(h, withUpload()); const { page, reads } = await start(h); await readyImage(page, '.attachment-preview img', 160);
    await openUpload(page); await readyImage(page); await closeViewer(page); await until(() => readDisk(page), values => values.length === 2);
    let authenticated = false, releaseAuth, authHeld = true, statusChecks = 0;
    const gate = new Promise(done => { releaseAuth = done; });
    await page.route('**/api/auth/status', async route => {
      statusChecks++; if (authHeld) await gate;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'ged' }, body: JSON.stringify({ authenticated }) });
    });
    const beforeAuth = reads.length;
    try {
      await page.reload(); await until(() => statusChecks);
      assert.equal((await readDisk(page)).length, 2, 'Real image Blob records still exist while the auth response is pending');
      assert.equal(await page.locator('img[data-registered-source]').count(), 0); assert.equal(reads.length, beforeAuth, 'Private cached images are not shown or fetched before auth completes');
      authHeld = false; releaseAuth(); await page.locator('.access-screen input[type="password"]').waitFor();
      assert.deepEqual(await until(() => readDisk(page), values => values.length === 0), []);
      authenticated = true; await page.reload(); await readyImage(page, '.attachment-preview img', 160); await openUpload(page); await readyImage(page); await closeViewer(page);
      await until(() => readDisk(page), values => values.length === 2);
    } finally { releaseAuth(); }
    await page.route('**/api/auth/logout', route => { authenticated = false; return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'ged' }, body: JSON.stringify({ authenticated: false }) }); });
    await page.locator('[data-inspector-close]').click(); await page.locator('.inspector').waitFor({ state: 'detached' });
    await page.locator('.workspace-header .mobile-only').click(); await page.locator('.sidebar.mobile-open').waitFor();
    await page.getByRole('button', { name: locale === 'en-US' ? 'Settings' : '设置', exact: true }).click();
    await page.locator('.settings-logout-button').click(); await page.locator('.access-screen input[type="password"]').waitFor();
    assert.deepEqual(await until(() => readDisk(page), values => values.length === 0), []); const before = reads.length;
    await page.reload(); await page.locator('.access-screen input[type="password"]').waitFor();
    assert.equal(await page.locator('img[data-registered-source]').count(), 0); assert.equal(reads.length, before);
    evidence.diskBeforePendingAuth = 2; evidence.privateImagesDuringPendingAuth = 0; evidence.diskAfterLogout = 0; evidence.unauthenticatedReloadGets = reads.length - before;
  });
}

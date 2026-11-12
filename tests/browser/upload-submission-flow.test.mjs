import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, origin, refresh } from './fixture.mjs';
import { syntheticPng, imageSha256 } from './helpers/synthetic-png.mjs';

const results = [], startedAt = new Date().toISOString();
after(() => {
  const report = resolve(process.env.POCKET_UPLOAD_BROWSER_REPORT || '.local/qa/upload-flow-2026-11-12/browser-flow.json');
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, JSON.stringify({ schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(),
    planned: engines.length * 7, executed: results.length, status: results.some(result => !result.passed) ? 'failed' : results.length === engines.length * 7 ? 'passed' : 'partial',
    buildIds: [...new Set(results.map(result => result.build).filter(Boolean))], scenarios: results }, null, 2) + '\n');
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async (predicate, message = 'Synthetic state did not settle') => {
  const deadline = Date.now() + 10000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(done => setTimeout(done, 20));
  }
};
const composer = page => page.locator('.composer-input textarea');
const typeDraft = async (page, text) => { await composer(page).click(); await composer(page).pressSequentially(text, { delay: 1 }); };
const submit = page => page.locator('.conversation-composer button[type="submit"]');
const reservationSettled = service => until(() => service.calls.some(call => call.method === 'POST' && call.action === 'messages' && call.finishedAt), 'Reservation response did not settle');
const rowFor = (page, id) => page.locator(`article[data-query-id="${id}"]`);
const translated = (locale, chinese, english) => locale === 'en-US' ? english : chinese;
const files = count => Array.from({ length: count }, (_, index) => ({ name: `Synthetic-shared-filename-prefix_unique-${String(index + 1).padStart(2, '0')}.png`,
  mimeType: 'image/png', buffer: syntheticPng({ width: 4, height: 3, color: [30 + index, 70, 120, 255] }) }));
const selectedBytes = new Map(files(16).map(file => [file.name, file.buffer]));

// This route owns only the test's synthetic upload/request lifecycle. It never
// forwards a request and leaves the shared fixture/static CSP implementation
// untouched, so concurrent cache tests have a separate service and browser.
async function uploadService(page, { uploadOutcome, cancelFailure, cleanupFailure = false, holdReservation = false } = {}) {
  const calls = [], puts = [], reservations = new Map(), stored = new Map(), outcomes = new Map();
  let peakPuts = 0;
  const reservationGate = deferred(); let gateOpen = !holdReservation, partial = null, metadataReady = false;
  let cancelFailures = cancelFailure ? 1 : 0, cleanupFailures = cleanupFailure ? 1 : 0;
  const base = Array.from({ length: 28 }, (_, index) => ({ id: `upload-history-${index}`, role: index % 2 ? 'assistant' : 'user',
    text: `Synthetic reading sample ${index}: preserved content and deliberate scroll.`, timestamp: Date.now() - 200000 + index,
    phase: index % 2 ? 'final_answer' : undefined, turnId: `upload-history-turn-${index >> 1}` }));
  const attachment = (id, name, bytes) => ({ id, name, size: bytes.length, mime: 'image/png', kind: 'image', sha256: imageSha256(bytes),
    sourceSha256: imageSha256(bytes), sourceSize: bytes.length, url: `/api/tasks/${ids.regular}/attachments/${id}`,
    previewUrl: `/api/tasks/${ids.regular}/attachments/${id}?preview=1`, previewSha256: imageSha256(bytes), previewMime: 'image/png', previewSize: bytes.length });
  const manifest = record => record.input.attachmentUploads;
  const publicState = record => {
    const descriptors = manifest(record).map(file => {
      const known = stored.get(file.id);
      return { id: file.id, name: file.name, size: file.size, mime: file.mime,
        status: known ? 'uploaded' : outcomes.get(file.id) === 'failed' ? 'failed' : outcomes.get(file.id) === 'unknown' || puts.some(put => put.id === file.id && !put.finished) ? 'uploading' : 'missing',
        ...(known ? { attachment: known.metadata } : {}) };
    });
    const uploaded = descriptors.filter(file => file.status === 'uploaded').length;
    return { attachmentUploads: descriptors, uploadProgress: { total: descriptors.length, uploaded,
      status: uploaded === descriptors.length ? 'ready' : descriptors.some(file => file.status === 'failed') ? 'failed' : 'uploading',
      code: uploaded === descriptors.length ? undefined : 'attachments_uploading' } };
  };
  const receipt = record => ({ requestId: record.input.requestId, status: record.status, code: record.status === 'queued' ? 'attachments_uploading' : undefined,
    queueRevision: 0, ...publicState(record) });
  const queue = () => [...reservations.values()].filter(record => record.status !== 'cancelled' && record.status !== 'accepted').map(record => ({
    id: record.input.requestId, text: record.input.text, revision: 0, status: record.status, createdAt: record.createdAt,
    autoDirect: record.input.autoDirect, attachments: manifest(record).flatMap(file => stored.has(file.id) ? [stored.get(file.id).metadata] : []), ...publicState(record),
  }));
  const messages = () => [...base, ...(partial ? [partial] : [])];
  const history = saved => ({ source: saved ? 'rollout' : 'desktop', resumeState: 'resumed', runtime: 'idle', canSend: !saved,
    canQueue: true, canAttemptSend: true, hint: '', checkedAt: Date.now(), messages: messages(), outbox: queue(), hasMore: false,
    latestTurnId: partial?.turnId ?? base.at(-1).turnId, latestTurnStatus: 'completed', activeTurnId: null,
    asyncQuestions: [], pendingRequests: [], canStop: false, canCompact: false,
    pocketContent: { known: true, scope: 'smoke-ged', revision: messages().length, messageId: messages().at(-1).id,
      version: createHash('sha256').update(JSON.stringify(messages())).digest('hex') } });
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json',
    headers: { 'cache-control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: JSON.stringify(body) });
  // Blob reads are browser-local, never HTTP forwarding. WebKit exposes them
  // to Playwright routes, where the shared static fixture would mistake the
  // embedded origin/UUID for a file inside dist.
  await page.route(/^blob:https:\/\/pocket\.test\//, route => route.continue());
  await page.route(new RegExp(`/api/(?:machines/[^/]+/)?tasks/${ids.regular}/(?:attachments(?:/[^/?]+)?|messages(?:/[^/?]+)?|outbox/[^/?]+|history|transcript)(?:\\?.*)?$`), async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    assert.equal(url.origin, origin);
    const action = url.pathname.split(`/tasks/${ids.regular}/`)[1], id = action.split('/')[1];
    const call = { method, action, id, startedAt: Date.now() }; calls.push(call);
    try {
      if (['history', 'transcript'].includes(action) && method === 'GET') return await json(route, 200, history(action === 'transcript'));
      if (action === 'attachments' && method === 'GET') return await json(route, 200, { attachments: [] });
      if (action === 'messages' && method === 'POST') {
        const input = request.postDataJSON(); call.input = input;
        assert.ok(Array.isArray(input.attachmentUploads), 'Uploading submits a complete reservation manifest, never a partial attachments dispatch');
        assert.equal(input.attachments, undefined); assert.ok(input.attachmentUploads.length > 0 && input.attachmentUploads.length <= 16);
        assert.equal(new Set(input.attachmentUploads.map(file => file.id)).size, input.attachmentUploads.length);
        assert.ok(!reservations.has(input.requestId), 'The request is reserved once');
        const record = { input, status: 'queued', createdAt: Date.now() }; reservations.set(input.requestId, record);
        if (!gateOpen) await reservationGate.promise;
        return await json(route, 202, receipt(record));
      }
      if (action.startsWith('messages/') && method === 'GET') {
        if (cancelFailure === 'GET' && cancelFailures && service.failNextRead) {
          cancelFailures--; service.failNextRead = false; return await json(route, 503, { error: 'Synthetic cancellation read failed.' });
        }
        const record = reservations.get(id);
        return await json(route, 200, record ? receipt(record) : { requestId: id, status: 'not_found' });
      }
      if (action.startsWith('outbox/') && method === 'DELETE') {
        call.input = request.postDataJSON(); assert.equal(call.input.expectedRevision, 0);
        if (cancelFailure === 'DELETE' && cancelFailures) { cancelFailures--; return await json(route, 503, { error: 'Synthetic cancel acknowledgement lost.' }); }
        const record = reservations.get(id); assert.ok(record); record.status = 'cancelled';
        return await json(route, 200, { requestId: id, status: 'cancelled', outbox: queue() });
      }
      if (action.startsWith('attachments/') && method === 'PUT') {
        const captured = request.postDataBuffer(), name = url.searchParams.get('name'), gate = deferred();
        const knownBytes = selectedBytes.get(name); assert.ok(knownBytes, 'This route owns only the selected synthetic PNGs');
        // WebKit's Playwright protocol omits a raw File request body. Use the
        // exact selected fixture bytes for its server response, and record the
        // boundary. Chromium independently verifies the captured wire bytes.
        const bytes = captured ?? knownBytes;
        call.bodyEvidence = captured ? 'captured-request-bytes' : 'selected-file-bytes-webkit-protocol';
        assert.deepEqual(bytes, knownBytes); assert.equal(request.headers()['content-type'], 'image/png');
        const put = { id, name, bytes, metadata: attachment(id, name, bytes), requestId: url.searchParams.get('requestId'), gate, finished: false };
        puts.push(put); outcomes.set(id, 'uploading');
        peakPuts = Math.max(peakPuts, puts.filter(value => !value.finished).length);
        const attempt = puts.filter(value => value.id === id).length;
        const outcome = uploadOutcome?.(put, attempt) ?? 'hold';
        if (outcome === 'hold') await gate.promise;
        if (outcome === 'failed') { outcomes.set(id, 'failed'); return await json(route, 422, { error: 'Synthetic definite upload failure.' }); }
        if (outcome === 'unknown') { outcomes.set(id, 'unknown'); return await json(route, 502, { error: 'Synthetic upload result needs verification.' }); }
        stored.set(id, { metadata: put.metadata, bytes }); outcomes.set(id, 'uploaded');
        return await json(route, 200, put.metadata);
      }
      if (action.startsWith('attachments/') && method === 'GET' && url.searchParams.has('metadata')) {
        call.metadata = true;
        if (metadataReady && !stored.has(id)) {
          const put = puts.findLast(value => value.id === id); if (put) stored.set(id, { metadata: put.metadata, bytes: put.bytes });
        }
        return await json(route, stored.has(id) ? 200 : 409, stored.has(id) ? stored.get(id).metadata : { error: 'Synthetic upload is still uncertain.' });
      }
      if (action.startsWith('attachments/') && method === 'DELETE') {
        stored.delete(id);
        if (cleanupFailures) { cleanupFailures--; return await json(route, 503, { error: 'Synthetic cleanup acknowledgement lost.' }); }
        return await json(route, 200, { removed: true });
      }
      if (action.startsWith('attachments/') && method === 'GET') {
        const known = stored.get(id); assert.ok(known, 'Only an uploaded capability can be read');
        return await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'cache-control': 'private, no-store', 'X-Pocket-Machine': 'ged' }, body: known.bytes });
      }
      throw new Error(`Unsupported synthetic upload operation: ${method} ${action}`);
    } finally { call.finishedAt = Date.now(); if (method === 'PUT') { const put = puts.findLast(value => value.id === id); if (put) put.finished = true; } }
  });
  const service = {
    calls, puts, reservations, failNextRead: false,
    get peakPuts() { return peakPuts; },
    releaseReservation() { gateOpen = true; reservationGate.resolve(); },
    releasePuts(start = 0, end = puts.length) { puts.slice(start, end).forEach(put => put.gate.resolve()); },
    readyMetadata() { metadataReady = true; },
    first() { return reservations.values().next().value; },
    accept(record = service.first()) {
      for (const file of manifest(record)) { const put = puts.findLast(value => value.id === file.id); assert.ok(put); stored.set(file.id, { metadata: put.metadata, bytes: put.bytes }); }
      record.status = 'accepted';
    },
    echo(count, record = service.first()) { partial = { id: 'upload-native-' + record.input.requestId, role: 'user', clientMessageId: record.input.requestId,
      text: record.input.text, timestamp: record.createdAt, turnId: 'upload-native-turn', attachments: manifest(record).slice(0, count).map(file => {
        const put = puts.findLast(value => value.id === file.id); assert.ok(put); return put.metadata;
      }) }; },
    clearEcho() { partial = null; },
    close() { service.releaseReservation(); service.releasePuts(); },
  };
  await refresh(page); await page.getByText(base.at(-1).text, { exact: true }).waitFor();
  return service;
}

async function startUpload(page, service, count, caption = 'Synthetic upload submission caption') {
  await composer(page).fill(caption);
  await page.locator('[data-attachment-input]').setInputFiles(files(count));
  await until(() => service.puts.length >= (count === 16 ? 16 : 1), 'Selected files did not start the expected upload budget');
  assert.equal(await submit(page).isEnabled(), true, 'Send remains usable while selected files upload');
  await submit(page).click();
  await until(() => service.reservations.size === 1);
  const record = service.first(), row = rowFor(page, record.input.requestId);
  await row.waitFor(); assert.equal(await row.count(), 1);
  assert.equal(await composer(page).inputValue(), '', 'Submission transfers the immutable message and clears only that draft');
  return { record, row };
}
async function assertState(row, status) {
  await until(async () => await row.getAttribute('data-query-state') === status, `Query state did not become ${status}`);
}
async function checkRow(row, locale) {
  const check = row.getByRole('button', { name: translated(locale, '核对状态', 'Check status'), exact: true });
  await check.click();
}
async function cancelRow(row, locale) {
  await cancelAction(row, locale).click();
}
const cancelAction = (row, locale) => row.locator('button').filter({ hasText: new RegExp('^' + translated(locale, '取消发送', 'Cancel send') + '$') });
function flow(engine, label, options, run) {
  test(`${engine}: ${label}`, { timeout: 60000 }, async () => {
    const result = { engine, name: label, width: options.width, locale: options.locale, passed: false };
    let h, service, failure;
    try {
      h = await createHarness(engine, options); result.build = h.build;
      if (process.env.POCKET_UPLOAD_BUILD) assert.equal(h.build, process.env.POCKET_UPLOAD_BUILD, 'The tested production manifest is the frozen candidate');
      const page = await h.open();
      assert.equal(new URL(page.url()).origin, origin); assert.match(await page.title(), /Pocket/);
      assert.equal(await page.locator('vite-error-overlay').count(), 0);
      const install = async configuration => service = await uploadService(page, configuration);
      await run({ h, page, install, locale: options.locale });
      assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The actual mobile App has no horizontal overflow');
    } catch (error) { failure = error; }
    finally {
      service?.close();
      try { await h?.close(); } catch (error) { failure = failure ? new AggregateError([failure, error], 'Scenario and cleanup failed') : error; }
      result.passed = !failure; result.requests = h?.calls.length ?? 0;
      if (service) result.uploadEvidence = { puts: service.puts.length,
        peakPuts: service.peakPuts,
        capturedBodies: service.calls.filter(call => call.bodyEvidence === 'captured-request-bytes').length,
        selectedFileBodies: service.calls.filter(call => call.bodyEvidence === 'selected-file-bytes-webkit-protocol').length,
        messagePosts: service.calls.filter(call => call.method === 'POST' && call.action === 'messages').length };
      if (failure) { result.error = failure.stack || String(failure); console.error(JSON.stringify({ scenario: label, engine, error: failure.message })); }
      results.push(result);
    }
    if (failure) throw failure;
  });
}

for (const engine of engines) {
  for (const [locale, width, autoDirect] of [['zh-CN', 390, true], ['en-US', 320, false]]) {
    flow(engine, `${locale}/${width}: sixteen uploads submit immediately, survive navigation, and keep one accepted echo row`, { locale, width }, async ({ h, page, install }) => {
      await page.evaluate(enabled => { const key = 'pocket.auto-direct-send.v1'; localStorage.setItem(key, JSON.stringify(enabled));
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(enabled) })); }, autoDirect);
      const service = await install({ holdReservation: true });
      const { record } = await startUpload(page, service, 16), id = record.input.requestId;
      let row = rowFor(page, id);
      await assertState(row, 'uploading'); assert.match(await row.textContent(), /0\/16/);
      assert.equal(service.puts.length, 16, 'All sixteen PUTs occupy the shared upload budget');
      assert.equal(service.peakPuts, 16, 'The actual held-request peak is sixteen');
      await page.waitForTimeout(80);
      assert.equal(service.puts.length, 16, 'The uploader creates no seventeenth request');
      assert.equal(record.input.autoDirect, autoDirect, 'The reservation captures the current sending preference');
      assert.equal(service.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
      service.releaseReservation(); await reservationSettled(service);
      await composer(page).fill('Independent new draft');
      await page.locator('[data-inspector-close]').click(); await page.locator('.inspector').waitFor({ state: 'detached' });
      await page.locator(`[data-swipe-row-id="${ids.regular}"] .task-select`).click(); await row.waitFor();
      assert.equal(await row.count(), 1); assert.equal(await composer(page).inputValue(), 'Independent new draft');
      await row.evaluate(node => { window.syntheticUploadQueryRow = node; });
      await composer(page).evaluate(node => { window.syntheticUploadComposer = node; node.focus(); node.setSelectionRange(2, 6); });
      assert.equal(service.puts.filter(put => !put.finished).length, 16);
      assert.deepEqual(new Set(service.puts.map(put => put.id)), new Set(record.input.attachmentUploads.map(file => file.id)));
      service.releasePuts(); await until(() => service.puts.every(put => put.finished));
      await assertState(row, 'queued');
      assert.equal(await row.locator('[data-feedback-state="accepted"]').count(), 0, 'Finished uploads have no green acceptance');
      assert.equal(await composer(page).inputValue(), 'Independent new draft');
      assert.equal(await composer(page).evaluate(node => node === window.syntheticUploadComposer && document.activeElement === node), true);
      assert.deepEqual(await composer(page).evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 6]);
      service.accept(); await checkRow(row, locale); await assertState(row, 'accepted');
      assert.equal(await row.locator('[data-feedback-state="accepted"]').count(), 1);
      service.echo(16); await refresh(page);
      await row.locator('[data-attachment-id]').nth(15).waitFor();
      assert.equal(await row.count(), 1); assert.equal(await row.locator('[data-attachment-id]').count(), 16);
      assert.equal(await row.evaluate(node => node === window.syntheticUploadQueryRow), true);
      assert.equal(await composer(page).inputValue(), 'Independent new draft');
      assert.equal(service.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
      assert.equal(service.puts.length, 16);
      assert.equal(h.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 0, 'The generic send fixture never handled a reservation');
    });
  }

  flow(engine, 'zh-CN/320: zero and partial desktop echoes cannot accept an uploading request or disturb IME, input and reading intent', { locale: 'zh-CN', width: 320 }, async ({ page, install, locale }) => {
    const service = await install(), { record, row } = await startUpload(page, service, 2);
    await until(() => service.puts.length === 2);
    await reservationSettled(service);
    await row.evaluate(node => { window.syntheticUploadQueryRow = node; });
    service.echo(0); await refresh(page); await page.waitForTimeout(250);
    await assertState(row, 'uploading'); assert.equal(service.first().status, 'queued');
    assert.equal(await row.locator('[data-feedback-state="accepted"]').count(), 0);
    const input = composer(page); await input.fill('A separate draft with IME');
    await input.evaluate(node => { window.syntheticUploadComposer = node; node.focus(); node.setSelectionRange(4, 9);
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' })); });
    const scroll = page.locator('.conversation-messages');
    await scroll.evaluate(node => { window.syntheticUploadScrollRoot = node; node.scrollTop = 100; node.dispatchEvent(new Event('scroll')); });
    const before = await scroll.evaluate(node => node.scrollTop);
    service.releasePuts(0, 1); await until(() => service.puts[0].finished); service.echo(1); await refresh(page);
    await page.waitForTimeout(250); await assertState(row, 'uploading');
    assert.equal(await input.inputValue(), 'A separate draft with IME');
    assert.equal(await input.evaluate(node => node === window.syntheticUploadComposer && document.activeElement === node), true);
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [4, 9]);
    assert.equal(await scroll.evaluate(node => node === window.syntheticUploadScrollRoot), true);
    assert.ok(Math.abs(await scroll.evaluate(node => node.scrollTop) - before) <= 1, 'Partial progress and history preserve deliberate reading position');
    await input.evaluate(node => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' })));
    assert.equal(await row.count(), 1); assert.equal(await row.evaluate(node => node === window.syntheticUploadQueryRow), true);
    assert.equal(service.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
    service.releasePuts(1); await until(() => service.puts.every(put => put.finished));
    await assertState(row, 'queued'); service.accept(); await checkRow(row, locale); await assertState(row, 'accepted');
  });

  flow(engine, 'en-US/390: definite failure retries the same upload id; uncertainty offers metadata verification without retransmission', { locale: 'en-US', width: 390 }, async ({ page, install, locale }) => {
    const service = await install({ uploadOutcome: (_put, attempt) => attempt === 1 ? 'failed' : 'unknown' });
    await composer(page).fill('Failed upload stays with this original request');
    await page.locator('[data-attachment-input]').setInputFiles(files(1));
    await page.locator('.draft-attachments [data-upload-status="failed"]').waitFor();
    await submit(page).click(); await until(() => service.reservations.size === 1);
    const record = service.first(), row = rowFor(page, record.input.requestId); await assertState(row, 'upload_failed');
    await row.getByRole('button', { name: 'Retry failed uploads', exact: true }).click();
    await until(() => service.puts.length === 2);
    assert.equal(service.puts[0].id, service.puts[1].id); assert.equal(service.puts[1].requestId, record.input.requestId);
    await until(async () => /needs verification|待核对/i.test(await row.textContent()));
    const receiptReads = service.calls.filter(call => call.action.startsWith('messages/') && call.finishedAt).length;
    await until(() => service.calls.filter(call => call.action.startsWith('messages/') && call.finishedAt).length > receiptReads, 'Unknown upload receipt was not polled');
    await page.waitForTimeout(120);
    assert.match(await row.textContent(), /needs verification|待核对/i, 'A server still-processing receipt does not erase the local uncertain PUT result');
    assert.equal(await row.locator('[data-query-breathing="true"]').count(), 0, 'Uncertain uploads keep static verification feedback');
    assert.equal(await row.getByRole('button', { name: 'Retry failed uploads', exact: true }).count(), 0);
    await typeDraft(page, 'A later independent draft');
    assert.equal(await composer(page).inputValue(), 'A later independent draft');
    await page.waitForTimeout(100);
    assert.equal(await composer(page).inputValue(), 'A later independent draft', 'The real draft input settled before metadata verification');
    const reads = service.calls.filter(call => call.metadata).length;
    service.readyMetadata(); await checkRow(row, locale); await assertState(row, 'queued');
    await until(async () => await row.locator('img').evaluateAll(images => images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0)), 'Verified PNG preview did not decode');
    assert.ok(service.calls.filter(call => call.metadata).length > reads);
    assert.equal(service.puts.length, 2, 'Read-only verification never sends a third PUT');
    assert.equal(service.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
    assert.equal(await composer(page).inputValue(), 'A later independent draft');
    service.accept(); await checkRow(row, locale); await assertState(row, 'accepted');
  });

  for (const [failure, locale, width] of [['GET', 'zh-CN', 390], ['DELETE', 'en-US', 320]]) {
    flow(engine, `${locale}/${width}: failed cancellation ${failure} keeps the original request and a later accepted receipt wins`, { locale, width }, async ({ page, install }) => {
      const service = await install({ cancelFailure: failure }), { row } = await startUpload(page, service, 1);
      await reservationSettled(service);
      service.failNextRead = failure === 'GET';
      const reads = service.calls.filter(call => call.action.startsWith('messages/')).length;
      await cancelRow(row, locale);
      await until(() => failure === 'GET' ? service.calls.filter(call => call.action.startsWith('messages/')).length > reads
        : service.calls.some(call => call.method === 'DELETE' && call.action.startsWith('outbox/')));
      await row.getByRole('alert').waitFor();
      assert.equal(await row.count(), 1); assert.equal(await row.getAttribute('data-query-state'), 'uploading');
      await typeDraft(page, 'New draft after a failed cancellation');
      service.accept(); await checkRow(row, locale); await assertState(row, 'accepted');
      service.releasePuts(); await until(() => service.puts.every(put => put.finished));
      assert.equal(await composer(page).inputValue(), 'New draft after a failed cancellation');
      assert.equal(await row.locator('[data-feedback-state="accepted"]').count(), 1);
      assert.equal(await cancelAction(row, locale).count(), 0);
      assert.equal(service.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
      assert.equal(service.calls.filter(call => call.method === 'DELETE' && call.action.startsWith('outbox/')).length, failure === 'GET' ? 0 : 1);
    });
  }

  flow(engine, 'zh-CN/320: cancelled send with lost cleanup response retains verification and repeats only cleanup, never dispatch', { locale: 'zh-CN', width: 320 }, async ({ page, install, locale }) => {
    const service = await install({ cleanupFailure: true }), { row } = await startUpload(page, service, 1);
    await reservationSettled(service);
    await cancelRow(row, locale);
    await until(() => service.calls.some(call => call.method === 'DELETE' && call.action.startsWith('outbox/')));
    service.releasePuts();
    await assertState(row, 'cancelled'); assert.match(await row.textContent(), /待核对/, 'A lost cleanup response remains explicitly unresolved');
    assert.equal(await cancelAction(row, locale).isEnabled(), true);
    assert.equal(await row.getByRole('button', { name: '核对状态', exact: true }).isEnabled(), true);
    await typeDraft(page, 'New draft survives cancelled cleanup');
    await checkRow(row, locale);
    await until(() => service.calls.filter(call => call.method === 'DELETE' && call.action.startsWith('attachments/')).length === 2);
    assert.equal(service.calls.filter(call => call.method === 'DELETE' && call.action.startsWith('outbox/')).length, 1);
    assert.equal(service.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
    assert.equal(await composer(page).inputValue(), 'New draft survives cancelled cleanup');
    assert.equal(await row.locator('[data-feedback-state="accepted"]').count(), 0);
    await row.getByRole('button', { name: '收起', exact: true }).click(); await row.waitFor({ state: 'detached' });
    await refresh(page); await page.waitForTimeout(250); assert.equal(await row.count(), 0, 'Cancelled callbacks do not create a ghost query');
  });
}

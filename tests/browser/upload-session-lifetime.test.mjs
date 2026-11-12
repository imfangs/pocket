import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, origin } from './fixture.mjs';

const results = [], startedAt = new Date().toISOString();
after(() => {
  const path = resolve(process.env.POCKET_SESSION_BROWSER_REPORT || '.local/qa/architecture-cr-2026-11-12/session-browser.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, startedAt, finishedAt: new Date().toISOString(),
    planned: engines.length * 3, executed: results.length, status: results.some(item => !item.passed) ? 'failed'
      : results.length === engines.length * 3 ? 'passed' : 'partial',
    builds: [...new Set(results.map(item => item.build).filter(Boolean))], scenarios: results }, null, 2) + '\n');
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const activeFile = { name: 'active-session-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic active file') };
const waitingFile = { name: 'waiting-session-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic waiting file') };
const until = async predicate => {
  const end = Date.now() + 8000;
  while (!await predicate()) { assert.ok(Date.now() < end, 'Controlled session state must settle'); await new Promise(done => setTimeout(done, 20)); }
};
const textarea = page => page.locator('.composer-input textarea');

// Only this test's synthetic auth/reservation/files are overridden. Unknown
// routes fall through to the allowlisted common fixture, never to the network.
async function installSession(page, harness) {
  let authenticated = true, expireNextReceipt = false, record, cancelled = false;
  const calls = [], uploads = [], stored = new Map();
  const json = async (route, status, value) => {
    try { await route.fulfill({ status, contentType: 'application/json',
      headers: { 'X-Pocket-Machine': 'ged', 'cache-control': 'no-store' }, body: JSON.stringify(value) }); }
    catch (error) {
      // Session teardown can abort a held PUT before its synthetic late reply.
      // Only that observed network cancellation (or harness close) is expected.
      if (!page.isClosed() && !route.request().failure()) throw error;
    }
  };
  const uploadState = () => {
    const descriptors = record.input.attachmentUploads.map(file => ({ ...file, status: stored.has(file.id) ? 'uploaded' : 'missing',
      ...(stored.has(file.id) ? { attachment: stored.get(file.id) } : {}) }));
    const ready = stored.size === descriptors.length;
    return { uploadProgress: { total: descriptors.length, uploaded: stored.size, status: ready ? 'ready' : 'uploading',
      ...(ready ? {} : { code: 'attachments_uploading' }) },
      attachmentUploads: descriptors };
  };
  const syncQueue = () => {
    if (!record) return;
    const queue = cancelled ? [] : [{ id: record.input.requestId, text: record.input.text, status: 'queued', revision: 0,
      autoDirect: record.input.autoDirect, createdAt: record.createdAt, attachments: [...stored.values()], ...uploadState() }];
    harness.patchHistory(ids.regular, { outbox: queue });
  };
  await page.route(/\/api\/(?:auth\/(?:status|login|logout)|tasks\/[^/]+\/(?:messages(?:\/[^/?]+)?|attachments(?:\/[^/?]+)?|outbox\/[^/?]+))(?:\?.*)?$/, async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    assert.equal(url.origin, origin);
    const path = url.pathname, call = { path, method, at: Date.now() }; calls.push(call);
    if (path === '/api/auth/status') return await json(route, 200, { authenticated });
    if (path === '/api/auth/login' && method === 'POST') {
      assert.equal(request.postDataJSON().passphrase, 'synthetic-passphrase'); authenticated = true;
      return await json(route, 200, { authenticated: true });
    }
    if (path === '/api/auth/logout' && method === 'POST') { authenticated = false; return await json(route, 200, {}); }
    if (path === `/api/tasks/${ids.regular}/messages` && method === 'POST') {
      assert.equal(record, undefined, 'A session cannot replay the original reservation');
      const input = request.postDataJSON(); assert.equal(input.attachmentUploads.length, 2); assert.equal(input.attachments, undefined);
      record = { input, createdAt: Date.now() }; syncQueue();
      return await json(route, 202, { requestId: input.requestId, status: 'queued', queueRevision: 0, ...uploadState() });
    }
    if (path.startsWith(`/api/tasks/${ids.regular}/messages/`) && method === 'GET') {
      if (expireNextReceipt) { expireNextReceipt = false; authenticated = false; }
      call.authenticated = authenticated;
      if (!authenticated) return await json(route, 401, { error: '请先登录' });
      assert.equal(path.split('/').at(-1), record.input.requestId);
      return await json(route, 200, { requestId: record.input.requestId, status: cancelled ? 'cancelled' : 'queued',
        ...(cancelled ? {} : { queueRevision: 0 }), ...uploadState() });
    }
    if (path === `/api/tasks/${ids.regular}/attachments` && method === 'GET')
      return await json(route, 200, { attachments: cancelled ? [...stored.values()] : [] });
    if (path.startsWith(`/api/tasks/${ids.regular}/outbox/`) && method === 'DELETE') {
      assert.equal(path.split('/').at(-1), record.input.requestId); assert.equal(request.postDataJSON().expectedRevision, 0);
      cancelled = true; syncQueue(); return await json(route, 200, { outbox: [] });
    }
    if (path.startsWith(`/api/tasks/${ids.regular}/attachments/`) && method === 'PUT') {
      const name = url.searchParams.get('name'), source = name === activeFile.name ? activeFile : name === waitingFile.name ? waitingFile : null;
      assert.ok(source); const gate = deferred(), id = path.split('/').at(-1); uploads.push({ id, name, gate });
      await gate.promise;
      const sha256 = createHash('sha256').update(source.buffer).digest('hex');
      const attachment = { id, name, mime: source.mimeType, kind: 'file', size: source.buffer.length,
        sourceSize: source.buffer.length, sha256, sourceSha256: sha256, url: `/api/tasks/${ids.regular}/attachments/${id}` };
      stored.set(id, attachment); syncQueue(); return await json(route, 200, attachment);
    }
    return await route.fallback();
  });
  // An actual File.arrayBuffer read is held, retaining its exact bytes and
  // upload identity while auth changes; production hashing/network slots stay
  // untouched. This makes a queued pre-PUT job deterministic in both engines.
  await page.evaluate(name => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function() {
      if (this.name !== name) return original.call(this);
      const file = this;
      return new Promise(resolve => { window.releaseSessionFileRead = () => { resolve(original.call(file)); }; });
    };
  }, waitingFile.name);
  return { calls, uploads, expire() { expireNextReceipt = true; }, get record() { return record; },
    get storedCount() { return stored.size; },
    releaseUploads() { uploads.forEach(upload => upload.gate.resolve()); }, close() { uploads.forEach(upload => upload.gate.resolve()); } };
}

for (const engine of engines) {
  test(`${engine}: cancelling a ready queued upload restores its files and ends its original polling owner`, { timeout: 45000 }, async () => {
    const result = { engine, mode: 'ready-cancel', passed: false }; let harness, service, failure;
    try {
      harness = await createHarness(engine); result.build = harness.build;
      const page = await harness.open(); service = await installSession(page, harness);
      await page.evaluate(() => {
        const key = 'pocket.auto-direct-send.v1'; localStorage.setItem(key, JSON.stringify(false));
        window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(false) }));
      });
      await textarea(page).click(); await textarea(page).pressSequentially('Original queued query');
      await page.locator('[data-attachment-input]').setInputFiles([activeFile, waitingFile]);
      await until(() => service.uploads.length === 1);
      await page.locator('.conversation-composer button[type="submit"]').click(); await until(() => !!service.record);
      assert.equal(service.record.input.autoDirect, false);
      const row = page.locator(`article[data-query-id="${service.record.input.requestId}"]`); await row.waitFor();
      await page.evaluate(() => window.releaseSessionFileRead?.()); await until(() => service.uploads.length === 2);
      service.releaseUploads(); await until(() => service.storedCount === 2);
      await until(async () => await row.getAttribute('data-query-state') === 'queued');
      await textarea(page).click(); await textarea(page).pressSequentially('Keep the independent next draft');
      const cancel = row.locator('button').filter({ hasText: /^(删除|取消发送)$/ });
      assert.equal(await cancel.count(), 1); await cancel.click();
      await row.waitFor({ state: 'detached' });
      await until(async () => await page.locator('.draft-attachments [data-attachment-id]').count() === 2);
      assert.equal(await textarea(page).inputValue(), 'Keep the independent next draft');
      const reads = service.calls.filter(call => call.method === 'GET' && /\/messages\//.test(call.path)).length;
      await page.waitForTimeout(1750);
      assert.equal(service.calls.filter(call => call.method === 'GET' && /\/messages\//.test(call.path)).length, reads,
        'The hidden cancelled row does not retain its original receipt poller');
      assert.equal(service.uploads.length, 2);
      assert.equal(service.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
      assert.equal(service.calls.filter(call => call.method === 'DELETE' && /\/outbox\//.test(call.path)).length, 1);
      assert.equal([...service.calls, ...harness.calls].filter(call => call.method === 'DELETE' && /\/attachments\//.test(call.path)).length, 0,
        'Ready queue cancellation returns uploaded files instead of deleting them');
      assert.deepEqual(harness.errors, []); assert.deepEqual(harness.unexpected, []);
      result.uploads = service.uploads.length; result.restoredFiles = 2; result.receipts = reads;
    } catch (error) { failure = error; }
    finally {
      service?.close();
      try { await harness?.close(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
      result.passed = !failure; if (failure) result.error = failure.stack || String(failure); results.push(result);
    }
    if (failure) throw failure;
  });
}

for (const engine of engines) for (const mode of ['expiry', 'logout']) {
  test(`${engine}: ${mode} ends the upload session while late work cannot enter a new login`, { timeout: 45000 }, async () => {
    const result = { engine, mode, passed: false }; let harness, service, failure;
    try {
      harness = await createHarness(engine); result.build = harness.build;
      const page = await harness.open(); service = await installSession(page, harness);
      await textarea(page).click(); await textarea(page).pressSequentially('Original reserved query');
      await page.locator('[data-attachment-input]').setInputFiles([activeFile, waitingFile]);
      await until(() => service.uploads.length === 1);
      assert.equal(service.uploads[0].name, activeFile.name);
      await page.locator('.conversation-composer button[type="submit"]').click();
      await until(() => !!service.record);
      await page.locator(`article[data-query-id="${service.record.input.requestId}"]`).waitFor();
      assert.equal(await textarea(page).inputValue(), '');
      if (mode === 'expiry') service.expire();
      else {
        await page.locator('[data-inspector-close]').click();
        await page.getByRole('button', { name: '打开导航', exact: true }).click();
        await page.locator('.sidebar-settings').click();
        await page.locator('.settings-logout-button').click();
      }
      await page.locator('.access-screen #passphrase').waitFor();
      await until(() => page.locator('.app-shell').count().then(count => count === 0));
      const endedAt = service.calls.length;
      await page.waitForTimeout(1750);
      assert.equal(service.calls.length, endedAt, 'An ended authenticated App has no orphan receipt polling or uploads');
      if (mode === 'expiry') assert.equal(service.calls.filter(call => call.authenticated === false).length, 1);
      await page.locator('#passphrase').fill('synthetic-passphrase');
      await page.locator('.access-submit').click();
      await page.locator('.app-shell').waitFor();
      if (!await page.locator('.conversation-live').count()) await page.locator(`[data-thread-id="${ids.regular}"]`).first().click();
      await textarea(page).click(); await textarea(page).pressSequentially('A new login owns this draft');
      await page.evaluate(() => window.releaseSessionFileRead?.());
      service.releaseUploads(); await page.waitForTimeout(1750);
      assert.equal(await textarea(page).inputValue(), 'A new login owns this draft', 'Late hash/upload completion cannot replace the new session draft');
      assert.equal(service.uploads.length, 1, 'The disposed session never starts its still-unuploaded File');
      assert.equal(service.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages')).length, 1);
      assert.equal([...service.calls, ...harness.calls].filter(call => call.method === 'DELETE').length, 0,
        'Local disposal does not cancel a persisted remote intent');
      assert.deepEqual(harness.errors, []); assert.deepEqual(harness.unexpected, []);
      result.receipts = service.calls.filter(call => call.method === 'GET' && /\/messages\//.test(call.path)).length;
      result.uploads = service.uploads.length;
    } catch (error) { failure = error; }
    finally {
      service?.close();
      try { await harness?.close(); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
      result.passed = !failure; if (failure) result.error = failure.stack || String(failure); results.push(result);
    }
    if (failure) throw failure;
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';
import { messageFingerprint } from '../server/attachments.mjs';
import http from 'node:http';
import { makeApp } from '../server/index.mjs';
import { execFileSync } from 'node:child_process';

const thread = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const turn = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const uid = n => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
const rid = n => `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`;
const bytes = Buffer.from('immutable original file');
const sha = value => createHash('sha256').update(value).digest('hex');
const descriptor = n => ({ id: uid(n), name: `notes-${n}.txt`, size: bytes.length, mime: 'text/plain', sourceSha256: sha(bytes) });
const source = () => ({ threads: [thread, other].map(id => ({ id, title: 'Fixture', cwd: '/fixture', archived: false })), projects: [], sourceInfo: {} });
async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await check()) return; await delay(5); }
  assert.fail('Timed out observing durable upload state');
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-upload-reservations-'));
  const state = { calls: [], active: false, messages: [], result: { ok: true, turnId: turn } };
  const request = async payload => {
    state.calls.push(structuredClone(payload));
    if (payload.operation === 'history') return { ok: true, source: 'desktop', runtime: state.active ? 'active' : 'idle',
      canSend: true, queueReady: !state.active, resumeState: 'resumed', latestTurnId: turn,
      latestTurnStatus: state.active ? 'inProgress' : 'completed', messages: state.messages };
    assert.equal(payload.operation, 'send');
    return state.result;
  };
  const f = { directory, state, request, store: new NavigatorStore(directory), service: null };
  f.store.sync(source());
  const create = () => new DesktopService(f.store, directory, request, () => ({ source: 'rollout', messages: [] }), { attachmentOptions: options });
  f.service = create();
  f.restart = async () => {
    f.service.stopQueue();
    await Promise.allSettled([...f.service.uploadReservations.finalizing.values()]);
    f.store.close(); f.store = new NavigatorStore(directory); f.service = create();
    f.service.startQueue(); f.service.stopQueue();
  };
  f.submit = (n, descriptors = [descriptor(1)], extra = {}) => f.service.send(thread, { requestId: rid(n), text: 'Read all the files', attachmentUploads: descriptors, enqueue: true, autoDirect: true, ...extra });
  f.upload = (n, requestId = rid(1), body = bytes) => f.service.attachments.uploadReserved(thread, requestId, uid(n), descriptor(n).name, 'text/plain', Readable.from([body]));
  t.after(async () => {
    f.service.stopQueue(); await Promise.allSettled([...f.service.uploadReservations.finalizing.values()]);
    f.store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return f;
}

test('submitting a manifest persists one stable queue row immediately, without history, connection or partial dispatch', async t => {
  const f = fixture(t), manifest = [descriptor(1), descriptor(2)];
  const receipt = await f.submit(1, manifest, { text: '' });
  assert.equal(receipt.status, 'queued'); assert.equal(receipt.code, 'attachments_uploading');
  assert.deepEqual(receipt.uploadProgress, { total: 2, uploaded: 0, status: 'uploading', code: 'attachments_uploading' });
  assert.equal(f.service.outbox(thread).length, 1); assert.equal(f.service.outbox(thread)[0].text, '');
  assert.deepEqual(f.service.outbox(thread)[0].attachments, []);
  await f.service.processQueue(); f.service.connectForSubmission(thread);
  assert.deepEqual(f.state.calls, []);
  await f.upload(1); await f.service.processQueue();
  assert.equal(f.service.getReceipt(thread, rid(1)).uploadProgress.uploaded, 1);
  assert.deepEqual(f.state.calls, []);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_dispatches').get().n, 0);
  await assert.rejects(f.service.dispatchQueued(thread, rid(1), { expectedRevision: 0 }), error => error.status === 409);
  assert.deepEqual(f.state.calls, []);
  assert.throws(() => f.service.editQueued(thread, rid(1), { expectedRevision: 0, text: 'edited' }), error => error.status === 409);
  assert.equal(f.service.outbox(thread)[0].revision, 0);
});

test('all sixteen files stream at once, seal the original hash, and dispatch once under the original request ID', async t => {
  const f = fixture(t), manifest = Array.from({ length: 16 }, (_, index) => descriptor(index + 1));
  f.state.active = true;
  const input = { requestId: rid(1), text: 'Read all the files', attachmentUploads: manifest, enqueue: true, autoDirect: true };
  await f.service.send(thread, input);
  const streams = Array.from({ length: 16 }, () => new PassThrough());
  const pending = streams.map((stream, index) => f.service.attachments.uploadReserved(thread, rid(1), uid(index + 1), descriptor(index + 1).name, 'text/plain', stream));
  assert.equal(f.service.attachments.uploads.size, 16);
  await assert.rejects(f.service.attachments.upload(thread, uid(17), descriptor(17).name, 'text/plain', Readable.from([bytes])), error => error.status === 409);
  await f.service.processQueue(); assert.deepEqual(f.state.calls, []);
  for (const stream of streams.slice(0, 15)) stream.end(bytes);
  await Promise.all(pending.slice(0, 15));
  await f.service.processQueue();
  assert.deepEqual(f.state.calls, [], 'fifteen completed files cannot authorize a sixteen-file message');
  assert.equal(f.service.getReceipt(thread, rid(1)).uploadProgress.uploaded, 15);
  streams[15].end(bytes); await pending[15];
  await eventually(() => f.service.getReceipt(thread, rid(1)).uploadProgress.status === 'ready');
  const ready = f.service.getReceipt(thread, rid(1));
  assert.equal(ready.status, 'queued', 'ready upload progress is not an accepted native receipt');
  assert.equal(ready.uploadProgress.uploaded, 16);
  const saved = f.service.attachments.forDispatch(thread, rid(1));
  assert.equal(saved.length, 16);
  assert.equal(f.store.db.prepare('SELECT text_hash FROM dispatches WHERE id=?').get(rid(1)).text_hash, messageFingerprint(input.text, saved));
  assert.deepEqual(f.service.attachments.list(thread).attachments, []);
  await f.service.processQueue(); await f.service.processQueue();
  const sent = f.state.calls.filter(call => call.operation === 'send');
  assert.equal(sent.length, 1); assert.equal(sent[0].requestId, rid(1)); assert.equal(sent[0].delivery, 'auto-now');
  assert.equal(sent[0].attachments.length, 16);
  assert.deepEqual(sent[0].attachments.map(value => value.sha256), manifest.map(() => sha(bytes)));
  assert.equal(Object.hasOwn(sent[0], 'model'), false); assert.equal(Object.hasOwn(sent[0], 'cwd'), false);
  assert.equal((await f.service.send(thread, input)).status, 'accepted');
  await assert.rejects(f.service.send(thread, { ...input, text: 'different' }), error => error.status === 409);
  await assert.rejects(f.service.send(thread, { ...input, attachmentUploads: manifest.toReversed() }), error => error.status === 409);
  await assert.rejects(f.service.send(thread, { ...input, autoDirect: false }), error => error.status === 409);
  await assert.rejects(f.service.send(thread, { ...input, enqueue: undefined }), error => error.status === 409);
  assert.equal(f.state.calls.filter(call => call.operation === 'send').length, 1);
});

test('the manifest validator rejects malformed inputs and collisions before reserving or consuming a queue row', async t => {
  const f = fixture(t), valid = descriptor(1);
  const invalid = [null, [], {}, [null], [valid, valid], Array.from({ length: 17 }, (_, index) => descriptor(index + 1)),
    [{ ...valid, size: 0 }], [{ ...valid, size: true }], [{ ...valid, size: 20 * 1024 * 1024 + 1 }],
    [{ ...valid, name: '../outside' }], [{ ...valid, mime: 'text/plain\nheader' }], [{ ...valid, sourceSha256: 'wrong' }], [{ ...valid, path: '/outside' }]];
  for (const value of invalid) await assert.rejects(f.submit(1, value), error => error.status === 400);
  await assert.rejects(f.submit(1, [valid], { attachments: [] }), error => error.status === 400);
  assert.equal(f.service.getReceipt(thread, rid(1)).status, 'not_found');
  assert.equal(f.service.outbox(thread).length, 0);
  await f.submit(1);
  await assert.rejects(f.submit(2), error => error.status === 409);
  await assert.rejects(f.service.send(other, { requestId: rid(2), text: '', attachmentUploads: [valid], enqueue: true }), error => error.status === 409);
  const unchanged = f.service.getReceipt(thread, rid(1));
  await assert.rejects(f.service.attachments.uploadReserved(other, rid(1), uid(1), valid.name, 'text/plain', Readable.from([bytes])), error => error.status === 409);
  await assert.rejects(f.service.attachments.uploadReserved(thread, rid(2), uid(1), valid.name, 'text/plain', Readable.from([bytes])), error => error.status === 409);
  assert.deepEqual(f.service.getReceipt(thread, rid(1)), unchanged, 'an unrelated upload request cannot change the original message progress');
  assert.deepEqual(f.state.calls, []);
});

test('existing uploads and a PUT already in flight transfer to the fixed manifest without retransmission or consuming the new draft', async t => {
  const f = fixture(t);
  const first = await f.service.attachments.upload(thread, uid(1), descriptor(1).name, 'text/plain', Readable.from([bytes]));
  const stream = new PassThrough();
  const second = f.service.attachments.upload(thread, uid(2), descriptor(2).name, 'text/plain', stream);
  await f.submit(1, [descriptor(1), descriptor(2)]);
  assert.deepEqual(f.service.attachments.list(thread).attachments, []);
  for (let n = 101; n <= 116; n++) await f.service.attachments.upload(thread, uid(n), descriptor(n).name, 'text/plain', Readable.from([bytes]));
  assert.equal(f.service.attachments.list(thread).attachments.length, 16);
  stream.end(bytes); await second;
  await eventually(() => f.service.getReceipt(thread, rid(1)).uploadProgress.status === 'ready');
  assert.equal(f.service.attachments.forDispatch(thread, rid(1))[0].sha256, first.sha256);
  assert.equal(f.service.attachments.list(thread).attachments.length, 16);
  await f.service.processQueue(); assert.equal(f.state.calls.filter(call => call.operation === 'send').length, 1);
});

test('restart retains a partial manifest, and a missing original File keeps the queue cancellable without sending partial text', async t => {
  const f = fixture(t); await f.submit(1, [descriptor(1), descriptor(2)]); await f.upload(1);
  await f.restart();
  assert.equal(f.service.outbox(thread)[0].uploadProgress.uploaded, 1);
  await f.service.processQueue(); assert.deepEqual(f.state.calls, []);
  const same = await f.submit(1, [descriptor(1), descriptor(2)]);
  assert.equal(same.status, 'queued'); assert.equal(f.service.outbox(thread).length, 1);
  assert.throws(() => f.service.cancelQueued(thread, rid(1), { expectedRevision: 1 }), error => error.status === 409);
  f.service.cancelQueued(thread, rid(1), { expectedRevision: 0 });
  assert.equal(f.service.getReceipt(thread, rid(1)).status, 'cancelled');
  assert.equal(f.service.attachments.list(thread).attachments[0].id, uid(1));
  await f.service.processQueue(); assert.deepEqual(f.state.calls, []);
  assert.equal((await f.submit(1, [descriptor(1), descriptor(2)])).status, 'cancelled');
});

test('cancel and a late ordinary or request-bound PUT return files to drafts and never resurrect dispatch', async t => {
  for (const explicit of [false, true]) await t.test(String(explicit), async t => {
    const f = fixture(t); await f.submit(1);
    const stream = new PassThrough();
    const pending = explicit
      ? f.service.attachments.uploadReserved(thread, rid(1), uid(1), descriptor(1).name, 'text/plain', stream)
      : f.service.attachments.upload(thread, uid(1), descriptor(1).name, 'text/plain', stream);
    f.service.cancelQueued(thread, rid(1), { expectedRevision: 0 });
    stream.end(bytes); await pending; await f.service.processQueue();
    assert.equal(f.service.getReceipt(thread, rid(1)).status, 'cancelled');
    assert.equal(f.service.outbox(thread).length, 0);
    assert.equal(f.service.attachments.list(thread).attachments[0].id, uid(1));
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_links').get().n, 0);
    assert.deepEqual(f.state.calls, []);
    await assert.rejects(f.upload(1), error => error.status === 409);
  });
});

test('pause and acknowledged stop remain authoritative after all files are ready, and legacy autoDirect false still waits', async t => {
  const f = fixture(t); f.state.active = true;
  await f.submit(1); f.service.pauseQueued(thread, rid(1), { expectedRevision: 0 });
  await f.upload(1);
  await eventually(() => f.service.getReceipt(thread, rid(1)).uploadProgress.status === 'ready');
  await f.service.processQueue(); assert.deepEqual(f.state.calls, []);
  assert.equal(f.service.outbox(thread)[0].status, 'editing');
  f.service.pauseQueued(thread, rid(1), { expectedRevision: 1 }, true);
  f.store.db.prepare('INSERT INTO queue_pauses VALUES(?,?,?)').run(thread, rid(100), Date.now());
  await f.service.processQueue(); assert.deepEqual(f.state.calls, []);
  f.store.db.prepare('DELETE FROM queue_pauses WHERE thread_id=?').run(thread);
  await f.service.processQueue(); assert.equal(f.state.calls.filter(call => call.operation === 'send').length, 1);
  const g = fixture(t); g.state.active = true;
  await g.submit(1, [descriptor(1)], { autoDirect: false }); await g.upload(1);
  await eventually(() => g.service.getReceipt(thread, rid(1)).uploadProgress.status === 'ready');
  await g.service.processQueue(); assert.equal(g.state.calls.filter(call => call.operation === 'send').length, 0);
  g.state.active = false; g.service.cache.clear();
  await g.service.processQueue(); assert.equal(g.state.calls.filter(call => call.operation === 'send')[0].delivery, 'auto');
});

test('descriptor mismatch or changed stored bytes stays failed and cannot turn a display read into a receipt', async t => {
  const f = fixture(t); await f.submit(1);
  await assert.rejects(f.upload(1, rid(1), Buffer.from('wrong source bytes')), error => error.status === 409);
  assert.equal(f.service.getReceipt(thread, rid(1)).uploadProgress.status, 'failed');
  await f.service.processQueue(); assert.deepEqual(f.state.calls, []);
  await f.upload(1);
  await eventually(() => f.service.getReceipt(thread, rid(1)).uploadProgress.status === 'ready');
  const path = f.service.attachments.forDispatch(thread, rid(1))[0].path;
  writeFileSync(path, 'changed after upload');
  await f.service.processQueue();
  assert.equal(f.service.getReceipt(thread, rid(1)).status, 'rejected');
  assert.equal(f.service.getReceipt(thread, rid(1)).code, 'attachment_unavailable');
  assert.equal(f.state.calls.filter(call => call.operation === 'send').length, 0);
  const g = fixture(t); await g.submit(1);
  g.state.messages = [{ id: 'untrusted-display', role: 'user', text: 'Read all the files', clientMessageId: rid(1), turnId: turn }];
  await g.service.history(thread);
  assert.equal(g.service.getReceipt(thread, rid(1)).status, 'queued');
  assert.equal(g.service.outbox(thread).length, 1);
});

test('an unknown original dispatch is retained across worker ticks and restart without a second send', async t => {
  const f = fixture(t); f.state.result = { ok: false, sent: null, code: 'dispatch_unknown' };
  await f.submit(1); await f.upload(1);
  await eventually(() => f.service.getReceipt(thread, rid(1)).uploadProgress.status === 'ready');
  await f.service.processQueue(); await f.service.processQueue();
  assert.equal(f.service.getReceipt(thread, rid(1)).status, 'unknown');
  await f.restart(); await f.service.processQueue();
  assert.equal((await f.submit(1)).status, 'unknown');
  assert.equal(f.state.calls.filter(call => call.operation === 'send').length, 1);
});

test('a converted HEIC seals the declared original hash and size while dispatch retains the canonical JPEG hash', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==', 'base64');
  const sourcePath = join(f.directory, 'source.png'), heicPath = join(f.directory, 'source.heic');
  writeFileSync(sourcePath, png);
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', sourcePath, '--out', heicPath], { stdio: 'ignore' });
  const original = readFileSync(heicPath);
  const image = { id: uid(1), name: 'photo.heic', size: original.length, mime: 'image/heic', sourceSha256: sha(original) };
  await f.submit(1, [image], { text: '' });
  const uploaded = await f.service.attachments.uploadReserved(thread, rid(1), image.id, image.name, image.mime, Readable.from([original]));
  assert.equal(uploaded.sourceSize, image.size); assert.equal(uploaded.sourceSha256, image.sourceSha256);
  assert.equal(uploaded.mime, 'image/jpeg'); assert.notEqual(uploaded.sha256, image.sourceSha256);
  await eventually(() => f.service.getReceipt(thread, rid(1)).uploadProgress.status === 'ready');
  await f.service.processQueue();
  const sent = f.state.calls.find(call => call.operation === 'send');
  assert.equal(sent.attachments[0].sha256, uploaded.sha256);
  assert.equal(sent.attachments[0].size, uploaded.size);
  assert.equal(sent.attachments[0].mime, 'image/jpeg');
  assert.deepEqual((await f.service.attachments.read(thread, image.id)).bytes, readFileSync(f.service.attachments.row(thread, image.id).path));
});

test('durable missing-file claims preserve the existing row ceiling and PUT retains the disk reservation budget', async t => {
  const f = fixture(t);
  const insert = f.store.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)');
  for (let n = 1; n <= 1999; n++) insert.run(uid(1000 + n), other, JSON.stringify({ id: uid(1000 + n), threadId: other }), 0, Date.now());
  await assert.rejects(f.submit(1, [descriptor(1), descriptor(2)]), error => error.status === 413);
  assert.equal(f.service.getReceipt(thread, rid(1)).status, 'not_found');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_upload_claims').get().n, 0);
  await f.submit(1);
  await assert.rejects(f.service.attachments.upload(thread, uid(2), descriptor(2).name, 'text/plain', Readable.from([bytes])), error => error.status === 413);
  assert.equal((await f.upload(1)).size, bytes.length, 'the reserved file can consume its already-counted row');
  const g = fixture(t, { maxBytes: 10, maxTotalBytes: 31 });
  const tiny = n => ({ ...descriptor(n), size: 5, sourceSha256: sha(Buffer.from('hello')) });
  await g.submit(1, [tiny(1)]); await g.upload(1, rid(1), Buffer.from('hello'));
  await g.submit(2, [tiny(2)]);
  await assert.rejects(g.upload(2, rid(2), Buffer.from('hello')), error => error.status === 413);
  assert.equal(g.service.getReceipt(thread, rid(2)).uploadProgress.status, 'failed');
  assert.equal(g.service.outbox(thread).length, 2);
  assert.equal(g.state.calls.length, 0);
});

test('finalization cannot overwrite cancellation or a newer pause revision during asynchronous hash verification', async t => {
  for (const action of ['cancel', 'pause']) await t.test(action, async t => {
    const f = fixture(t);
    await f.service.attachments.upload(thread, uid(1), descriptor(1).name, 'text/plain', Readable.from([bytes]));
    await f.submit(1);
    const original = f.service.attachments.prepare.bind(f.service.attachments);
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    f.service.attachments.prepare = async files => { entered(); await new Promise(resolve => { release = resolve; }); return original(files); };
    const pending = f.service.uploadReservations.finalize(thread, rid(1)); await started;
    if (action === 'cancel') f.service.cancelQueued(thread, rid(1), { expectedRevision: 0 });
    else f.service.pauseQueued(thread, rid(1), { expectedRevision: 0 });
    release(); assert.equal(await pending, false);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_dispatches').get().n, 0);
    assert.deepEqual(f.state.calls, []);
    if (action === 'cancel') {
      assert.equal(f.service.getReceipt(thread, rid(1)).status, 'cancelled');
      assert.equal(f.service.attachments.list(thread).attachments.length, 1);
    } else {
      assert.equal(f.service.outbox(thread)[0].revision, 1);
      f.service.attachments.prepare = original;
      await f.service.processQueue();
      assert.equal(f.service.outbox(thread)[0].status, 'editing');
      assert.equal(f.service.getReceipt(thread, rid(1)).uploadProgress.status, 'ready');
    }
  });
});

test('authenticated HTTP manifest, receipt and sixteen-slot upload paths dispatch all files once and expose no private paths', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-upload-reservations-http-'));
  const calls = [], active = [];
  const app = makeApp({ dataDir: directory, codexHome: directory, readSource: source, openThread: async () => { throw new Error('Native open forbidden'); },
    desktopRequest: async payload => {
      calls.push(structuredClone(payload));
      if (payload.operation === 'history') return { ok: true, source: 'desktop', runtime: 'idle', canSend: true, queueReady: true, resumeState: 'resumed', messages: [] };
      assert.equal(payload.operation, 'send'); return { ok: true, turnId: turn };
    }, readHistory: () => ({ messages: [] }) });
  t.after(async () => {
    for (const request of active) request.destroy();
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await fetch(base + '/api/catalog', { headers: auth }).then(response => response.json());
  const headers = { ...auth, Origin: base, 'X-Navigator-Token': catalog.csrfToken, 'Content-Type': 'application/json' };
  const url = `/api/tasks/${thread}/messages`, receiptUrl = `${url}/${rid(1)}`;
  const input = { requestId: rid(1), text: '', enqueue: true, autoDirect: true, attachmentUploads: Array.from({ length: 16 }, (_, index) => descriptor(index + 1)) };
  const post = (extra = {}) => fetch(base + url, { method: 'POST', headers, body: JSON.stringify({ ...input, ...extra }) });
  assert.equal((await fetch(base + url, { method: 'POST', headers: { ...headers, 'X-Navigator-Token': '' }, body: JSON.stringify(input) })).status, 403);
  const submitted = await post(); assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).status, 'queued');
  assert.equal((await post()).status, 200);
  assert.equal((await post({ text: 'changed body' })).status, 409);
  assert.equal((await fetch(base + receiptUrl)).status, 401);
  const read = () => fetch(base + receiptUrl, { headers: auth }).then(response => response.json());
  assert.equal((await read()).uploadProgress.uploaded, 0); assert.deepEqual(calls, []);
  const path = n => `/api/tasks/${thread}/attachments/${uid(n)}`;
  const start = (n, reserved = true) => {
    let settle;
    const response = new Promise(resolve => { settle = resolve; });
    const request = http.request(base + path(n) + `?name=${descriptor(n).name}${reserved ? `&requestId=${rid(1)}` : ''}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/plain' } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => settle({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }));
      incoming.on('error', error => settle({ error }));
    });
    request.on('error', error => settle({ error })); active.push(request); request.write(bytes.subarray(0, 1));
    return { request, response };
  };
  const streams = [];
  for (let n = 1; n <= 16; n++) {
    streams.push(start(n));
    await eventually(async () => (await fetch(base + path(n) + '?metadata=1', { headers: auth })).status === 409);
  }
  const rejected = start(17, false); rejected.request.end(bytes.subarray(1)); assert.equal((await rejected.response).status, 409);
  assert.equal(calls.filter(call => call.operation === 'send').length, 0);
  for (const stream of streams.slice(0, 15)) stream.request.end(bytes.subarray(1));
  for (const stream of streams.slice(0, 15)) assert.equal((await stream.response).status, 200);
  assert.equal((await read()).uploadProgress.uploaded, 15);
  assert.equal(calls.filter(call => call.operation === 'send').length, 0);
  streams[15].request.end(bytes.subarray(1)); assert.equal((await streams[15].response).status, 200);
  await eventually(async () => (await read()).status === 'accepted');
  const receipt = await read();
  assert.equal(receipt.uploadProgress.status, 'ready'); assert.equal(receipt.uploadProgress.uploaded, 16);
  assert.equal(calls.filter(call => call.operation === 'send').length, 1);
  assert.equal(calls.find(call => call.operation === 'send').attachments.length, 16);
  assert.equal((await post()).status, 200);
  assert.equal(JSON.stringify(receipt).includes(directory), false);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM outgoing_messages').get().n, 0);
  assert.equal((await fetch(base + `/api/tasks/${thread}/attachments`, { headers: auth }).then(response => response.json())).attachments.length, 0);
  assert.equal((await fetch(base + path(100) + `?name=other.txt&requestId=${rid(1)}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'text/plain' }, body: bytes })).status, 409);
  assert.equal(calls.filter(call => call.operation === 'send').length, 1);
});

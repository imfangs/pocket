import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { NavigatorStore } from '../server/store.mjs';
import { Attachments } from '../server/attachments.mjs';
import { makeApp } from '../server/index.mjs';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_UPLOADS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES } from '../shared/attachment-limits.mjs';

const thread = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const request = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const uid = n => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
const source = () => ({ threads: [thread, other].map(id => ({ id, title: 'Fixture', cwd: '/fixture', archived: false })), projects: [], sourceInfo: {} });
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-attachment-limits-'));
  const store = new NavigatorStore(directory); store.sync(source());
  const attachments = new Attachments(store, options);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const upload = (n, owner) => owner
    ? attachments.uploadForMessage(thread, owner, uid(n), 'notes.txt', 'text/plain', Readable.from([Buffer.from('hello')]))
    : attachments.upload(thread, uid(n), 'notes.txt', 'text/plain', Readable.from([Buffer.from('hello')]));
  return { directory, store, attachments, upload };
}
async function eventually(check) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('Timed out observing the actual upload state');
}

test('sixteen stored files remain visible and bindable, while a seventeenth or duplicate snapshot is rejected', async t => {
  const f = fixture(t);
  assert.equal(MAX_ATTACHMENTS, 16); assert.equal(MAX_ATTACHMENT_UPLOADS, 16);
  assert.equal(f.attachments.maxBytes, MAX_ATTACHMENT_BYTES);
  assert.equal(f.attachments.maxTotalBytes, MAX_ATTACHMENT_TOTAL_BYTES);
  assert.equal(MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_ATTACHMENT_TOTAL_BYTES, 1024 * 1024 * 1024);
  const uploaded = [];
  for (let n = 1; n <= 16; n++) uploaded.push(await f.upload(n));
  assert.deepEqual(f.attachments.list(thread).attachments.map(value => value.id), uploaded.map(value => value.id));
  await assert.rejects(f.upload(17), error => error.status === 409);
  assert.deepEqual(await f.upload(16), uploaded[15], 'an identical original-ID upload remains idempotent at capacity');
  const ids = uploaded.map(value => value.id), resolved = f.attachments.resolve(thread, ids, request);
  assert.throws(() => f.attachments.resolve(thread, [...ids, uid(17)], request), error => error.status === 400);
  assert.throws(() => f.attachments.bind(thread, request, 'too many', [...resolved, { ...resolved[0], id: uid(17) }]), error => error.status === 400);
  assert.throws(() => f.attachments.bind(thread, request, 'duplicate', [resolved[0], resolved[0]]), error => error.status === 400);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_dispatches').get().n, 0);
  await assert.rejects(f.attachments.prepare([...resolved, { ...resolved[0], id: uid(17) }]), error => error.status === 400);
  assert.equal((await f.attachments.prepare(resolved)).length, 16);
  f.attachments.bind(thread, request, 'all files', resolved);
  assert.equal(f.attachments.forDispatch(thread, request).length, 16);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_links WHERE request_id=?').get(request).n, 16);
  assert.deepEqual(f.attachments.list(thread).attachments, []);
  f.attachments.release(request);
  assert.equal(f.attachments.list(thread).attachments.length, 16, 'ordinary cancelled attachment references return to the draft');
});

test('internal message reservations accept sixteen manifests, bind only matching owners, and retain immutable original IDs', async t => {
  const f = fixture(t);
  const files = [];
  for (let n = 1; n <= 16; n++) files.push(await f.upload(n, request));
  await assert.rejects(f.upload(17, request), error => error.status === 409);
  assert.deepEqual(await f.upload(16, request), files[15]);
  const resolved = f.attachments.resolve(thread, files.map(value => value.id), request);
  f.attachments.bind(thread, request, 'reserved files', resolved);
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(join(f.attachments.root, file.id, '.message-upload.json'), 'utf8'));
    assert.equal(manifest.requestId, request);
    assert.equal(manifest.data.internalRequestId, request);
    assert.equal(manifest.data.sha256, file.sha256);
  }
  assert.throws(() => f.attachments.resolve(thread, [uid(1)], uid(100)), error => error.status === 409);
  assert.throws(() => f.attachments.resolve(other, [uid(1)], request), error => error.status === 404);
  assert.deepEqual(f.attachments.list(thread).attachments, []);
  f.attachments.release(request);
  assert.deepEqual(f.attachments.list(thread).attachments, [], 'internal ownership survives cancellation');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_links').get().n, 0);
});

test('concurrent stream reservations include source, conversion, preview and manifests, and cancellation frees the reservation', async t => {
  // A tiny per-file limit keeps the quota boundary test cheap, while admission
  // still reserves both possible canonical files, a preview, and each manifest.
  const maxBytes = 10, reservation = maxBytes * 3 + 65536;
  const f = fixture(t, { maxBytes, maxTotalBytes: reservation * 2 });
  // A waiting message can have a stable identity, but no native attachment
  // projection exists until the full verified dispatch snapshot is bound.
  f.store.db.exec('CREATE TABLE dispatches(id TEXT PRIMARY KEY,status TEXT NOT NULL)');
  f.store.db.prepare("INSERT INTO dispatches VALUES(?,'pending')").run(request);
  const history = { source: 'desktop', messages: [{ id: 'synthetic-user', role: 'user', text: 'waiting files', clientMessageId: request }] };
  const first = new PassThrough(), second = new PassThrough();
  // Cancellation may race the asynchronous file open, before async iteration
  // attaches its own error handler. Keep that real startup cancellation safe.
  for (const stream of [first, second]) stream.on('error', () => {});
  const pending = [first, second].map((stream, index) => f.attachments.uploadForMessage(thread, request, uid(index + 1), 'notes.txt', 'text/plain', stream));
  const outcomes = pending.map(promise => promise.then(value => ({ value }), error => ({ error })));
  await eventually(() => f.attachments.pendingPaths.size === 2 && readdirSync(f.attachments.root).length === 2);
  await assert.rejects(f.upload(3, request), error => error.status === 413);
  assert.equal(f.attachments.uploads.size, 2);
  assert.equal(f.attachments.messageUploads.size, 2);
  assert.throws(() => f.attachments.resolve(thread, [uid(1), uid(2)], request), error => error.status === 404, 'pending files cannot be resolved into a dispatch snapshot');
  assert.throws(() => f.attachments.bind(thread, request, 'waiting files', [{ id: uid(1) }, { id: uid(2) }]), error => error.status === 404);
  assert.equal(f.attachments.enrich(thread, history).messages[0].attachments, undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_links').get().n, 0);
  first.destroy(new Error('cancelled stream'));
  assert.match((await outcomes[0]).error.message, /cancelled stream/);
  assert.equal(f.attachments.uploads.size, 1); assert.equal(f.attachments.messageUploads.size, 1);
  const replacement = await f.upload(3, request);
  assert.equal(replacement.sourceSize, 5);
  assert.throws(() => f.attachments.resolve(thread, [uid(2), uid(3)], request), error => error.status === 404);
  assert.equal(f.attachments.enrich(thread, history).messages[0].attachments, undefined);
  second.end('hello');
  assert.equal((await outcomes[1]).value.sourceSize, 5);
  assert.equal(f.attachments.uploads.size, 0); assert.equal(f.attachments.messageUploads.size, 0);
  assert.deepEqual(readdirSync(f.attachments.root).filter(name => name.startsWith('.pending-')), []);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_links WHERE request_id=?').get(request).n, 2);
  const resolved = f.attachments.resolve(thread, [uid(2), uid(3)], request);
  assert.equal((await f.attachments.prepare(resolved)).length, 2);
  f.attachments.bind(thread, request, 'waiting files', resolved);
  assert.deepEqual(f.attachments.enrich(thread, history).messages[0].attachments.map(value => value.id), [uid(2), uid(3)]);
});

test('the existing two-thousand-file ceiling includes in-flight new files and frees cancelled admission', async t => {
  const f = fixture(t);
  const insert = f.store.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)');
  for (let n = 1; n <= 1999; n++) insert.run(uid(1000 + n), other, JSON.stringify({ id: uid(1000 + n), threadId: other }), 0, Date.now());
  const stream = new PassThrough();
  stream.on('error', () => {});
  const pending = f.attachments.upload(thread, uid(1), 'notes.txt', 'text/plain', stream).then(value => ({ value }), error => ({ error }));
  await eventually(() => f.attachments.pendingPaths.size === 1 && readdirSync(f.attachments.root).length === 1);
  await assert.rejects(f.upload(2), error => error.status === 413);
  stream.destroy(new Error('cancelled capacity reservation'));
  assert.match((await pending).error.message, /cancelled capacity reservation/);
  assert.equal(f.attachments.newUploads.size, 0);
  assert.equal((await f.upload(2)).size, 5);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 2000);
  await assert.rejects(f.upload(3), error => error.status === 413);
  assert.equal((await f.upload(2)).size, 5, 'a verified same-ID replay does not consume a new row');
});

test('actual authenticated HTTP streams occupy sixteen global slots, reject a seventeenth, and release aborted slots', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-attachment-http-slots-'));
  let nativeCalls = 0;
  const app = makeApp({ dataDir: directory, codexHome: directory, readSource: source,
    desktopRequest: async () => { nativeCalls++; throw new Error('Native requests are forbidden'); }, openThread: async () => { throw new Error('Native open is forbidden'); } });
  const active = [];
  t.after(async () => {
    for (const request of active) request.destroy();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await fetch(base + '/api/catalog', { headers: auth }).then(response => response.json());
  const headers = { ...auth, Origin: base, 'X-Navigator-Token': catalog.csrfToken, 'Content-Type': 'text/plain' };
  const path = n => `/api/tasks/${n % 2 ? thread : other}/attachments/${uid(n)}`;
  const start = n => {
    let settle;
    const response = new Promise(resolve => { settle = resolve; });
    const request = http.request(base + path(n) + '?name=notes.txt', { method: 'PUT', headers }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => settle({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }));
      incoming.on('error', error => settle({ error }));
    });
    request.on('error', error => settle({ error }));
    active.push(request); request.write('h');
    return { request, response };
  };
  const streams = [];
  for (let n = 1; n <= 16; n++) {
    streams.push(start(n));
    await eventually(async () => (await fetch(base + path(n) + '?metadata=1', { headers: auth })).status === 409);
  }
  const seventeenth = start(17); seventeenth.request.end('ello');
  assert.equal((await seventeenth.response).status, 409);
  streams[0].request.destroy(new Error('cancelled HTTP upload'));
  await streams[0].response;
  await eventually(async () => (await fetch(base + path(1) + '?metadata=1', { headers: auth })).status === 404);
  const replacement = start(18); replacement.request.end('ello');
  assert.equal((await replacement.response).status, 200);
  for (const stream of streams.slice(1)) stream.request.end('ello');
  for (const stream of streams.slice(1)) assert.equal((await stream.response).status, 200);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 16);
  assert.equal((await fetch(base + path(17) + '?metadata=1', { headers: auth })).status, 404);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_dispatches').get().n, 0);
  assert.equal(nativeCalls, 0);
});

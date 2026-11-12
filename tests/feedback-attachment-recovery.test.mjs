import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { NavigatorStore } from '../server/store.mjs';
import { Attachments } from '../server/attachments.mjs';
import { DesktopService } from '../server/desktop.mjs';

const thread = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secondRequest = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const asset = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const id = n => `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, '0')}`;
const text = Buffer.from('same immutable feedback bytes');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==', 'base64');
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'feedback-attachment-recovery-'));
  let store = new NavigatorStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.sync({ threads: [{ id: thread, title: 'Fixture', cwd: '/fixture', archived: false }], projects: [], sourceInfo: {} });
  let attachments = new Attachments(store, options);
  return { get store() { return store; }, get attachments() { return attachments; }, directory, folder: join(attachments.root, asset),
    upload: (bytes = text, name = 'feedback.txt', requestId = request) =>
      attachments.uploadForMessage(thread, requestId, asset, name, name.endsWith('.png') ? 'image/png' : 'application/octet-stream', Readable.from([bytes])),
    orphan() {
      // Reproduce the durable files left by a crash before the metadata/link
      // transaction, without terminating a process or touching real data.
      store.db.prepare('DELETE FROM attachment_links WHERE attachment_id=?').run(asset);
      store.db.prepare('DELETE FROM attachments WHERE id=?').run(asset);
    },
    restart() {
      store.close(); store = new NavigatorStore(directory); attachments = new Attachments(store, options);
    },
  };
}

test('internal attachment creation and orphan adoption never surface in the user draft', async t => {
  const f = fixture(t);
  const before = await f.upload();
  assert.equal(f.attachments.list(thread).attachments.length, 0);
  assert.equal(existsSync(join(f.folder, '.message-upload.json')), true);
  f.orphan();
  const restored = await f.upload();
  assert.deepEqual(restored, before);
  assert.equal(f.attachments.list(thread).attachments.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_links WHERE request_id=?').get(request).n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 1);
  assert.deepEqual(readdirSync(f.attachments.root).filter(name => name.startsWith('.pending-')), []);
  // The normal enqueue can bind its immutable snapshot to the reservation.
  f.attachments.bind(thread, request, 'feedback', f.attachments.resolve(thread, [asset], request));
  assert.equal(f.attachments.forDispatch(thread, request).length, 1);
});

test('a real image and its preview survive crash recovery with the same bytes and dimensions', async t => {
  const f = fixture(t);
  const original = await f.upload(png, 'feedback.png');
  const before = await f.attachments.read(thread, asset, true);
  f.orphan();
  assert.deepEqual(await f.upload(png, 'feedback.png'), original);
  const after = await f.attachments.read(thread, asset, true);
  assert.deepEqual(after.bytes, before.bytes);
  assert.equal(after.width, before.width); assert.equal(after.height, before.height);
  assert.equal(f.attachments.list(thread).attachments.length, 0);
});

test('wrong request identity, unknown directories and changed source bytes are never adopted or removed', async t => {
  const f = fixture(t); await f.upload(); f.orphan();
  const manifestPath = join(f.folder, '.message-upload.json');
  const proof = readFileSync(manifestPath, 'utf8');
  await assert.rejects(f.upload(text, 'feedback.txt', secondRequest), error => error.status === 409);
  assert.equal(readFileSync(manifestPath, 'utf8'), proof);
  writeFileSync(join(f.folder, 'original.txt'), 'modified');
  await assert.rejects(f.upload(), error => error.status === 409);
  assert.equal(readFileSync(join(f.folder, 'original.txt'), 'utf8'), 'modified');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);
  unlinkSync(manifestPath);
  await assert.rejects(f.upload(), error => error.status === 409);
  assert.equal(existsSync(f.folder), true);
});

test('adoption rejects extra files and path substitutions while preserving the existing directory', async t => {
  const f = fixture(t); await f.upload(); f.orphan();
  const extra = join(f.folder, 'unexpected'); writeFileSync(extra, 'not part of this request');
  await assert.rejects(f.upload(), error => error.status === 409);
  assert.equal(existsSync(extra), true); unlinkSync(extra);
  const original = join(f.folder, 'original.txt'); unlinkSync(original); symlinkSync('/etc/hosts', original);
  await assert.rejects(f.upload(), error => error.status === 409);
  assert.equal(existsSync(join(f.folder, '.message-upload.json')), true);
});

test('a failed adoption transaction retains the complete orphan for a later identical retry', async t => {
  const f = fixture(t); const original = await f.upload(); f.orphan();
  f.store.db.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON attachments BEGIN SELECT RAISE(FAIL, 'simulated SQL failure'); END");
  await assert.rejects(f.upload(), /simulated SQL failure/);
  assert.equal(existsSync(join(f.folder, '.message-upload.json')), true);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);
  f.store.db.exec('DROP TRIGGER reject_restore');
  assert.deepEqual(await f.upload(), original);
  assert.deepEqual(readdirSync(f.attachments.root).filter(name => name.startsWith('.pending-')), []);
});

test('ordinary upload recovery stays explicit, and internal reservations do not consume sixteen user draft slots', async t => {
  const f = fixture(t);
  for (let n = 1; n <= 16; n++) await f.attachments.upload(thread, id(n), 'notes.txt', 'text/plain', Readable.from([text]));
  await f.upload(); assert.equal(f.attachments.list(thread).attachments.length, 16);
  await assert.rejects(f.attachments.upload(thread, id(17), 'notes.txt', 'text/plain', Readable.from([text])), error => error.status === 409);
  const fresh = fixture(t); mkdirSync(fresh.folder); writeFileSync(join(fresh.folder, 'original.txt'), text);
  await assert.rejects(fresh.attachments.upload(thread, asset, 'feedback.txt', 'text/plain', Readable.from([text])), error => error.status === 409);
  assert.equal(existsSync(fresh.folder), true);
});

test('internal manifest storage participates in quota admission', async t => {
  const f = fixture(t, { maxBytes: 100, maxTotalBytes: 1000 });
  await assert.rejects(f.upload(), error => error.status === 413);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);
  assert.deepEqual(readdirSync(f.attachments.root), []);
});

test('cancelling an internal queued message keeps its assets out of drafts after a database restart', async t => {
  const f = fixture(t); await f.upload();
  const service = new DesktopService(f.store, f.directory, async () => { throw new Error('native calls are forbidden'); });
  try {
    assert.equal((await service.send(thread, { requestId: request, text: 'feedback', attachments: [asset], enqueue: true })).status, 'queued');
    service.cancelQueued(thread, request, { expectedRevision: 0 });
  } finally { service.stopQueue(); }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachment_links WHERE request_id=?').get(request).n, 0);
  assert.deepEqual(f.attachments.list(thread).attachments, []);
  f.restart();
  assert.equal(f.attachments.row(thread, asset).internalRequestId, request);
  assert.deepEqual(f.attachments.list(thread).attachments, []);
  for (let n = 1; n <= 16; n++) await f.attachments.upload(thread, id(n), 'notes.txt', 'text/plain', Readable.from([text]));
  assert.equal(f.attachments.list(thread).attachments.length, 16);
  assert.equal(f.attachments.forDispatch(thread, request)[0].internalRequestId, request);
  f.attachments.cleanup();
  assert.equal(existsSync(f.folder), true);
  f.store.db.prepare("UPDATE attachments SET created_at=0,data=json_set(data,'$.internalReleasedAt',0) WHERE id=?").run(asset);
  f.attachments.cleanup();
  assert.equal(existsSync(f.folder), false);
  assert.equal(f.attachments.list(thread).attachments.length, 16);
});

test('internal ownership survives release and cannot be changed into an ordinary draft or another request', async t => {
  const f = fixture(t); const first = await f.upload();
  // Missing links alone are not proof that a durable job was cancelled.
  f.store.db.prepare('DELETE FROM attachment_links WHERE request_id=?').run(request);
  f.store.db.prepare('UPDATE attachments SET created_at=0 WHERE id=?').run(asset);
  f.restart();
  assert.equal(existsSync(f.folder), true);
  assert.deepEqual(f.attachments.list(thread).attachments, []);
  await f.upload(); f.attachments.release(request);
  f.store.db.prepare('UPDATE attachments SET created_at=0 WHERE id=?').run(asset);
  f.restart();
  // Expiration follows the internal release time, not ordinary draft age.
  assert.equal(existsSync(f.folder), true);
  assert.deepEqual(f.attachments.list(thread).attachments, []);
  assert.throws(() => f.attachments.resolve(thread, [asset]), error => error.status === 409);
  assert.throws(() => f.attachments.resolve(thread, [asset], secondRequest), error => error.status === 409);
  assert.throws(() => f.attachments.bind(thread, secondRequest, 'wrong owner', [f.attachments.row(thread, asset)]), error => error.status === 409);
  assert.throws(() => f.attachments.remove(thread, asset), error => error.status === 409);
  await assert.rejects(f.upload(text, 'feedback.txt', secondRequest), error => error.status === 409);
  await assert.rejects(f.attachments.upload(thread, asset, 'feedback.txt', 'application/octet-stream', Readable.from([text])), error => error.status === 409);
  assert.deepEqual(await f.upload(), first);
  assert.equal(f.attachments.resolve(thread, [asset], request)[0].internalRequestId, request);
  await f.attachments.upload(thread, id(1), 'notes.txt', 'text/plain', Readable.from([text]));
  await assert.rejects(f.attachments.uploadForMessage(thread, request, id(1), 'notes.txt', 'text/plain', Readable.from([text])), error => error.status === 409);
  assert.deepEqual(f.attachments.list(thread).attachments.map(value => value.id), [id(1)]);
});

test('orphan recovery requires the identical durable internal ownership', async t => {
  const f = fixture(t); await f.upload(); f.orphan();
  const manifestPath = join(f.folder, '.message-upload.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.data.internalRequestId, request);
  for (const owner of [undefined, secondRequest]) {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, data: { ...manifest.data, internalRequestId: owner } }));
    await assert.rejects(f.upload(), error => error.status === 409);
    assert.equal(existsSync(f.folder), true);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 0);
  }
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await f.upload(); f.attachments.release(request); f.restart();
  assert.equal(f.attachments.row(thread, asset).internalRequestId, request);
  assert.deepEqual(f.attachments.list(thread).attachments, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import 'fake-indexeddb/auto';
import { openDB, deleteDB } from 'idb';
import { createImageReadCache, ImageReadError, imageReadSource, imageReadCacheLimits } from '../src/imageReadCache.ts';
import { createImageReadStorage, clearImageReadStorage, IMAGE_READ_CACHE_DATABASE, imageReadCacheFence, imageReadCacheKey } from '../src/imageReadCacheStorage.ts';
import { imageReadPermissionMessage } from '../src/imageFailureDiagnostic.ts';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from '../src/clientVersion.ts';

const thread = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source = id => `/api/tasks/${thread}/images/${String(id).repeat(64)}`;
const attachment = `/api/tasks/${thread}/attachments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/b9sAAAAASUVORK5CYII=', 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const proof = (src = source('a'), bytes = png) => ({ src, sha256: sha(bytes), mime: 'image/png', size: bytes.length });
const response = (bytes = png, extra = {}) => new Response(bytes, { headers: { 'Content-Type': 'image/png', 'X-Pocket-Machine': 'ged', ...extra } });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('eight distinct image reads use the full network budget while the ninth waits and cancelled consumers free a slot', async t => {
  const held = new Map(); let active = 0, peak = 0, started = 0;
  const { cache } = setup(t, { request: async (_url, options) => {
    started++; active++; peak = Math.max(peak, active);
    await new Promise((resolve, reject) => { held.set(started, resolve); options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
    active--; return response();
  } });
  const controllers = Array.from({ length: 9 }, () => new AbortController());
  const reads = controllers.map((controller, index) => cache.acquire({ src: source((index + 1).toString(16)) }, { signal: controller.signal }).catch(() => null));
  for (let n = 0; n < 20 && started < 8; n++) await tick();
  assert.equal(started, 8); assert.equal(peak, 8);
  held.get(1)(); for (let n = 0; n < 20 && started < 9; n++) await tick(); assert.equal(started, 9);
  for (const finish of held.values()) finish();
  for (const lease of await Promise.all(reads)) lease?.release(); assert.equal(peak, 8);
});
class LocalStorage { values = new Map(); getItem(key) { return this.values.get(key) ?? null; } setItem(key, value) { this.values.set(key, String(value)); } }
function setup(t, options = {}) {
  const urls = [], revoked = [];
  const cache = createImageReadCache({ storage: null, selectedMachine: () => 'ged', clearStorage: async () => {},
    createObjectURL: () => { const url = `blob:synthetic/${urls.length}`; urls.push(url); return url; }, revokeObjectURL: url => revoked.push(url), ...options });
  cache.authorize('ged', 'source-a'); t.after(() => cache.dispose());
  return { cache, urls, revoked };
}
async function diskSetup(t) {
  Object.defineProperty(globalThis, 'localStorage', { value: new LocalStorage(), configurable: true });
  const databaseName = `${IMAGE_READ_CACHE_DATABASE}-synthetic-${crypto.randomUUID()}`;
  const options = { storage: undefined, createStorage: () => createImageReadStorage({ databaseName }), clearStorage: machine => clearImageReadStorage(machine, databaseName) };
  t.after(async () => { await deleteDB(databaseName); delete globalThis.localStorage; });
  return { options, databaseName };
}

test('inline and gallery singleflight share one bounded versioned read and independently release URLs', async t => {
  let resolve, reads = 0; const started = new Promise(done => { resolve = done; });
  const { cache, revoked } = setup(t, { request: async (url, options) => {
    reads++; assert.equal(url, source('a')); assert.equal(options.credentials, 'same-origin'); assert.equal(options.mode, 'same-origin');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store'); assert.equal(options.headers[CLIENT_VERSION_HEADER], CLIENT_VERSION);
    await started; return response();
  } });
  const first = cache.acquire(proof()), second = cache.acquire(proof()); await tick(); assert.equal(reads, 1); resolve();
  const [inline, gallery] = await Promise.all([first, second]); assert.equal(inline.url, gallery.url);
  gallery.release(); gallery.release(); assert.equal(revoked.length, 0); inline.release(); assert.deepEqual(revoked, [inline.url]);
  const again = await cache.acquire(proof()); assert.equal(reads, 1); again.release();
});

test('immutable same-content capabilities reuse; defined proof survives an undefined optional field', async t => {
  let reads = 0; const { cache } = setup(t, { request: async () => { reads++; return response(); } });
  cache.register(proof()); (await cache.acquire({ src: source('a') })).release();
  (await cache.acquire({ src: source('a'), sha256: undefined })).release();
  (await cache.acquire(proof(source('b')))).release(); assert.equal(reads, 1);
});

test('each cache hit and singleflight consumer must match its own MIME and size metadata', async t => {
  let release, reads = 0; const gate = new Promise(done => { release = done; });
  const { cache } = setup(t, { request: async () => { reads++; await gate; return response(); } });
  const correct = cache.acquire(proof()), mismatch = cache.acquire({ ...proof(), mime: 'image/jpeg', size: png.length + 1 });
  const rejected = assert.rejects(mismatch); await tick(); release(); (await correct).release(); await rejected;
  await assert.rejects(cache.acquire({ ...proof(), size: png.length + 1 }));
  await assert.rejects(cache.acquire({ ...proof(), mime: 'image/jpeg' })); (await cache.acquire(proof())).release(); assert.equal(reads, 1);
});

test('cancel one consumer preserves another; cancel the last consumer aborts without filling cache', async t => {
  let finish, reads = 0, cancellations = 0; const pending = new Promise(done => { finish = done; });
  const { cache } = setup(t, { request: async (_url, options) => {
    reads++; options.signal.addEventListener('abort', () => cancellations++);
    if (reads > 1) await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    await pending; options.signal.throwIfAborted(); return response();
  } });
  const one = new AbortController(), two = new AbortController();
  const left = cache.acquire(proof(), { signal: one.signal }), right = cache.acquire(proof(), { signal: two.signal }); await tick();
  one.abort(); await assert.rejects(left); assert.equal(cancellations, 0); finish(); (await right).release();
  const end = new AbortController(); const value = cache.acquire(proof(source('b'), Buffer.concat([png, Buffer.from('different')])), { signal: end.signal });
  await tick(); end.abort(); await assert.rejects(value); assert.equal(cancellations, 1); assert.equal(reads, 2);
});

test('retry invalidates the current content and forces read while another view retains its URL', async t => {
  let reads = 0; const { cache, revoked } = setup(t, { request: async () => { reads++; return response(); } });
  const old = await cache.acquire(proof()); await cache.invalidateSource(proof()); const next = await cache.acquire(proof(), { force: true });
  assert.equal(reads, 2); assert.notEqual(old.url, next.url); assert.deepEqual(revoked, []);
  next.release(); assert.deepEqual(revoked, [next.url]); old.release(); assert.deepEqual(revoked, [next.url, old.url]);
});

test('bounded L1 evicts least recently used blobs without revoking a leased view', async t => {
  let reads = 0; const { cache, revoked } = setup(t, { memoryBytes: png.length * 2, request: async url => {
    reads++; return response(Buffer.concat([png.subarray(0, 8), Buffer.from(url.slice(-1)), png.subarray(9)]));
  } });
  const unknown = src => ({ src });
  const held = await cache.acquire(unknown(source('a'))); (await cache.acquire(unknown(source('b')))).release();
  (await cache.acquire(unknown(source('a')))).release(); (await cache.acquire(unknown(source('c')))).release();
  assert.equal(revoked.includes(held.url), false); (await cache.acquire(unknown(source('b')))).release(); assert.equal(reads, 4); held.release();
});

test('authorization loss revokes every live lease even if an evicted same-source Blob was replaced', async t => {
  const { cache, revoked } = setup(t, { memoryBytes: 1, request: async () => response() });
  const first = await cache.acquire({ src: source('a') }), second = await cache.acquire({ src: source('a') });
  assert.notEqual(first.url, second.url); await cache.invalidate('ged');
  assert.deepEqual(new Set(revoked), new Set([first.url, second.url])); first.release(); second.release(); assert.equal(revoked.length, 2);
});

test('authorization and source changes reject old reads; unknown metadata never becomes disk proof', async t => {
  let writes = 0, reads = 0, finish; const pending = new Promise(done => { finish = done; });
  const storage = { async read() { return null; }, async write() { writes++; }, async remove() {}, close() {} };
  const { cache } = setup(t, { storage, request: async () => { reads++; if (reads === 1) await pending; return response(); } });
  const old = cache.acquire(proof()); await tick(); cache.authorize('ged', 'source-b'); finish(); await assert.rejects(old);
  (await cache.acquire({ src: source('a') })).release(); assert.equal(writes, 0); (await cache.acquire({ src: source('a') })).release(); assert.equal(reads, 2);
  await cache.invalidate('ged'); await assert.rejects(cache.acquire(proof())); cache.authorize('ged', null);
  (await cache.acquire(proof())).release(); assert.equal(writes, 0); assert.equal(reads, 3);
});

test('only exact registered routes, selected machine, valid metadata and signed bytes can be read', async t => {
  let reads = 0; const { cache } = setup(t, { request: async () => { reads++; return response(); } });
  for (const src of ['https://external.invalid' + source('a'), '/private/image.png', source('a') + '?path=a', source('a') + '#x',
    attachment + '?preview=1&token=x', attachment + '?metadata=1', source('a').replace('/images/', '/files/'), '/api/machines/wandou' + source('a').slice(4)]) {
    assert.equal(imageReadSource(src), null); await assert.rejects(cache.acquire({ src }));
  }
  await assert.rejects(cache.acquire({ ...proof(), machine: 'wandou' }));
  await assert.rejects(cache.acquire({ ...proof(), sha256: 'signed-url-is-not-proof' }));
  await assert.rejects(cache.acquire({ ...proof(), variant: 'preview' })); assert.equal(reads, 0);
  (await cache.acquire(proof(attachment))).release(); assert.equal(reads, 1);
});

test('403 reason, wrong machine, bad SHA/signature and error responses never become cache entries', async t => {
  let reads = 0, value = new Response(JSON.stringify({ error: imageReadPermissionMessage }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  const { cache } = setup(t, { request: async () => { reads++; return value.clone(); } });
  await assert.rejects(cache.acquire(proof()), error => error instanceof ImageReadError && error.status === 403 && error.permission);
  value = response(png, { 'X-Pocket-Machine': 'wandou' }); await assert.rejects(cache.acquire(proof()));
  value = response(Buffer.from('<svg/>')); await assert.rejects(cache.acquire(proof()));
  value = response(); await assert.rejects(cache.acquire({ ...proof(), sha256: 'a'.repeat(64) }));
  (await cache.acquire(proof())).release(); assert.equal(reads, 5);
});

test('401 revokes authentication epoch and reports the existing auth-expired boundary', async t => {
  let expired; const { cache } = setup(t, { onUnauthorized: machine => { expired = machine; }, request: async () => new Response('', { status: 401 }) });
  await assert.rejects(cache.acquire(proof())); assert.equal(expired, 'ged'); await assert.rejects(cache.acquire(proof()));
});

test('8MiB image bound cancels excess body and a stalled body has a complete read deadline', async t => {
  let cancelled = 0, pulls = 0;
  const { cache } = setup(t, { timeoutMs: 30, request: async () => response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(5 * 1024 * 1024)); }, cancel() { cancelled++; } }, { highWaterMark: 0 })) });
  await assert.rejects(cache.acquire({ src: source('a') })); assert.equal(pulls, 2); assert.equal(cancelled, 1);
  const stalled = setup(t, { timeoutMs: 30, request: async () => response(new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 })) }).cache;
  await assert.rejects(stalled.acquire({ src: source('a') })); assert.equal(cancelled, 2);
});

test('attachment originals above 8MiB remain viewable as short-lived blobs; image routes keep 8MiB', async t => {
  const bytes = Buffer.concat([png, Buffer.alloc(imageReadCacheLimits.imageBytes)]); let reads = 0, writes = 0;
  const { cache } = setup(t, { memoryBytes: 1024, storage: { async read() { return null; }, async write() { writes++; }, async remove() {}, close() {} }, request: async () => { reads++; return response(bytes); } });
  const first = await cache.acquire(proof(attachment, bytes)); first.release(); (await cache.acquire(proof(attachment, bytes))).release();
  assert.equal(reads, 2); assert.equal(writes, 0); await assert.rejects(cache.acquire(proof(source('a'), bytes))); assert.equal(reads, 2);
});

test('authenticated matching scope can reuse verified IDB blobs offline; no auth/scope cannot expose them', async t => {
  const { options, databaseName } = await diskSetup(t); let reads = 0;
  const first = setup(t, { ...options, request: async () => { reads++; return response(); } }).cache;
  (await first.acquire(proof())).release(); first.dispose();
  const db = await openDB(databaseName, 1); const records = await db.getAll('images'); db.close();
  assert.equal(records.length, 1); assert.equal('src' in records[0], false); assert.equal(JSON.stringify(records).includes('/api/'), false);
  assert.equal('blob' in records[0], false); assert.ok(records[0].data instanceof ArrayBuffer);
  assert.deepEqual(Buffer.from(records[0].data), png);
  const restored = setup(t, { ...options, request: async () => { reads++; throw new Error('offline'); } }).cache;
  (await restored.acquire(proof())).release(); assert.equal(reads, 1); restored.dispose();
  const unauth = createImageReadCache({ ...options, selectedMachine: () => 'ged', request: async () => { reads++; throw new Error('offline'); } }); t.after(() => unauth.dispose());
  await assert.rejects(unauth.acquire(proof())); assert.equal(reads, 1); unauth.authorize('ged', null);
  await assert.rejects(unauth.acquire(proof())); assert.equal(reads, 2);
});

test('persistent image bytes survive a browser that refuses IndexedDB Blob cloning and remain validated on an offline reopen', async t => {
  const { options, databaseName } = await diskSetup(t); let reads = 0;
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, ...args) {
    if (value?.blob instanceof Blob) throw new DOMException('Error preparing Blob/File data to be stored in object store', 'UnknownError');
    return put.call(this, value, ...args);
  };
  t.after(() => { IDBObjectStore.prototype.put = put; });
  const first = setup(t, { ...options, request: async () => { reads++; return response(); } }).cache;
  (await first.acquire(proof())).release(); first.dispose();
  const disk = await openDB(databaseName, 1), records = await disk.getAll('images'); disk.close();
  assert.equal(records.length, 1); assert.equal(records[0].data.byteLength, png.length);
  const reopened = setup(t, { ...options, request: async () => { reads++; throw new Error('offline'); } }).cache;
  (await reopened.acquire(proof())).release(); assert.equal(reads, 1);
  await assert.rejects(reopened.acquire({ ...proof(), size: png.length + 1 }));
  await assert.rejects(reopened.acquire({ ...proof(), mime: 'image/jpeg' }));
  assert.equal(reads, 1, 'Restoring portable bytes does not weaken a consumer proof');
});

test('legacy Blob records migrate to portable bytes while preserving scope, checksum, revocation and LRU metadata', async t => {
  const { databaseName } = await diskSetup(t), storage = createImageReadStorage({ databaseName }); t.after(() => storage.close());
  const record = { schema: 1, key: 'legacy', machine: 'ged', scope: 'source-a', threadId: thread, sha256: sha(png), variant: 'original',
    mime: 'image/png', bytes: png.length, blob: new Blob([png], { type: 'image/png' }), accessedAt: 1, fence: imageReadCacheFence('ged') };
  await storage.write(record);
  const disk = await openDB(databaseName, 1); await disk.put('images', { ...record, globalEpoch: 0, machineEpoch: 0 }); disk.close();
  const restored = await storage.read('legacy', 'ged');
  assert.ok(restored?.blob instanceof Blob); assert.deepEqual(Buffer.from(await restored.blob.arrayBuffer()), png);
  assert.equal(restored.scope, record.scope); assert.equal(restored.sha256, record.sha256); assert.equal(restored.fence, record.fence);
  const after = await openDB(databaseName, 1), portable = await after.get('images', 'legacy'); after.close();
  assert.equal('blob' in portable, false); assert.ok(portable.data instanceof ArrayBuffer); assert.ok(portable.accessedAt > 1);
  await clearImageReadStorage('ged', databaseName); assert.equal(await storage.read('legacy', 'ged'), null);
});

test('clearing a cache during portable byte extraction cannot resurrect a pending disk write', async t => {
  const { databaseName } = await diskSetup(t), storage = createImageReadStorage({ databaseName }); t.after(() => storage.close());
  let release, started;
  const gate = new Promise(done => { release = done; }), begun = new Promise(done => { started = done; });
  class DelayedBlob extends Blob { async arrayBuffer() { started(); await gate; return super.arrayBuffer(); } }
  const blob = new DelayedBlob([png], { type: 'image/png' });
  const writing = storage.write({ schema: 1, key: 'pending', machine: 'ged', scope: 'source-a', threadId: thread, sha256: sha(png), variant: 'original',
    mime: 'image/png', bytes: png.length, blob, accessedAt: 1, fence: imageReadCacheFence('ged') });
  await begun; await clearImageReadStorage('ged', databaseName); release(); await writing;
  const disk = await openDB(databaseName, 1); assert.deepEqual(await disk.getAll('images'), []); disk.close();
});

test('legacy byte migration cannot restore a record removed or evicted while extraction is pending', async t => {
  const { databaseName } = await diskSetup(t), storage = createImageReadStorage({ databaseName }); t.after(() => storage.close());
  const record = { schema: 1, key: 'removed-legacy', machine: 'ged', scope: 'source-a', threadId: thread, sha256: sha(png), variant: 'original',
    mime: 'image/png', bytes: png.length, blob: new Blob([png], { type: 'image/png' }), accessedAt: 1, fence: imageReadCacheFence('ged') };
  await storage.write(record);
  const disk = await openDB(databaseName, 1); await disk.put('images', { ...record, globalEpoch: 0, machineEpoch: 0 }); disk.close();
  let release, started;
  const gate = new Promise(done => { release = done; }), begun = new Promise(done => { started = done; });
  const original = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = async function () { started(); await gate; return original.call(this); };
  t.after(() => { Blob.prototype.arrayBuffer = original; });
  const reading = storage.read(record.key, 'ged'); await begun; await storage.remove(record.key); release();
  assert.equal(await reading, null);
  const after = await openDB(databaseName, 1); assert.equal(await after.get('images', record.key), undefined); after.close();
});

test('IDB corruption is revalidated and cache clear prevents late response resurrection', async t => {
  const { options, databaseName } = await diskSetup(t);
  let finish; const pending = new Promise(done => { finish = done; });
  const cache = setup(t, { ...options, request: async () => { await pending; return response(); } }).cache;
  const old = cache.acquire(proof()); await tick(); const cleared = cache.invalidate('ged'); cache.authorize('ged', 'source-a'); finish();
  await assert.rejects(old); await cleared; cache.dispose();
  const db = await openDB(databaseName, 1); assert.equal((await db.getAll('images')).length, 0);
  const key = imageReadCacheKey('ged', 'source-a', thread, sha(png), 'original');
  await db.put('images', { schema: 1, key, machine: 'ged', scope: 'source-a', threadId: thread, sha256: sha(png), variant: 'original', mime: 'image/png',
    bytes: 9, blob: new Blob(['not-image'], { type: 'image/png' }), accessedAt: Date.now(), fence: imageReadCacheFence('ged'),
    globalEpoch: 0, machineEpoch: await db.get('epochs', 'ged') }); db.close();
  let reads = 0; const fresh = setup(t, { ...options, request: async () => { reads++; return response(); } }).cache;
  (await fresh.acquire(proof())).release(); assert.equal(reads, 1);
});

test('IDB has a fixed 64MiB LRU and clear epochs revoke existing storage instances', async t => {
  const { databaseName } = await diskSetup(t), storage = createImageReadStorage({ databaseName }); t.after(() => storage.close());
  const blob = new Blob([png, new Uint8Array(imageReadCacheLimits.imageBytes - png.length)], { type: 'image/png' });
  const record = index => ({ schema: 1, key: String(index), machine: 'ged', scope: 'source-a', threadId: thread, sha256: sha(png), variant: 'original',
    mime: blob.type, bytes: blob.size, blob, accessedAt: index, fence: imageReadCacheFence('ged') });
  for (let index = 0; index < 8; index++) await storage.write(record(index)); await storage.read('0', 'ged'); await storage.write(record(8));
  assert.ok(await storage.read('0', 'ged')); assert.equal(await storage.read('1', 'ged'), null);
  const db = await openDB(databaseName, 1); assert.equal((await db.getAll('images')).reduce((sum, entry) => sum + entry.bytes, 0), imageReadCacheLimits.diskBytes); db.close();
  await clearImageReadStorage('ged', databaseName); assert.equal(await storage.read('0', 'ged'), null); await storage.write(record(9));
  const after = await openDB(databaseName, 1); assert.equal((await after.getAll('images')).length, 0); after.close();
});

test('cold auth-only scope upgrades preserve matching verified IDB images and repeated auth checks keep the fresh scope', async t => {
  const { options } = await diskSetup(t); let reads = 0;
  const warm = setup(t, { ...options, request: async () => { reads++; return response(); } }).cache;
  (await warm.acquire(proof())).release(); warm.dispose();
  const cold = createImageReadCache({ ...options, selectedMachine: () => 'ged', request: async () => { reads++; throw new Error('media offline'); } });
  t.after(() => cold.dispose()); cold.authorize('ged', null); cold.authorize('ged', 'source-a');
  const cached = await cold.acquire(proof()); cold.authorize('ged', null); (await cold.acquire(proof())).release(); cached.release();
  assert.equal(reads, 1, 'Same-scope persisted bytes survived provisional auth and a later auth-only check');
});

test('cold source retention deletes only the selected machine other scopes and fences old storage writes', async t => {
  const { options, databaseName } = await diskSetup(t), oldWriter = createImageReadStorage({ databaseName });
  t.after(() => oldWriter.close());
  const make = (machine, scope) => ({ schema: 1, key: imageReadCacheKey(machine, scope, thread, sha(png), 'original'), machine, scope, threadId: thread,
    sha256: sha(png), variant: 'original', mime: 'image/png', bytes: png.length, blob: new Blob([png], { type: 'image/png' }), accessedAt: Date.now(), fence: imageReadCacheFence(machine) });
  await oldWriter.write(make('ged', 'ged-scope')); await oldWriter.write(make('wandou', 'old-source')); await oldWriter.write(make('wandou', 'next-source'));
  let reads = 0; const cold = createImageReadCache({ ...options, selectedMachine: () => 'wandou', request: async () => { reads++; throw new Error('media offline'); } });
  t.after(() => cold.dispose()); cold.authorize('wandou', null); cold.authorize('wandou', 'next-source');
  (await cold.acquire({ ...proof(), machine: 'wandou' })).release(); assert.equal(reads, 0);
  await oldWriter.write(make('wandou', 'old-source'));
  const db = await openDB(databaseName, 1), entries = await db.getAll('images'); db.close();
  assert.deepEqual(new Set(entries.map(entry => `${entry.machine}/${entry.scope}`)), new Set(['ged/ged-scope', 'wandou/next-source']));
});

test('two source authorizations racing a queued retain cannot delete the newer source or revive the older read', async t => {
  const { options, databaseName } = await diskSetup(t); let release, started, reads = 0;
  const gate = new Promise(done => { release = done; }), begun = new Promise(done => { started = done; });
  const cache = createImageReadCache({ ...options, selectedMachine: () => 'ged', createStorage() {
    const storage = createImageReadStorage({ databaseName });
    return { ...storage, async retainScope(machine, scope, current) {
      if (scope === 'source-a') { started(); await gate; } return storage.retainScope(machine, scope, current);
    } };
  }, request: async () => { reads++; return response(); } }); t.after(() => cache.dispose());
  cache.authorize('ged', 'source-a'); const old = cache.acquire(proof()), rejected = assert.rejects(old);
  await begun; cache.authorize('ged', 'source-b'); const latest = cache.acquire(proof()); release(); await rejected; (await latest).release();
  const db = await openDB(databaseName, 1), records = await db.getAll('images'); db.close();
  assert.equal(reads, 1); assert.deepEqual(records.map(record => record.scope), ['source-b']);
});

test('logout during an awaited scope retention aborts its authority and cannot backfill private bytes', async t => {
  const { options, databaseName } = await diskSetup(t); let release, started, reads = 0;
  const gate = new Promise(done => { release = done; }), begun = new Promise(done => { started = done; });
  const cache = createImageReadCache({ ...options, selectedMachine: () => 'ged', createStorage() {
    const storage = createImageReadStorage({ databaseName });
    return { ...storage, async retainScope(machine, scope, current) { started(); await gate; return storage.retainScope(machine, scope, current); } };
  }, request: async () => { reads++; return response(); } }); t.after(() => cache.dispose());
  cache.authorize('ged', 'source-a'); const pending = cache.acquire(proof()), rejected = assert.rejects(pending);
  await begun; const clearing = cache.invalidate('ged'); release(); await rejected; await clearing;
  const db = await openDB(databaseName, 1); assert.equal((await db.getAll('images')).length, 0); db.close(); assert.equal(reads, 0);
});

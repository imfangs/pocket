import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openDB, deleteDB } from 'idb';
import { createReadingCache, clearReadingCache, readingCacheLimits, subscribeReadingCacheInvalidation } from '../src/readingCache.ts';
import { createReadingCacheStorage, readingCacheFence, readingCacheKey, READING_CACHE_DATABASE } from '../src/readingCacheStorage.ts';
import { defaultReadingCacheLimit } from '../src/readingCachePreference.ts';

const baseTime = 1_790_000_000_000;
class LocalStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
const pocketContent = scope => ({ scope, known: true, revision: 1, version: 'a'.repeat(64), messageId: 'assistant-1' });
const catalog = (scope = 'source-a', title = 'A saved conversation') => ({
  threads: [{ id: 'thread-1', title, cwd: '/fixture/project', hostId: 'fixture', pocketContent: pocketContent(scope),
    desktopReadContent: pocketContent(scope), hasUnreadTurn: true, needsInput: true, note: 'private-note',
    runtimeStatus: 'running', connection: { status: 'connected' }, csrfToken: 'nested-secret' }], groups: [], projects: [],
  sourceInfo: { pocketRead: { available: true, scope }, scope: 'Source description', syncedAt: baseTime, total: 1, active: 1, archived: 0,
    unread: { available: true, pending: 1 } }, sourceError: null, csrfToken: 'secret', authentication: { secret: true },
});
const transcript = (text = 'Saved answer', scope = 'source-a') => ({
  source: 'rollout', messages: [{ id: 'assistant-1', role: 'assistant', text, phase: 'final', turnId: 'turn-1',
    clientMessageId: 'display-identity', timestamp: baseTime, turnDurationMs: 90,
    images: { image: '/private/image?token=secret' }, files: { file: { url: '/private/file?token=secret', name: 'file' } },
    attachments: [{ id: 'upload-1', name: 'private.txt', url: '/private/upload?token=secret' }], csrfToken: 'message-secret' }],
  checkedAt: baseTime, hasMore: false, pocketContent: pocketContent(scope),
  readObservation: { token: 'signed-observation' }, turnTiming: { status: 'inProgress' },
  canSend: true, runtime: 'active', outbox: [{ text: 'unsent' }], pendingRequests: [{ command: 'do something' }],
});
async function setup(t) {
  Object.defineProperty(globalThis, 'localStorage', { value: new LocalStorage(), configurable: true });
  await deleteDB(READING_CACHE_DATABASE);
  const caches = [];
  const create = options => { const cache = createReadingCache({ now: () => baseTime, ...options }); caches.push(cache); return cache; };
  t.after(async () => { caches.forEach(cache => cache.dispose()); await deleteDB(READING_CACHE_DATABASE); delete globalThis.localStorage; });
  return { create };
}
async function records() {
  const db = await openDB(READING_CACHE_DATABASE, 1);
  try { return await db.getAll('entries'); } finally { db.close(); }
}
function captureStorage() {
  const values = new Map(), writes = [];
  return { values, writes, catalog: async machine => [...values.values()].find(value => value.machine === machine && value.kind === 'catalog') ?? null,
    transcript: async key => values.get(key) ?? null,
    async write(batch) { writes.push(batch); batch.forEach(value => values.set(value.key, structuredClone(value))); }, close() {} };
}

test('disk roundtrip contains only reading DTOs, with stable display identity and no control/file capabilities', async t => {
  const { create } = await setup(t), cache = create();
  assert.equal(cache.rememberCatalog('ged', catalog()), true);
  assert.equal(cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript()), true);
  await cache.flush();
  const raw = JSON.stringify(await records());
  for (const prohibited of ['secret', 'private-note', 'signed-observation', 'canSend', 'runtime', 'outbox', 'pendingRequests', 'desktopReadContent', 'hasUnreadTurn', 'needsInput', 'images', 'files', 'attachments'])
    assert.equal(raw.includes(prohibited), false, prohibited);
  cache.dispose();
  const restored = create(), list = await restored.loadCatalog('ged'), body = await restored.loadTranscript('ged', 'source-a', 'thread-1');
  assert.equal(list.value.threads[0].title, 'A saved conversation');
  assert.equal(body.value.messages[0].text, 'Saved answer');
  assert.equal(body.value.messages[0].clientMessageId, 'display-identity');
  assert.deepEqual(body.value.pocketContent, pocketContent('source-a'));
  assert.equal(body.savedAt, baseTime);
  assert.equal(body.value.readObservation, undefined);
});

test('machine and exact source scope isolate the same thread ID across memory and disk', async t => {
  const { create } = await setup(t), cache = create();
  cache.rememberTranscript('ged', 'a/b', 'same-id', transcript('first', 'a/b'));
  cache.rememberTranscript('ged', 'a', 'same-id', transcript('second', 'a'));
  cache.rememberTranscript('wandou', 'a/b', 'same-id', transcript('third', 'a/b'));
  await cache.flush(); cache.dispose();
  const restored = create();
  for (const [machine, scope, text] of [['ged', 'a/b', 'first'], ['ged', 'a', 'second'], ['wandou', 'a/b', 'third']])
    assert.equal((await restored.loadTranscript(machine, scope, 'same-id')).value.messages[0].text, text);
  assert.equal(await restored.loadTranscript('ged', 'unknown', 'same-id'), null);
  assert.equal(await restored.loadTranscript('unknown', 'a/b', 'same-id'), null);
});

test('unknown catalog scope is not persisted and malformed records fail closed', async t => {
  const { create } = await setup(t), cache = create();
  assert.equal(cache.rememberCatalog('ged', { ...catalog(), threads: [], sourceInfo: { scope: 'Human description' } }), false);
  assert.equal(cache.rememberTranscript('ged', 'source-a', 'thread-1', { messages: [{ id: 'x', role: 'system', text: 'context' }] }), false);
  assert.equal(await cache.loadCatalog('ged'), null);
});

test('streaming updates coalesce into a single disk write and callers cannot mutate cached records', async t => {
  const { create } = await setup(t), storage = captureStorage(), cache = create({ storage });
  const supplied = transcript('first');
  cache.rememberTranscript('ged', 'source-a', 'thread-1', supplied); supplied.messages[0].text = 'mutated';
  assert.equal((await cache.loadTranscript('ged', 'source-a', 'thread-1')).value.messages[0].text, 'first');
  for (let index = 0; index < 100; index++) cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript(`chunk-${index}`));
  assert.equal(storage.writes.length, 0);
  await cache.flush(); assert.equal(storage.writes.length, 1); assert.equal(storage.writes[0].length, 1);
  const loaded = await cache.loadTranscript('ged', 'source-a', 'thread-1'); loaded.value.messages[0].text = 'changed';
  assert.equal((await cache.loadTranscript('ged', 'source-a', 'thread-1')).value.messages[0].text, 'chunk-99');
});

test('memory LRU retains at most 20 transcripts and promotes an actual read', async t => {
  const { create } = await setup(t), cache = create({ storage: null });
  for (let index = 0; index < 20; index++) cache.rememberTranscript('ged', 'source-a', String(index), transcript(String(index)));
  await cache.loadTranscript('ged', 'source-a', '0');
  cache.rememberTranscript('ged', 'source-a', '20', transcript('20'));
  assert.equal(await cache.loadTranscript('ged', 'source-a', '1'), null);
  assert.ok(await cache.loadTranscript('ged', 'source-a', '0'));
  assert.ok(await cache.loadTranscript('ged', 'source-a', '20'));
});

test('memory has a UTF-16 byte bound and rejects an oversized single record without replacing a prior copy', async t => {
  const { create } = await setup(t), cache = create({ storage: null });
  const body = 'x'.repeat(1_100_000);
  for (let index = 0; index < 5; index++) cache.rememberTranscript('ged', 'source-a', String(index), transcript(body));
  assert.equal(await cache.loadTranscript('ged', 'source-a', '0'), null);
  assert.equal(await cache.loadTranscript('ged', 'source-a', '1'), null);
  assert.ok(await cache.loadTranscript('ged', 'source-a', '4'));
  assert.equal(cache.rememberTranscript('ged', 'source-a', '4', transcript('x'.repeat(readingCacheLimits.memoryBytes))), false);
  assert.equal((await cache.loadTranscript('ged', 'source-a', '4')).value.messages[0].text.length, body.length);
});

test('TTL uses saved time; reading a stale record does not renew it', async t => {
  const { create } = await setup(t); let now = baseTime;
  const cache = create({ now: () => now });
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript()); await cache.flush();
  now += readingCacheLimits.ttlMs - 1;
  assert.ok(await cache.loadTranscript('ged', 'source-a', 'thread-1'));
  now += 2;
  assert.equal(await cache.loadTranscript('ged', 'source-a', 'thread-1'), null);
  cache.dispose();
  assert.equal(await create({ now: () => now }).loadTranscript('ged', 'source-a', 'thread-1'), null);
});

test('disk count and byte bounds evict older entries within one committed transaction', async t => {
  await setup(t);
  const storage = createReadingCacheStorage(); t.after(() => storage.close());
  const makeRecord = (id, bytes = 1024) => ({ schema: 1, key: readingCacheKey('ged', 's', 'transcript', id), machine: 'ged', scope: 's',
    kind: 'transcript', threadId: id, savedAt: baseTime, accessedAt: baseTime + Number(id), bytes,
    json: JSON.stringify({ source: 'rollout', messages: [{ id, role: 'assistant', text: 'x'.repeat(bytes - 512) }] }), fence: readingCacheFence('ged') });
  await storage.write(Array.from({ length: 55 }, (_, index) => makeRecord(String(index))), baseTime);
  assert.equal((await records()).length, 50);
  assert.equal(await storage.transcript(readingCacheKey('ged', 's', 'transcript', '0'), 'ged'), null);
  await storage.write(Array.from({ length: 35 }, (_, index) => makeRecord(String(index + 100), 1024 * 1024)), baseTime);
  const remaining = await records();
  assert.ok(remaining.reduce((sum, value) => sum + value.bytes, 0) <= readingCacheLimits.diskBytes);
  assert.ok(remaining.length <= defaultReadingCacheLimit);
  storage.close();
});

test('corrupt JSON is ignored, while a subsequent fresh value repairs the same key', async t => {
  const { create } = await setup(t), cache = create();
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript()); await cache.flush(); cache.dispose();
  const db = await openDB(READING_CACHE_DATABASE, 1), record = (await db.getAll('entries'))[0];
  await db.put('entries', { ...record, json: '{bad' }); db.close();
  const next = create(); assert.equal(await next.loadTranscript('ged', 'source-a', 'thread-1'), null);
  next.rememberTranscript('ged', 'source-a', 'thread-1', transcript('repaired')); await next.flush();
  assert.equal((await next.loadTranscript('ged', 'source-a', 'thread-1')).value.messages[0].text, 'repaired');
});

test('unavailable browser storage and failed IDB writes preserve bounded memory reading', async t => {
  const { create } = await setup(t);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('private mode'); } });
  let attempts = 0;
  const noDisk = create({ storage: { ...captureStorage(), async write() { attempts++; throw new Error('quota'); } } });
  assert.equal(noDisk.rememberTranscript('ged', 'source-a', 'thread-1', transcript()), true);
  await noDisk.flush(); assert.equal(attempts, 0);
  assert.equal((await noDisk.loadTranscript('ged', 'source-a', 'thread-1')).value.messages[0].text, 'Saved answer');
  Object.defineProperty(globalThis, 'localStorage', { value: new LocalStorage(), configurable: true });
  const quota = create({ storage: { ...captureStorage(), async write() { attempts++; throw new Error('quota'); } } });
  quota.rememberTranscript('ged', 'source-a', 'thread-1', transcript()); await quota.flush();
  assert.equal(attempts, 1); assert.ok(await quota.loadTranscript('ged', 'source-a', 'thread-1'));
});

test('machine clear revokes all old cache instances, preserves other machines, and notifies the auth gate', async t => {
  const { create } = await setup(t), cache = create(), events = [];
  const unsubscribe = subscribeReadingCacheInvalidation(event => events.push(event)); t.after(unsubscribe);
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript('ged'));
  cache.rememberTranscript('wandou', 'source-a', 'thread-1', transcript('wandou')); await cache.flush();
  const otherInstance = create(); assert.ok(await otherInstance.loadTranscript('ged', 'source-a', 'thread-1'));
  assert.deepEqual(await clearReadingCache('ged'), { invalidated: true, cleared: true });
  assert.equal(await cache.loadTranscript('ged', 'source-a', 'thread-1'), null);
  assert.equal(otherInstance.rememberTranscript('ged', 'source-a', 'thread-1', transcript('late network')), false);
  assert.equal((await cache.loadTranscript('wandou', 'source-a', 'thread-1')).value.messages[0].text, 'wandou');
  assert.deepEqual(events, [{ machine: 'ged' }]);
  assert.equal(await create().loadTranscript('ged', 'source-a', 'thread-1'), null);
});

test('persistent epochs reject a stale writer even after it sees the new tombstone', async t => {
  const { create } = await setup(t), cache = create();
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript()); await cache.flush();
  const stale = createReadingCacheStorage(); t.after(() => stale.close());
  const record = await stale.transcript(readingCacheKey('ged', 'source-a', 'transcript', 'thread-1'), 'ged');
  await clearReadingCache('ged');
  await stale.write([{ ...record, fence: readingCacheFence('ged') }], baseTime);
  assert.equal((await records()).length, 0); stale.close();
});

test('a failed physical deletion leaves a durable tombstone that blocks future restored instances', async t => {
  const { create } = await setup(t), cache = create();
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript()); await cache.flush(); cache.dispose();
  const open = indexedDB.open;
  indexedDB.open = () => { throw new Error('storage unavailable'); };
  try { assert.deepEqual(await clearReadingCache('ged'), { invalidated: true, cleared: false }); }
  finally { indexedDB.open = open; }
  assert.equal((await records()).length, 1, 'fixture proves bytes survived failed deletion');
  assert.equal(await create().loadTranscript('ged', 'source-a', 'thread-1'), null);
});

test('disposal and an in-flight disk read cannot resurrect an exited view', async t => {
  const { create } = await setup(t), captured = captureStorage(), writer = create({ storage: captured });
  writer.rememberTranscript('ged', 'source-a', 'thread-1', transcript()); await writer.flush();
  const record = [...captured.values.values()][0]; let resolve;
  const reader = create({ storage: { ...captureStorage(), transcript: () => new Promise(done => { resolve = done; }) } });
  const pending = reader.loadTranscript('ged', 'source-a', 'thread-1');
  reader.dispose(); resolve(record);
  assert.equal(await pending, null);
  assert.equal(reader.rememberTranscript('ged', 'source-a', 'thread-1', transcript('late')), false);
});

test('a late disk catalog cannot replace a fresh catalog from a different source scope', async t => {
  const { create } = await setup(t), captured = captureStorage(), writer = create({ storage: captured });
  writer.rememberCatalog('ged', catalog('old', 'old scope')); await writer.flush();
  const record = [...captured.values.values()][0]; let resolve;
  const reader = create({ storage: { ...captureStorage(), catalog: () => new Promise(done => { resolve = done; }) } });
  const pending = reader.loadCatalog('ged');
  reader.rememberCatalog('ged', catalog('new', 'fresh scope')); resolve(record);
  assert.equal((await pending).value.threads[0].title, 'fresh scope');
});

test('changing source scope replaces the machine catalog even within the same millisecond', async t => {
  const { create } = await setup(t), cache = create();
  cache.rememberCatalog('ged', catalog('old', 'old')); await cache.flush();
  cache.rememberCatalog('ged', catalog('new', 'new')); await cache.flush();
  assert.equal((await cache.loadCatalog('ged')).scope, 'new');
  assert.equal((await records()).filter(record => record.kind === 'catalog').length, 1);
  cache.dispose(); assert.equal((await create().loadCatalog('ged')).scope, 'new');
});

test('a slow disk write keeps only the latest streaming update instead of queuing snapshots', async t => {
  const { create } = await setup(t), batches = [], releases = [];
  const cache = create({ storage: { ...captureStorage(), write(batch) {
    batches.push(batch); return new Promise(resolve => releases.push(resolve));
  } } });
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript('first'));
  const flushing = cache.flush();
  for (let index = 0; index < 100; index++) {
    cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript(`later-${index}`));
    assert.equal(cache.flush(), flushing);
  }
  assert.equal(batches.length, 1); releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(batches.length, 2);
  assert.equal(JSON.parse(batches[1][0].json).messages[0].text, 'later-99');
  releases.shift()(); await flushing;
});

test('clear all removes both machines and permanently rejects late callbacks on existing instances', async t => {
  const { create } = await setup(t), cache = create();
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript());
  cache.rememberTranscript('wandou', 'source-a', 'thread-1', transcript()); await cache.flush();
  assert.deepEqual(await cache.clearAll(), { invalidated: true, cleared: true });
  assert.equal(cache.rememberTranscript('wandou', 'source-a', 'thread-1', transcript('late')), false);
  assert.deepEqual(await records(), []);
});

test('when both durable invalidation paths fail, clear reports failure while immediately clearing this view', async t => {
  const { create } = await setup(t), cache = create({ storage: null });
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript());
  localStorage.setItem = () => { throw new Error('no writes'); };
  const open = indexedDB.open; indexedDB.open = () => { throw new Error('no IDB writes'); };
  try { assert.deepEqual(await clearReadingCache('ged'), { invalidated: false, cleared: false }); }
  finally { indexedDB.open = open; }
  assert.equal(await cache.loadTranscript('ged', 'source-a', 'thread-1'), null);
});

test('an aborted IndexedDB transaction degrades to memory without an unhandled transaction rejection', async t => {
  const { create } = await setup(t), cache = create();
  await cache.loadCatalog('ged');
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'entries') this.transaction.abort();
    return put.apply(this, args);
  };
  try {
    cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript()); await cache.flush();
  } finally { IDBObjectStore.prototype.put = put; }
  assert.equal((await cache.loadTranscript('ged', 'source-a', 'thread-1')).value.messages[0].text, 'Saved answer');
  await new Promise(resolve => setImmediate(resolve));
});

test('an old tab LRU touch cannot overwrite another tab newer body or resurrect its old catalog scope', async t => {
  const { create } = await setup(t); let now = baseTime;
  const older = create({ now: () => now }), newer = create({ now: () => now });
  older.rememberTranscript('ged', 'source-a', 'thread-1', transcript('old'));
  older.rememberCatalog('ged', catalog('old-scope', 'old catalog')); await older.flush();
  now += 100;
  newer.rememberTranscript('ged', 'source-a', 'thread-1', transcript('new'));
  newer.rememberCatalog('ged', catalog('new-scope', 'new catalog')); await newer.flush();
  now += 100;
  assert.equal((await older.loadTranscript('ged', 'source-a', 'thread-1')).value.messages[0].text, 'old');
  assert.equal((await older.loadCatalog('ged')).scope, 'old-scope'); await older.flush();
  const restored = create({ now: () => now });
  assert.equal((await restored.loadTranscript('ged', 'source-a', 'thread-1')).value.messages[0].text, 'new');
  assert.equal((await restored.loadCatalog('ged')).scope, 'new-scope');
});

test('L1 validates durable revocation even when localStorage is read-only and cross-tab messages were lost', async t => {
  const { create } = await setup(t), cache = create();
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript()); await cache.flush();
  localStorage.setItem = () => { throw new Error('read-only'); };
  // Simulate the other tab's completed IDB clear without delivering a same-tab
  // event. The local fence remains unchanged and L1 still contains the old body.
  const db = await openDB(READING_CACHE_DATABASE, 1), tx = db.transaction(['epochs', 'entries'], 'readwrite');
  await tx.objectStore('epochs').put(1, 'ged'); await tx.objectStore('entries').clear(); await tx.done; db.close();
  assert.equal(await cache.loadTranscript('ged', 'source-a', 'thread-1'), null);
  assert.equal(cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript('late')), false);
});

test('unchanged validated transcripts do not rewrite the body every poll but periodically renew disk TTL', async t => {
  const { create } = await setup(t), storage = captureStorage(); let now = baseTime;
  const cache = create({ storage, now: () => now });
  for (let index = 0; index < 30; index++) {
    now = baseTime + index * 2000;
    cache.rememberTranscript('ged', 'source-a', 'thread-1', { ...transcript(), checkedAt: now }); await cache.flush();
  }
  assert.equal(storage.writes.length, 1, 'unchanged 304 observations do not rewrite a body');
  now = baseTime + 61_000;
  cache.rememberTranscript('ged', 'source-a', 'thread-1', { ...transcript(), checkedAt: now }); await cache.flush();
  assert.equal(storage.writes.length, 2, 'fresh validation periodically renews persisted TTL');
  assert.equal(storage.writes[1][0].savedAt, now);
  assert.equal((await cache.loadTranscript('ged', 'source-a', 'thread-1')).value.checkedAt, now);
});

test('a later-arriving old content revision cannot replace a newer transcript saved by another tab', async t => {
  const { create } = await setup(t); let now = baseTime;
  const a = create({ now: () => now }), b = create({ now: () => now });
  const old = { ...transcript('old'), checkedAt: baseTime + 100 };
  a.rememberTranscript('ged', 'source-a', 'thread-1', old); await a.flush();
  now += 100;
  const fresh = { ...transcript('new'), checkedAt: baseTime + 200, pocketContent: { ...pocketContent('source-a'), revision: 2 } };
  b.rememberTranscript('ged', 'source-a', 'thread-1', fresh); await b.flush();
  now += 70_000;
  a.rememberTranscript('ged', 'source-a', 'thread-1', { ...old, checkedAt: baseTime + 300 }); await a.flush();
  assert.equal((await create({ now: () => now }).loadTranscript('ged', 'source-a', 'thread-1')).value.messages[0].text, 'new');
});

test('source observation times protect transcript/catalog order when a content revision is unavailable', async t => {
  const { create } = await setup(t); let now = baseTime;
  const a = create({ now: () => now }), b = create({ now: () => now });
  const body = (text, observedAt) => ({ ...transcript(text), pocketContent: undefined, checkedAt: observedAt });
  const list = (title, observedAt, scope = 'source-a') => {
    const value = catalog(scope, title); value.sourceInfo.syncedAt = observedAt; return value;
  };
  a.rememberTranscript('ged', 'source-a', 'thread-1', body('old', 100)); a.rememberCatalog('ged', list('old', 100)); await a.flush();
  now += 100;
  b.rememberTranscript('ged', 'source-a', 'thread-1', body('new', 200)); b.rememberCatalog('ged', list('new', 200)); await b.flush();
  now += 70_000;
  a.rememberTranscript('ged', 'source-a', 'thread-1', body('old', 100)); a.rememberCatalog('ged', list('old', 100)); await a.flush();
  const restored = create({ now: () => now });
  assert.equal((await restored.loadTranscript('ged', 'source-a', 'thread-1')).value.messages[0].text, 'new');
  assert.equal((await restored.loadCatalog('ged')).value.threads[0].title, 'new');
  now += 100;
  restored.rememberCatalog('ged', list('new source', 5, 'source-b')); await restored.flush();
  assert.equal((await create({ now: () => now }).loadCatalog('ged')).scope, 'source-b', 'different scopes may reset the source clock');
});

test('cross-tab broadcast and storage invalidations reach the auth subscriber and revoke old readers', async t => {
  const { create } = await setup(t), handlers = new Map(), broadcasts = [], events = [];
  const oldWindow = globalThis.window, oldChannel = globalThis.BroadcastChannel;
  let channel;
  globalThis.window = { addEventListener(type, listener) { handlers.set(type, listener); } };
  globalThis.BroadcastChannel = class {
    constructor() { channel = this; }
    postMessage(value) { broadcasts.push(value); }
  };
  const cache = create({ storage: null });
  const unsubscribe = subscribeReadingCacheInvalidation(event => events.push(event));
  t.after(() => {
    unsubscribe();
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    globalThis.BroadcastChannel = oldChannel;
  });
  cache.rememberTranscript('ged', 'source-a', 'thread-1', transcript());
  channel.onmessage({ data: { type: 'invalidate', machine: 'ged' } });
  assert.equal(await cache.loadTranscript('ged', 'source-a', 'thread-1'), null);
  await clearReadingCache('wandou');
  assert.deepEqual(broadcasts, [{ type: 'invalidate', machine: 'wandou' }]);
  handlers.get('storage')({ key: null });
  assert.deepEqual(events, [{ machine: 'ged' }, { machine: 'wandou' }, { machine: null }]);
});

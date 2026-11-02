import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { createReadingCache, clearReadingCache, readingCacheLimits } from '../src/readingCache.ts';
import { createReadingCacheStorage, mergeReadingCatalogRecords, readingCacheFence, readingCacheKey,
  READING_CACHE_DATABASE } from '../src/readingCacheStorage.ts';

const time = 1_790_000_000_000;
const thread = (extra = {}) => ({ id: 'one', hostId: 'local', title: 'Original title', titleRevision: 1, cwd: '/synthetic',
  projectId: 'p', projectName: 'Original project', archived: false, source: 'app', createdAt: time, updatedAt: time,
  pinned: false, pinnedOrder: 0, pinSource: 'codex', codexPinned: false, pocketPriority: false, pinRevision: 1,
  pocketHidden: false, hiddenRevision: 1, ...extra });
const catalog = (threads = [thread()], { scope = 'scope-a', observedAt = time, ...extra } = {}) => ({
  threads, groups: [], projects: [], sourceError: null,
  sourceInfo: { scope: 'Synthetic source', syncedAt: observedAt, total: threads.length, active: threads.length, archived: 0,
    pocketRead: { available: true, scope } }, ...extra,
});
async function setup(t) {
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
  } });
  await deleteDB(READING_CACHE_DATABASE);
  let now = time;
  const caches = [], stores = [];
  const create = options => {
    const value = createReadingCache({ now: () => now, ...options }); caches.push(value); return value;
  };
  const store = () => { const value = createReadingCacheStorage(); stores.push(value); return value; };
  t.after(async () => {
    caches.forEach(cache => cache.dispose()); stores.forEach(storage => storage.close());
    await deleteDB(READING_CACHE_DATABASE); delete globalThis.localStorage;
  });
  return { create, store, advance: value => { now += value; }, now: () => now };
}
async function storedRecords() {
  const db = await openDB(READING_CACHE_DATABASE, 1);
  try { return await db.getAll('entries'); } finally { db.close(); }
}
function record(value, { savedAt = time, machine = 'ged', fence = readingCacheFence(machine) } = {}) {
  const scope = value.sourceInfo.pocketRead.scope, key = readingCacheKey(machine, scope, 'catalog');
  const json = JSON.stringify(value);
  return { schema: 1, kind: 'catalog', machine, scope, key, threadId: '', savedAt, accessedAt: savedAt,
    observedAt: value.sourceInfo.syncedAt, json, bytes: new TextEncoder().encode(json).byteLength + key.length * 2 + 512, fence };
}

test('later L1 catalog reads cannot roll back hidden, title or pin revisions', async t => {
  const h = await setup(t), cache = h.create({ storage: null });
  const known = thread({ pocketHidden: true, hiddenRevision: 3, title: 'Renamed', titleRevision: 4,
    pinned: true, pinnedOrder: -1, pinSource: 'pocket', pocketPriority: true, codexPinned: true, pinRevision: 5 });
  cache.rememberCatalog('ged', catalog([known]));
  h.advance(100);
  cache.rememberCatalog('ged', catalog([thread({ projectName: 'New source field' })]));
  const loaded = await cache.loadCatalog('ged');
  assert.equal(loaded.value.threads[0].projectName, 'New source field');
  for (const name of ['pocketHidden', 'hiddenRevision', 'title', 'titleRevision', 'pinned', 'pinnedOrder', 'pinSource', 'pocketPriority', 'codexPinned', 'pinRevision'])
    assert.equal(loaded.value.threads[0][name], known[name], name);
});

test('an older source observation can advance metadata without replacing the body or renewing freshness', async t => {
  const h = await setup(t), cache = h.create({ storage: null });
  cache.rememberCatalog('ged', catalog([thread({ projectName: 'Current project' })], { observedAt: time + 20 }));
  h.advance(70_000);
  assert.equal(cache.rememberCatalog('ged', catalog([thread({ pocketHidden: true, hiddenRevision: 2, projectName: 'Old project' }),
    thread({ id: 'removed', pocketHidden: true, hiddenRevision: 2 })], { observedAt: time + 10 })), true);
  const loaded = await cache.loadCatalog('ged');
  assert.equal(loaded.savedAt, time);
  assert.equal(loaded.value.sourceInfo.syncedAt, time + 20);
  assert.deepEqual(loaded.value.threads.map(row => row.id), ['one']);
  assert.equal(loaded.value.threads[0].projectName, 'Current project');
  assert.equal(loaded.value.threads[0].pocketHidden, true);
  assert.equal(loaded.value.threads[0].hiddenRevision, 2);
});

test('two tab writers retain newer hide and unhide revisions in the same IDB transaction', async t => {
  const h = await setup(t), a = h.create(), b = h.create();
  a.rememberCatalog('ged', catalog()); await a.flush();
  h.advance(10); b.rememberCatalog('ged', catalog([thread({ pocketHidden: true, hiddenRevision: 2 })])); await b.flush();
  h.advance(10); a.rememberCatalog('ged', catalog()); await a.flush();
  assert.equal((await h.create().loadCatalog('ged')).value.threads[0].pocketHidden, true);
  assert.equal((await a.loadCatalog('ged')).value.threads[0].hiddenRevision, 2, 'Existing L1 reconciles the same-scope stored metadata');
  h.advance(10); b.rememberCatalog('ged', catalog([thread({ pocketHidden: false, hiddenRevision: 3 })])); await b.flush();
  h.advance(10); a.rememberCatalog('ged', catalog([thread({ pocketHidden: true, hiddenRevision: 2 })])); await a.flush();
  const restored = (await h.create().loadCatalog('ged')).value.threads[0];
  assert.equal(restored.pocketHidden, false); assert.equal(restored.hiddenRevision, 3);
});

test('IDB merges older-observation metadata without resurrecting removed rows or extending the body TTL', async t => {
  const h = await setup(t), a = h.create(), b = h.create();
  a.rememberCatalog('ged', catalog([thread({ projectName: 'Current project' })], { observedAt: time + 20 })); await a.flush();
  h.advance(70_000);
  b.rememberCatalog('ged', catalog([thread({ pocketHidden: true, hiddenRevision: 2, title: 'Renamed', titleRevision: 2,
    pinned: true, pinnedOrder: -1, pinSource: 'pocket', pocketPriority: true, pinRevision: 2 }),
    thread({ id: 'removed', pocketHidden: true, hiddenRevision: 2 })], { observedAt: time + 10 })); await b.flush();
  const loaded = await h.create().loadCatalog('ged');
  assert.equal(loaded.savedAt, time); assert.equal(loaded.value.sourceInfo.syncedAt, time + 20);
  assert.deepEqual(loaded.value.threads.map(row => row.id), ['one']);
  assert.equal(loaded.value.threads[0].projectName, 'Current project');
  assert.equal(loaded.value.threads[0].title, 'Renamed'); assert.equal(loaded.value.threads[0].pocketHidden, true);
  assert.equal(loaded.value.threads[0].pocketPriority, true); assert.equal(loaded.value.threads[0].pinRevision, 2);
});

test('a disk-read race merges metadata into the winning live directory instead of replacing its membership', async t => {
  const h = await setup(t); let release;
  const pending = new Promise(resolve => { release = resolve; });
  const cache = h.create({ storage: { catalog: () => pending, transcript: async () => null, write: async () => {}, close() {} } });
  const reading = cache.loadCatalog('ged');
  cache.rememberCatalog('ged', catalog([thread({ projectName: 'Live project' })], { observedAt: time + 20 }));
  release(record(catalog([thread({ pocketHidden: true, hiddenRevision: 2 }), thread({ id: 'removed' })], { observedAt: time + 10 })));
  const loaded = await reading;
  assert.deepEqual(loaded.value.threads.map(row => row.id), ['one']);
  assert.equal(loaded.value.threads[0].projectName, 'Live project'); assert.equal(loaded.value.threads[0].pocketHidden, true);
});

test('machine, scope and authentication revocation isolate hidden state and reject old writers', async t => {
  const h = await setup(t), a = h.create(), b = h.create(), oldWriter = h.store();
  a.rememberCatalog('ged', catalog([thread({ pocketHidden: true, hiddenRevision: 90 })]));
  a.rememberCatalog('wandou', catalog([thread({ hiddenRevision: 1 })])); await a.flush();
  const stale = (await storedRecords()).find(row => row.machine === 'ged');
  h.advance(10); b.rememberCatalog('ged', catalog([thread()], { scope: 'scope-b' })); await b.flush();
  assert.equal((await a.loadCatalog('ged')).scope, 'scope-a', 'Disk cannot switch an in-use L1 to another source');
  const fresh = await h.create().loadCatalog('ged');
  assert.equal(fresh.scope, 'scope-b'); assert.equal(fresh.value.threads[0].pocketHidden, false);
  assert.equal((await h.create().loadCatalog('wandou')).value.threads[0].pocketHidden, false);
  await clearReadingCache('ged');
  await oldWriter.write([stale], h.now());
  assert.equal(await a.loadCatalog('ged'), null);
  assert.equal(await h.create().loadCatalog('ged'), null);
  assert.ok(await h.create().loadCatalog('wandou'));
});

test('metadata merging cannot copy capabilities, malformed metadata or fields from another scope or fence', async t => {
  await setup(t);
  const base = record(catalog());
  const donor = record(catalog([thread({ pocketHidden: true, hiddenRevision: 2, title: { invalid: true }, titleRevision: 10,
    pinned: 'invalid', pinRevision: 10, canSend: true, operation: { status: 'succeeded' }, attachments: [{ url: '/secret' }] })],
  { observedAt: time - 1, csrfToken: 'secret' }));
  const merged = JSON.parse(mergeReadingCatalogRecords(base, donor).json);
  assert.equal(merged.threads[0].pocketHidden, true); assert.equal(merged.threads[0].title, 'Original title');
  assert.equal(merged.threads[0].pinned, false); assert.equal(merged.threads[0].pinRevision, 1);
  for (const prohibited of ['secret', 'canSend', 'operation', 'attachments']) assert.equal(JSON.stringify(merged).includes(prohibited), false);
  assert.equal(JSON.parse(mergeReadingCatalogRecords(base, { ...donor, fence: 'other' }).json).threads[0].pocketHidden, false);
  assert.equal(JSON.parse(mergeReadingCatalogRecords(base, { ...donor, scope: 'other' }).json).threads[0].pocketHidden, false);
});

test('merging independent large titles stays within the existing memory and disk budgets', async t => {
  const h = await setup(t), a = h.create(), b = h.create();
  const large = 'x'.repeat(2_200_000);
  const first = catalog([thread({ title: large }), thread({ id: 'two' })], { observedAt: time + 20 });
  const second = catalog([thread(), thread({ id: 'two', title: large, titleRevision: 2 })], { observedAt: time + 10 });
  a.rememberCatalog('ged', first); await a.flush();
  h.advance(10); b.rememberCatalog('ged', second); await b.flush();
  assert.equal(await h.create().loadCatalog('ged'), null, 'An unrepresentable merged catalog is evicted rather than written oversized');
  const memory = h.create({ storage: null }); memory.rememberCatalog('ged', first);
  assert.equal(memory.rememberCatalog('ged', second), false);
  assert.equal(await memory.loadCatalog('ged'), null);
  assert.ok((await storedRecords()).every(row => row.bytes <= readingCacheLimits.diskBytes && row.json.length * 2 <= readingCacheLimits.memoryBytes));
});

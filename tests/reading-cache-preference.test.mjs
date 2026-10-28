import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openDB, deleteDB } from 'idb';
import {
  createReadingCachePreferenceStore, readingCachePreferenceKey, readingCacheLimitOptions,
  readReadingCacheLimit, saveReadingCacheLimit,
} from '../src/readingCachePreference.ts';
import { createReadingCache, subscribeReadingCacheInvalidation, trimReadingCache } from '../src/readingCache.ts';
import { createReadingCacheStorage, readingCacheFence, readingCacheKey, READING_CACHE_DATABASE } from '../src/readingCacheStorage.ts';

class LocalStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function browserFixture() {
  const browser = new EventTarget(), storage = new LocalStorage();
  browser.localStorage = storage;
  const changed = (key = readingCachePreferenceKey, storageArea = storage) => {
    const event = new Event('storage'); Object.assign(event, { key, storageArea }); browser.dispatchEvent(event);
  };
  return { browser, storage, changed, create: () => createReadingCachePreferenceStore({ browser: () => browser }) };
}

test('cache count defaults to 50 and all five choices share one browser key across machines', () => {
  const f = browserFixture(), first = f.create();
  assert.equal(first.read(), 50);
  assert.deepEqual(readingCacheLimitOptions, [20, 50, 100, 200, 500]);
  for (const limit of readingCacheLimitOptions) {
    assert.deepEqual(first.save(limit), { limit, persisted: true });
    assert.equal(first.read(), limit);
    assert.equal(f.create().read(), limit, 'another machine/view reads the same origin-wide choice');
  }
  assert.deepEqual([...f.storage.values], [[readingCachePreferenceKey, '500']]);
  for (const bad of ['0', '21', '501', 'null', '{', '020', ' 50', '50.0', 'Infinity']) {
    f.storage.setItem(readingCachePreferenceKey, bad); assert.equal(first.read(), 50, bad);
  }
  assert.deepEqual(first.save(123), { limit: 50, persisted: true });
});

test('same-page subscribers and cross-tab storage events stay synchronized and unsubscribe cleanly', () => {
  const f = browserFixture(), first = f.create(), second = f.create(), seenA = [], seenB = [];
  const stopA = first.subscribe(() => seenA.push(first.read())), stopB = second.subscribe(() => seenB.push(second.read()));
  first.save(200);
  assert.deepEqual(seenA, [200]); assert.deepEqual(seenB, [200]);
  f.storage.setItem(readingCachePreferenceKey, '20'); f.changed();
  f.storage.setItem(readingCachePreferenceKey, '{bad'); f.changed();
  assert.deepEqual(seenA, [200, 20, 50]); assert.deepEqual(seenB, [200, 20, 50]);
  f.changed('other'); f.changed(readingCachePreferenceKey, {});
  assert.equal(seenA.length, 3);
  stopA(); stopB(); first.save(100); f.changed();
  assert.equal(seenA.length, 3); assert.equal(seenB.length, 3);
});

test('blocked localStorage preserves the explicit page choice until an actual external change', () => {
  const f = browserFixture(), first = f.create(), second = f.create();
  f.storage.setItem(readingCachePreferenceKey, '50');
  const stop = second.subscribe(() => {}), put = f.storage.setItem;
  f.storage.setItem = () => { throw new Error('quota'); };
  assert.deepEqual(first.save(100), { limit: 100, persisted: false });
  assert.equal(first.read(), 100); assert.equal(second.read(), 100);
  assert.equal(f.storage.getItem(readingCachePreferenceKey), '50', 'the failed write did not change durable state');
  f.storage.setItem = put; f.storage.setItem(readingCachePreferenceKey, '200'); f.changed();
  assert.equal(second.read(), 200); stop();
  const withoutStorage = createReadingCachePreferenceStore({ browser: () => undefined, storage: () => undefined });
  assert.deepEqual(withoutStorage.save(20), { limit: 20, persisted: false }); assert.equal(withoutStorage.read(), 20);
});

async function fixture(t, withBrowser = false) {
  const storage = new LocalStorage(), previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  if (withBrowser) { globalThis.window = new EventTarget(); globalThis.window.localStorage = storage; }
  saveReadingCacheLimit(50);
  await deleteDB(READING_CACHE_DATABASE);
  const open = [];
  const keep = value => { open.push(value); return value; };
  t.after(async () => {
    open.forEach(value => value.dispose ? value.dispose() : value.close());
    await deleteDB(READING_CACHE_DATABASE);
    delete globalThis.localStorage;
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  });
  return { keep, storage, now: Date.now() };
}
function record(index, now, kind = 'transcript') {
  const machine = index % 2 ? 'wandou' : 'ged', id = kind === 'catalog' ? '' : String(index);
  const json = kind === 'catalog' ? JSON.stringify({ threads: [], groups: [], projects: [] })
    : JSON.stringify({ source: 'rollout', messages: [{ id, role: 'assistant', text: `Synthetic ${index}` }] });
  return { schema: 1, machine, scope: 'source-a', kind, threadId: id, key: readingCacheKey(machine, 'source-a', kind, id),
    savedAt: now, accessedAt: now + index, json, bytes: 1024, fence: readingCacheFence(machine) };
}
async function readDatabase() {
  const db = await openDB(READING_CACHE_DATABASE, 1);
  try { return { entries: await db.getAll('entries'), epochs: await db.getAll('epochs') }; }
  finally { db.close(); }
}

test('lowering the global limit immediately preserves only the newest transcripts without auth invalidation', async t => {
  const f = await fixture(t), storage = f.keep(createReadingCacheStorage()), events = [];
  const unsubscribe = subscribeReadingCacheInvalidation(event => events.push(event)); t.after(unsubscribe);
  saveReadingCacheLimit(100);
  await storage.write([...Array.from({ length: 55 }, (_, index) => record(index, f.now)), record(1000, f.now, 'catalog'), record(1001, f.now, 'catalog')], f.now);
  const before = await readDatabase(), fences = [readingCacheFence('ged'), readingCacheFence('wandou')];
  assert.equal(before.entries.filter(value => value.kind === 'transcript').length, 55);
  saveReadingCacheLimit(20);
  assert.deepEqual(await trimReadingCache(), { trimmed: true });
  const after = await readDatabase(), transcripts = after.entries.filter(value => value.kind === 'transcript');
  assert.equal(transcripts.length, 20);
  assert.deepEqual(transcripts.map(value => Number(value.threadId)).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 35));
  assert.equal(after.entries.filter(value => value.kind === 'catalog').length, 2);
  assert.deepEqual(after.epochs, before.epochs); assert.deepEqual([readingCacheFence('ged'), readingCacheFence('wandou')], fences);
  assert.deepEqual(events, []); assert.equal(await storage.isCurrent('ged'), true);
});

test('raising the limit performs no prefetch and later writes use the chosen maximum, including 500', async t => {
  const f = await fixture(t), storage = f.keep(createReadingCacheStorage());
  saveReadingCacheLimit(20); await storage.write(Array.from({ length: 25 }, (_, index) => record(index, f.now)), f.now);
  const before = (await readDatabase()).entries;
  saveReadingCacheLimit(200);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await readDatabase()).entries, before, 'raising changes no saved body or access metadata');
  await storage.write(Array.from({ length: 80 }, (_, index) => record(index + 100, f.now)), f.now);
  assert.equal((await readDatabase()).entries.length, 100);
  saveReadingCacheLimit(500); await storage.write(Array.from({ length: 550 }, (_, index) => record(index + 1000, f.now)), f.now);
  assert.equal((await readDatabase()).entries.length, 500);
});

test('a slow in-flight batch and queued old work cannot grow past a lowered limit', async t => {
  const f = await fixture(t), storage = f.keep(createReadingCacheStorage());
  saveReadingCacheLimit(100); await storage.write(Array.from({ length: 55 }, (_, index) => record(index, f.now)), f.now);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = f.keep(createReadingCache({ storage: { ...storage, async write(batch, now) { await gate; return storage.write(batch, now); } } }));
  const remember = id => cache.rememberTranscript('ged', 'source-a', String(id), { source: 'rollout', checkedAt: f.now,
    messages: [{ id: String(id), role: 'assistant', text: `Late ${id}` }] });
  for (let index = 100; index < 110; index++) remember(index);
  const pending = cache.flush();
  for (let index = 110; index < 120; index++) remember(index);
  saveReadingCacheLimit(20); await trimReadingCache();
  release(); await pending;
  assert.equal((await readDatabase()).entries.length, 20);
  await storage.write(Array.from({ length: 30 }, (_, index) => record(index + 500, f.now)), f.now);
  assert.equal((await readDatabase()).entries.length, 20, 'an adapter opened under 100 still applies the current 20');
});

test('cross-tab decreases and bad-value fallback trigger trimming without a new body write', async t => {
  const f = await fixture(t, true), storage = f.keep(createReadingCacheStorage());
  saveReadingCacheLimit(200); await storage.write(Array.from({ length: 100 }, (_, index) => record(index, f.now)), f.now);
  const external = value => {
    f.storage.setItem(readingCachePreferenceKey, value);
    const event = new Event('storage'); Object.assign(event, { key: readingCachePreferenceKey, storageArea: f.storage }); window.dispatchEvent(event);
  };
  external('{bad'); assert.equal(readReadingCacheLimit(), 50);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readDatabase()).entries.length, 50, 'the subscribed adapter queued its own immediate trim');
  external('20'); assert.equal(readReadingCacheLimit(), 20);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await readDatabase()).entries.length, 20);
});

test('a page-only limit still constrains writes when durable preference storage fails', async t => {
  const f = await fixture(t), storage = f.keep(createReadingCacheStorage());
  saveReadingCacheLimit(100); await storage.write(Array.from({ length: 60 }, (_, index) => record(index, f.now)), f.now);
  f.storage.setItem = () => { throw new Error('blocked'); };
  assert.deepEqual(saveReadingCacheLimit(20), { limit: 20, persisted: false });
  assert.equal(f.storage.getItem(readingCachePreferenceKey), '100');
  await trimReadingCache();
  assert.equal((await readDatabase()).entries.length, 20);
  await storage.write(Array.from({ length: 30 }, (_, index) => record(index + 100, f.now)), f.now);
  assert.equal((await readDatabase()).entries.length, 20);
});

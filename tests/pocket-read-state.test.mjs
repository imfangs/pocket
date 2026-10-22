import test from 'node:test';
import assert from 'node:assert/strict';
import { createPocketReadStateStore, isPocketContent } from '../src/pocketReadState.ts';

const content = (revision = 1, extra = {}) => ({ known: true, scope: 'source-one', revision, version: String(revision).padStart(64, '0'), messageId: 'assistant-one', ...extra });
const thread = (cursor = content(), extra = {}) => ({ id: 'one', pocketContent: cursor, hasUnreadTurn: true, ...extra });
function setup({ values = new Map(), machine = () => 'ged', failing = false, maxRecords, now } = {}) {
  const browser = new EventTarget();
  const storage = { getItem: key => { if (failing) throw Error('storage blocked'); return values.get(key) ?? null; }, setItem: (key, value) => { if (failing) throw Error('storage blocked'); values.set(key, value); }, removeItem: key => values.delete(key), key: index => [...values.keys()][index], get length() { return values.size; } };
  const store = createPocketReadStateStore({ storage, browser: () => browser, machine, maxRecords, now });
  const change = (key, detail = {}) => browser.dispatchEvent(Object.assign(new Event('storage'), { key, ...detail }));
  return { values, store, storage, change };
}

test('Pocket content validation rejects unusable revisions, versions and source identities', () => {
  assert.equal(isPocketContent(content()), true);
  for (const extra of [{ revision: 0 }, { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { version: 'short' }, { version: 'G'.repeat(64) }, { known: false }, { scope: '' }, { messageId: '' }])
    assert.equal(isPocketContent(content(1, extra)), false);
});

test('one initial native baseline is retained but never consulted again', () => {
  for (const [initial, expected] of [[{ hasUnreadTurn: true }, true], [{ hasUnreadTurn: false }, false], [{ hasUnreadTurn: null }, false], [{ hasUnreadTurn: false, needsInput: true }, false]]) {
    const { store } = setup();
    const first = thread(content(), initial);
    store.observeCatalog([first], 'source-one');
    assert.equal(store.unread(first), expected);
    const flipped = { ...first, hasUnreadTurn: !expected, needsInput: !expected };
    store.observeCatalog([flipped], 'source-one');
    assert.equal(store.unread(flipped), expected);
  }
});

test('visible reading clears immediately and persists through refresh despite native unread', () => {
  const { store, values } = setup();
  const source = thread();
  store.observeCatalog([source]);
  store.markSeen(source.id, source.pocketContent);
  assert.equal(store.unread(source), false);
  const reloaded = setup({ values }).store;
  reloaded.observeCatalog([source]);
  assert.equal(reloaded.unread(source), false);
  assert.equal([...values.values()].some(value => value.includes('hasUnreadTurn')), false);
});

test('same-message appended content becomes unread while old metadata or native false cannot clear it', () => {
  const { store } = setup();
  store.observeCatalog([thread()]); store.markSeen('one', content());
  const newer = thread(content(2), { hasUnreadTurn: false, needsInput: false });
  store.observeCatalog([newer]);
  assert.equal(store.unread(newer), true);
  store.observeCatalog([thread(content(), { hasUnreadTurn: false, needsInput: false })]);
  assert.equal(store.unread(thread(content())), true, 'late old catalog still sees known latest V2');
  store.markSeen('one', content());
  assert.equal(store.unread(newer), true, 'seeing V1 cannot clear V2');
  store.markSeen('one', content(2));
  assert.equal(store.unread(newer), false);
});

test('read watermarks and content metadata only move forward', () => {
  const { store } = setup();
  store.markSeen('one', content(3));
  store.markSeen('one', content());
  store.observeCatalog([thread(content(2))]);
  assert.equal(store.unread(thread(content(3))), false);
  store.observeCatalog([thread(content(4))]);
  assert.equal(store.unread(thread(content(4))), true);
});

test('same revision with conflicting content never becomes read until a higher revision', () => {
  const { store, values } = setup();
  store.observeCatalog([thread()]); store.markSeen('one', content());
  const conflict = content(1, { version: 'b'.repeat(64) });
  store.observeCatalog([thread(conflict)]); store.markSeen('one', conflict); store.markSeen('one', content());
  assert.equal(store.unread(thread(conflict)), true);
  assert.equal(setup({ values }).store.unread(thread()), true, 'the conflict survives page refresh');
  store.markSeen('one', content(2));
  assert.equal(store.unread(thread(content(2))), false);
});

test('empty conversations stay read but a first assistant reply is new content', () => {
  const { store } = setup();
  const empty = content(1, { messageId: null });
  store.observeCatalog([thread(empty)]);
  assert.equal(store.unread(thread(empty)), false);
  store.observeCatalog([thread(content(2), { hasUnreadTurn: false })]);
  assert.equal(store.unread(thread(content(2))), true);
});

test('unknown source snapshots preserve known reading without crossing a source reset', () => {
  const { store } = setup();
  store.observeCatalog([thread()], 'source-one'); store.markSeen('one', content());
  store.observeCatalog([{ id: 'one' }], 'source-one');
  assert.equal(store.unread({ id: 'one' }), false);
  store.observeCatalog([], 'source-two');
  assert.equal(store.unread({ id: 'one' }), undefined);
  assert.equal(store.unread(thread()), undefined, 'a preserved old catalog thread cannot cross the active source reset');
  store.markSeen('one', content());
  assert.equal(store.unread({ id: 'one' }), undefined, 'old content observation cannot restore the old active scope');
  const next = thread(content(1, { scope: 'source-two' }));
  store.observeCatalog([next], 'source-two');
  assert.equal(store.unread(next), true);
});

test('identical source and thread ids are isolated by machine', () => {
  let selected = 'ged';
  const { store, values } = setup({ machine: () => selected });
  store.observeCatalog([thread()]); store.markSeen('one', content());
  selected = 'wandou'; store.observeCatalog([thread()]);
  assert.equal(store.unread(thread()), true);
  selected = 'ged'; assert.equal(store.unread(thread()), false);
  assert.equal(values.size, 2);
});

test('storage restrictions preserve actual reading in the current page', () => {
  const { store } = setup({ failing: true });
  store.observeCatalog([thread()]); store.markSeen('one', content());
  assert.equal(store.unread(thread()), false);
  store.observeCatalog([thread(content(2))]);
  assert.equal(store.unread(thread(content(2))), true);
});

test('malformed storage safely establishes a baseline and stores no conversation data', () => {
  const { store, values } = setup();
  store.observeCatalog([thread()]);
  const key = [...values.keys()][0]; values.set(key, '{broken');
  const next = setup({ values }).store;
  next.observeCatalog([thread(content(), { hasUnreadTurn: false, title: 'private title', text: 'private body', token: 'secret' })]);
  assert.equal(next.unread(thread()), false);
  assert.equal([...values.values()].join('').includes('private'), false);
  assert.equal([...values.values()].join('').includes('secret'), false);
});

test('cross-tab events propagate reading and repair late lower watermarks', () => {
  const values = new Map(), a = setup({ values }), b = setup({ values });
  let notifications = 0;
  const release = a.store.subscribe(() => notifications++), releaseB = b.store.subscribe(() => {});
  a.store.observeCatalog([thread()]); b.store.observeCatalog([thread()]);
  const key = [...values.keys()][0], old = values.get(key);
  a.store.markSeen('one', content(2));
  b.change(key);
  assert.equal(b.store.unread(thread(content(2))), false);
  values.set(key, old); a.change(key);
  assert.equal(a.store.unread(thread(content(2))), false);
  assert.equal(JSON.parse(values.get(key)).seen.revision, 2, 'a stale overwrite is repaired');
  b.change(key); assert.equal(b.store.unread(thread(content(2))), false);
  assert.ok(notifications >= 2);
  release(); releaseB();
});

test('different conversations from two tabs have independent storage keys', () => {
  const values = new Map(), a = setup({ values }), b = setup({ values });
  a.store.markSeen('one', content()); b.store.markSeen('two', content(2));
  assert.equal(values.size, 2);
  const reloaded = setup({ values }).store;
  assert.equal(reloaded.unread(thread()), false);
  assert.equal(reloaded.unread(thread(content(2), { id: 'two' })), false);
});

test('unchanged polling does not notify subscribers or alter watermarks', () => {
  const { store } = setup();
  let changes = 0; const release = store.subscribe(() => changes++);
  store.observeCatalog([thread()]); store.markSeen('one', content());
  const snapshot = store.getSnapshot();
  for (let n = 0; n < 3; n++) store.observeCatalog([thread(content(), { title: 'renamed', updatedAt: n })]);
  assert.equal(store.getSnapshot(), snapshot); assert.equal(changes, 2);
  release();
});


test('changing only the authoritative source scope invalidates subscribers', () => {
  const { store } = setup();
  let changes = 0; const release = store.subscribe(() => changes++);
  store.observeCatalog([], 'source-one');
  const before = store.getSnapshot();
  store.observeCatalog([], 'source-two');
  assert.ok(store.getSnapshot() > before); assert.equal(changes, 2);
  release();
});


test('a bounded store keeps recent visible reading and re-baselines evicted content without a blue flood', () => {
  let now = 100;
  const { store, values } = setup({ maxRecords: 3, now: () => now });
  const threads = Array.from({ length: 5 }, (_, i) => thread(content(), { id: `thread-${i}` }));
  store.observeCatalog(threads, 'source-one');
  assert.equal([...values.keys()].filter(key => key.startsWith('pocket.read.v1.')).length, 3);
  assert.equal(store.unread(threads[4]), false, 'evicted content uses a baseline instead of importing old native unread again');
  now++; store.markSeen(threads[4].id, content());
  store.observeCatalog(threads, 'source-one');
  assert.equal(store.unread(threads[4]), false);
  assert.equal([...values.keys()].filter(key => key.startsWith('pocket.read.v1.')).length, 3);
  const reloaded = setup({ values, maxRecords: 3, now: () => now }).store;
  reloaded.observeCatalog(threads, 'source-one');
  assert.equal(reloaded.unread(threads[4]), false);
  const kept = threads.find(item => [...values.keys()].some(key => key.endsWith(item.id)));
  reloaded.observeCatalog([{ ...kept, pocketContent: content(2) }], 'source-one');
  assert.equal(reloaded.unread({ ...kept, pocketContent: content(2) }), true, 'tracked new content remains unread after overflow');
});


test('one tab pruning a row cannot make another tab restore it in a storage event loop', () => {
  const values = new Map(), a = setup({ values, maxRecords: 2 }), b = setup({ values, maxRecords: 2 });
  const releaseA = a.store.subscribe(() => {}), releaseB = b.store.subscribe(() => {});
  a.store.observeCatalog([thread(content(), { id: 'one' }), thread(content(), { id: 'two' })]);
  b.store.observeCatalog([thread(content(), { id: 'one' }), thread(content(), { id: 'two' })]);
  const before = new Map(values);
  a.store.markSeen('three', content());
  const deleted = [...before].find(([key]) => key.startsWith('pocket.read.v1.') && !values.has(key));
  assert.ok(deleted);
  b.change(deleted[0], { oldValue: deleted[1], newValue: null });
  assert.equal(values.has(deleted[0]), false, 'the deletion event is not a write-back instruction');
  assert.equal([...values.keys()].filter(key => key.startsWith('pocket.read.v1.')).length, 2);
  releaseA(); releaseB();
});

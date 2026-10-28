import test from 'node:test';
import assert from 'node:assert/strict';
import { createEarlierHistoryReader, earlierHistoryLimits, readEarlierHistoryPage } from '../src/earlierHistory.ts';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const message = (id, extra = {}) => ({ id, role: 'assistant', text: id, ...extra });
const page = (messages, nextCursor, kind = 'older') => ({ source: 'rollout', messages, hasMore: !!nextCursor, nextCursor, page: { kind } });
const numbered = (index, last = 100) => page([message(`m${index}-0`), message(`m${index}-1`)], index < last ? `c${index + 1}` : null, index ? 'older' : 'recent');
const turn = () => new Promise(resolve => setImmediate(resolve));

test('bootstrap is one flight and publishes recent + older atomically, stripping send identity', async () => {
  const old = deferred(), calls = [];
  const reader = createEarlierHistoryReader({ read: async (cursor, signal) => {
    calls.push({ cursor, signal });
    return cursor ? old.promise : page([message('recent', { clientMessageId: 'request-id' })], 'c1', 'recent');
  } });
  const a = reader.older(), b = reader.older();
  assert.equal(a, b);
  await turn();
  assert.equal(reader.getSnapshot().active, false);
  assert.equal(reader.getSnapshot().messages.length, 0);
  assert.deepEqual(calls.map(x => x.cursor), [null, 'c1']);
  old.resolve(page([message('old')], null)); await a;
  assert.deepEqual(reader.getSnapshot().messages.map(x => x.id), ['old', 'recent']);
  assert.equal('clientMessageId' in reader.getSnapshot().messages[1], false);
});

test('prepending remains ordered and bounded, and evicted newer pages can be recovered by original cursor', async () => {
  const calls = [];
  const reader = createEarlierHistoryReader({ read: async cursor => { calls.push(cursor); return numbered(cursor ? Number(cursor.slice(1)) : 0); } });
  await reader.older(); await reader.older(); await reader.older();
  assert.deepEqual(reader.getSnapshot().messages.map(x => x.id), ['m3-0', 'm3-1', 'm2-0', 'm2-1', 'm1-0', 'm1-1']);
  assert.equal(reader.getSnapshot().hasNewer, true);
  await reader.newer();
  assert.deepEqual(reader.getSnapshot().messages.map(x => x.id), ['m2-0', 'm2-1', 'm1-0', 'm1-1', 'm0-0', 'm0-1']);
  assert.equal(calls.filter(x => x === null).length, 1, 'recent is kept from the original snapshot, never refetched');
  assert.equal(reader.getSnapshot().hasNewer, false);
  await reader.older(); await reader.older();
  await reader.newer();
  assert.equal(calls.at(-1), 'c1', 'an older-kind newer page uses its exact original cursor');
});

test('cursor trail is bounded while older reads can continue and omitted newer content stays explicit', async () => {
  const reader = createEarlierHistoryReader({ read: async cursor => numbered(cursor ? Number(cursor.slice(1)) : 0, 200) });
  await reader.older();
  for (let i = 0; i < earlierHistoryLimits.cursorTrail + 8; i++) await reader.older();
  assert.equal(reader.getSnapshot().messages.length, earlierHistoryLimits.pages * 2);
  let count = 0;
  while (reader.getSnapshot().canLoadNewer) { await reader.newer(); count++; }
  assert.equal(count, earlierHistoryLimits.cursorTrail);
  assert.equal(reader.getSnapshot().hasNewer, true, 'a removed cursor prefix is not presented as the latest page');
});

test('overlap deduplicates exact IDs only; identical text with different IDs remains separate', async () => {
  const reader = createEarlierHistoryReader({ read: async cursor => cursor
    ? page([message('old', { text: 'same' }), message('shared', { text: 'same' })], null)
    : page([message('shared', { text: 'same' }), message('new', { text: 'same' })], 'c1', 'recent') });
  await reader.older();
  assert.deepEqual(reader.getSnapshot().messages.map(x => x.id), ['old', 'shared', 'new']);
});

test('409 preserves visible pages until an explicit recheck; a failed bootstrap stays on live content', async () => {
  let expired = false, reads = 0;
  const reader = createEarlierHistoryReader({ read: async cursor => {
    reads++;
    if (expired && cursor) throw Object.assign(new Error('expired'), { status: 409 });
    return numbered(cursor ? Number(cursor.slice(1)) : 0);
  } });
  await reader.older(); const visible = reader.getSnapshot().messages;
  expired = true; await reader.older();
  assert.equal(reader.getSnapshot().messages, visible); assert.equal(reader.getSnapshot().expired, true);
  const before = reads; await reader.older(); assert.equal(reads, before);
  expired = false; await reader.restart();
  assert.equal(reader.getSnapshot().expired, false); assert.equal(reader.getSnapshot().active, true);
  const failed = createEarlierHistoryReader({ read: async cursor => { if (cursor) throw new Error('offline'); return numbered(0); } });
  await failed.older(); assert.equal(failed.getSnapshot().active, false); assert.deepEqual(failed.getSnapshot().messages, []);
});

test('leaving or unmounting aborts and rejects late replies, including before bootstrap stage two', async () => {
  const recent = deferred(), calls = [];
  const reader = createEarlierHistoryReader({ read: (cursor, signal) => { calls.push({ cursor, signal }); return recent.promise; } });
  const pending = reader.older(); await turn(); reader.leave();
  recent.resolve(numbered(0)); await pending;
  assert.equal(calls[0].signal.aborted, true); assert.equal(calls.length, 1);
  assert.equal(reader.getSnapshot().active, false);
  const older = deferred();
  const another = createEarlierHistoryReader({ read: async cursor => cursor ? older.promise : numbered(0) });
  const next = another.older(); await turn(); another.stop(); older.resolve(numbered(1)); await next;
  assert.equal(another.getSnapshot().active, false);
});

test('a prepared response waits for a safe visible anchor and applies without refetching', async () => {
  let allow = false, calls = 0;
  const reader = createEarlierHistoryReader({ read: async cursor => { calls++; return numbered(cursor ? Number(cursor.slice(1)) : 0); }, canApply: () => allow });
  await reader.older(); assert.equal(reader.getSnapshot().ready, 'initial'); assert.equal(reader.getSnapshot().active, false);
  reader.applyReady(); assert.equal(calls, 2); assert.equal(reader.getSnapshot().active, false);
  allow = true; reader.applyReady(); assert.equal(reader.getSnapshot().active, true); assert.equal(calls, 2);
  allow = false; const visible = reader.getSnapshot().messages; await reader.older();
  assert.equal(reader.getSnapshot().messages, visible); assert.equal(reader.getSnapshot().ready, 'older');
  allow = true; reader.applyReady(); assert.equal(calls, 3); assert.equal(reader.getSnapshot().ready, null);
});

test('malformed, oversized and non-advancing pages fail without granting a display or execution snapshot', () => {
  for (const value of [page([], 'same'), page(Array.from({ length: 81 }, (_, i) => message(String(i))), null),
    page([message('big', { text: 'x'.repeat(24001) })], null), { ...numbered(1), source: 'desktop' }]) {
    assert.throws(() => readEarlierHistoryPage(value, 'same'));
  }
  const data = readEarlierHistoryPage({ ...numbered(0), canSend: true, outbox: [], pocketContent: { known: true } }, null);
  assert.equal('canSend' in data, false); assert.equal('outbox' in data, false); assert.equal('pocketContent' in data, false);
});

test('an empty recent page keeps the live conversation available', async () => {
  let calls = 0;
  const reader = createEarlierHistoryReader({ read: async () => { calls++; return page([], null, 'recent'); } });
  await reader.older();
  assert.equal(reader.getSnapshot().active, false);
  assert.equal(reader.getSnapshot().messages.length, 0);
  assert.equal(reader.getSnapshot().error, '暂未找到更早消息。');
  assert.equal(calls, 1);
});

test('a complete 55-message page still exposes older content missing from a 12-message live tail', async () => {
  const persisted = Array.from({ length: 55 }, (_, index) => message(`rollout-${index}`, { text: `message-${index}` }));
  const liveTail = persisted.slice(-12).map(item => ({ ...item, id: item.id.replace('rollout-', 'native-') }));
  let calls = 0;
  const reader = createEarlierHistoryReader({ read: async before => {
    calls++; assert.equal(before, null);
    return page(persisted, null, 'recent');
  } });
  await reader.older();
  assert.equal(reader.getSnapshot().active, true);
  assert.equal(reader.getSnapshot().messages.length, 55);
  assert.equal(reader.getSnapshot().messages.length - liveTail.length, 43);
  assert.deepEqual(reader.getSnapshot().messages.map(item => item.id), persisted.map(item => item.id));
  assert.equal(reader.getSnapshot().hasOlder, false);
  assert.equal(reader.getSnapshot().hasNewer, false);
  assert.equal(calls, 1, 'a complete first page needs no older-page request');
});

test('a finite deadline releases loading, aborts the read and ignores its late body', async () => {
  const pending = deferred(); let signal;
  const reader = createEarlierHistoryReader({ timeoutMs: 10, read: (_cursor, current) => { signal = current; return pending.promise; } });
  const request = reader.older(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(signal.aborted, true); assert.equal(reader.getSnapshot().loading, false);
  assert.match(reader.getSnapshot().error, /读取较慢/);
  pending.resolve(numbered(0)); await request;
  assert.equal(reader.getSnapshot().active, false);
});

test('resource limit errors explain the unavailable history without dropping already read pages', async () => {
  let limited = false;
  const reader = createEarlierHistoryReader({ read: async cursor => {
    if (limited) throw Object.assign(new Error('too large'), { status: 413 });
    return numbered(cursor ? Number(cursor.slice(1)) : 0);
  } });
  await reader.older(); const before = reader.getSnapshot().messages;
  limited = true; await reader.older();
  assert.equal(reader.getSnapshot().messages, before);
  assert.equal(reader.getSnapshot().error, '这份历史较大，暂时无法继续加载。');
});

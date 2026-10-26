import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTimeline } from '../src/queryTimeline.ts';
import { createSubmittedQueryStore, submittedOutbox, visibleSubmittedQueries } from '../src/submittedQueries.ts';

const query = { threadId: 'thread', requestId: 'request', text: 'A query', createdAt: 100, status: 'submitting' };
const queued = { id: query.requestId, text: query.text, createdAt: 100, revision: 0, status: 'queued' };
const echo = { id: 'native', clientMessageId: 'request', text: query.text, role: 'user', timestamp: 200 };
function view(store, messages = [], queue = []) {
  const entries = store.getThread('thread'), outbox = submittedOutbox(entries, messages, queue);
  return queryTimeline(messages, entries, visibleSubmittedQueries(entries, messages, outbox), outbox);
}

test('one request owns the same row through submitting, queue, missing queue, acceptance and native echo', () => {
  const store = createSubmittedQueryStore(); store.seed(query);
  assert.equal(view(store).tail[0].requestId, 'request');
  store.observeQueue('thread', [queued]);
  assert.equal(view(store, [], [queued]).tail[0].requestId, 'request');
  assert.equal(view(store).tail[0].requestId, 'request', 'missing queue is still the same local row');
  store.receipt('thread', { requestId: 'request', status: 'accepted' });
  const result = view(store, [echo], [queued]);
  assert.equal(result.tail.length, 0);
  assert.equal(result.byMessage.get('native').requestId, 'request');
  assert.equal(result.byMessage.get('native').hasControls, false);
});

test('an early exact echo shares the row but does not confirm unknown delivery or remove its controls', () => {
  const store = createSubmittedQueryStore(); store.seed({ ...query, status: 'unknown' });
  const result = view(store, [echo]);
  assert.equal(result.tail.length, 0);
  assert.equal(result.byMessage.get('native').state, 'unknown');
  assert.equal(result.byMessage.get('native').hasControls, true);
  assert.equal(store.getThread('thread')[0].status, 'unknown');
  assert.ok(store.reloadBlocker());
});

test('exact identity keeps the full original query and attachments while native history is incomplete', () => {
  const attachment = { id: 'file', name: 'note.txt', kind: 'file', size: 2, mimeType: 'text/plain' };
  const entry = { ...query, status: 'accepted', attachments: [attachment] };
  for (const message of [{ ...echo, text: 'A', truncated: true }, { ...echo, text: 'different' }, echo]) {
    const result = queryTimeline([message], [entry], [entry], []);
    const row = result.byMessage.get('native');
    assert.equal(result.tail.length, 0); assert.equal(row.message.text, query.text);
    assert.deepEqual(row.message.attachments, [attachment]);
    assert.equal(!!row.message.truncated, false); assert.equal(row.hasControls, true);
  }
});

test('same text with another request or no proven identity never consumes a local query', () => {
  const store = createSubmittedQueryStore(); store.seed(query);
  for (const message of [{ ...echo, clientMessageId: 'another' }, { ...echo, clientMessageId: undefined }]) {
    const result = view(store, [message]);
    assert.equal(result.tail.length, 1);
    assert.equal(result.tail[0].requestId, 'request');
  }
});

test('two identical queued queries retain distinct rows in their original creation order', () => {
  const entries = [query, { ...query, requestId: 'second', createdAt: 101 }];
  const result = queryTimeline([], entries, entries, []);
  assert.deepEqual(result.tail.map(row => row.requestId), ['request', 'second']);
});

test('a queue disappearing before echo never reorders messages when client and server clocks differ', () => {
  const first = { ...query, createdAt: 510 }, second = { ...query, requestId: 'second', createdAt: 600 };
  const queue = [{ ...queued, createdAt: 10 }, { ...queued, id: 'second', createdAt: 100 }];
  const before = queryTimeline([], [first, second], [], queue);
  const accepted = { ...first, status: 'accepted' };
  const after = queryTimeline([], [accepted, second], [accepted], queue.slice(1));
  assert.deepEqual(before.tail.map(row => row.requestId), ['request', 'second']);
  assert.deepEqual(after.tail.map(row => row.requestId), ['request', 'second']);
  assert.equal(after.tail[0].message.timestamp, before.tail[0].message.timestamp);
});

test('two native items with the same exact request id share the first slot and complete content', () => {
  const entry = { ...query, status: 'accepted' };
  const pendingEcho = { ...echo, id: 'pending', text: 'A', truncated: true };
  const result = queryTimeline([pendingEcho, echo], [entry], [], []);
  assert.equal(result.byMessage.size, 1);
  assert.equal(result.byMessage.get('pending').message.text, query.text);
  assert.equal(result.byMessage.get('pending').requestId, 'request');
  assert.deepEqual([...result.hiddenMessages], ['native']);
});

test('a bounded identity wait keeps the local row before a fast reply without claiming the source message', () => {
  const store = createSubmittedQueryStore(); store.seed({ ...query, status: 'unknown' });
  const raw = { id: 'rollout', role: 'user', text: query.text };
  const reply = { id: 'reply', role: 'assistant', text: 'Response' };
  const entries = store.getThread('thread');
  const result = queryTimeline([raw, reply], entries, entries, [], new Set(['rollout']));
  assert.equal(result.tail.length, 0);
  assert.equal(result.byMessage.get('rollout').requestId, 'request');
  assert.equal(result.byMessage.get('rollout').message.id, 'submitted:request');
  assert.equal(raw.clientMessageId, undefined);
  assert.equal(store.getThread('thread')[0].status, 'unknown');
  assert.ok(store.reloadBlocker());
  const expired = queryTimeline([raw, reply], entries, entries, []);
  assert.equal(expired.byMessage.has('rollout'), false);
  assert.equal(expired.hiddenMessages.has('rollout'), false);
  assert.equal(expired.tail.length, 1, 'ambiguous source record and local query are separate on fallback');
});

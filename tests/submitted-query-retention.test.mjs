import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeSubmittedEcho, createSubmittedQueryStore, submittedOutbox, submittedQueryTextLimits,
  visibleSubmittedQueries, withSubmittedAttachments,
} from '../src/submittedQueries.ts';
import { queryTimeline } from '../src/queryTimeline.ts';

const seed = (store, requestId, { threadId = 'thread', text = `Query ${requestId}`, status = 'accepted', ...rest } = {}) => {
  store.seed({ threadId, requestId, text, status, ...rest });
  return { id: `message-${requestId}`, role: 'user', clientMessageId: requestId, text,
    ...(rest.attachments ? { attachments: rest.attachments } : {}) };
};
const complete = (store, requestId, options = {}) => {
  const message = seed(store, requestId, options);
  store.observeMessages(options.threadId ?? 'thread', [message]);
  return message;
};
const laterCompletions = store => {
  for (let i = 0; i < 21; i++) complete(store, `later-${i}`, { threadId: 'later' });
};

test('300 complete long queries release old bodies within one app-wide UTF-16 budget', () => {
  const store = createSubmittedQueryStore();
  for (let i = 0; i < 300; i++) complete(store, `query-${i}`, {
    threadId: `thread-${i % 4}`, text: String(i).padStart(6, '0') + 'x'.repeat(15994),
  });
  const entries = [0, 1, 2, 3].flatMap(i => store.getThread(`thread-${i}`));
  const retained = entries.filter(entry => !entry.bodyReleased);
  assert.equal(entries.length, 300, 'identity tombstones are not evicted with text');
  assert.equal(entries.filter(entry => entry.echoed).length, 300);
  assert.equal(retained.length, 8);
  assert.equal(entries.reduce((bytes, entry) => bytes + entry.text.length * 2, 0), 256000);
  assert.ok(retained.length <= submittedQueryTextLimits.entries);
  assert.ok(entries.reduce((bytes, entry) => bytes + entry.text.length * 2, 0) <= submittedQueryTextLimits.bytes);
  assert.deepEqual(retained.map(entry => Number(entry.requestId.slice(6))).sort((a, b) => a - b),
    Array.from({ length: 8 }, (_, i) => i + 292));
  assert.equal(visibleSubmittedQueries(entries, [], []).length, 0);
  assert.equal(store.reloadBlocker(), null);
});

test('the count budget follows completion order across threads, not creation time or access', () => {
  const store = createSubmittedQueryStore(), messages = [];
  for (let i = 0; i < 21; i++) messages.push(seed(store, `query-${i}`, { threadId: `thread-${i % 2}`, createdAt: i }));
  for (let i = 20; i >= 0; i--) store.observeMessages(`thread-${i % 2}`, [messages[i]]);
  const entries = [0, 1].flatMap(i => store.getThread(`thread-${i}`));
  assert.equal(entries.find(entry => entry.requestId === 'query-20').bodyReleased, true);
  assert.equal(entries.filter(entry => !entry.bodyReleased).length, 20);
  for (let i = 0; i < 30; i++) store.getThread('thread-0');
  complete(store, 'newest');
  assert.equal(store.getThread('thread-1').find(entry => entry.requestId === 'query-19').bodyReleased, true);
});

test('all overlapping POST owners keep a completed body until the last owner finishes', () => {
  const store = createSubmittedQueryStore();
  const message = seed(store, 'held', { text: 'Preserve the in-flight body' });
  const finishFirst = store.beginPost('thread', 'held'), finishLast = store.beginPost('thread', 'held');
  store.observeMessages('thread', [message]);
  laterCompletions(store);
  assert.equal(store.getThread('thread')[0].text, message.text);
  let updates = 0; const unsubscribe = store.subscribe(() => { updates++; });
  finishFirst(); finishFirst();
  assert.equal(store.getThread('thread')[0].bodyReleased, undefined);
  assert.equal(updates, 0);
  finishLast();
  assert.equal(store.getThread('thread')[0].bodyReleased, true);
  assert.equal(store.getThread('thread')[0].text, '');
  assert.equal(updates, 1);
  finishLast(); assert.equal(updates, 1);
  unsubscribe();
});

test('unknown, pending, incomplete and merely cancelled queries keep their complete text', () => {
  const store = createSubmittedQueryStore();
  for (const status of ['unknown', 'pending', 'queued', 'editing', 'submitting', 'connecting', 'cancelled']) {
    const message = seed(store, status, { status, text: status + 'x'.repeat(16000) });
    store.observeMessages('thread', [message]);
  }
  const truncated = seed(store, 'truncated', { text: 'Must remain complete' });
  store.observeMessages('thread', [{ ...truncated, truncated: true }]);
  const different = seed(store, 'different', { text: 'Never equate different requests' });
  store.observeMessages('thread', [{ ...different, clientMessageId: 'someone-else' }]);
  laterCompletions(store);
  assert.equal(store.getThread('thread').every(entry => !!entry.text && !entry.bodyReleased), true);
  assert.ok(store.reloadBlocker());
});

test('a dismissed tombstone cannot refill from stale queue, seed, or unresolved receipts', () => {
  const store = createSubmittedQueryStore();
  const queued = { id: 'dismissed', text: 'A failed query', status: 'queued', revision: 3, createdAt: 1 };
  store.observeQueue('thread', [queued]);
  store.receipt('thread', { requestId: 'dismissed', status: 'rejected' });
  store.dismiss('thread', 'dismissed');
  laterCompletions(store);
  const tombstone = store.getThread('thread')[0];
  assert.equal(tombstone.bodyReleased, true);
  const late = { ...queued, revision: 9, text: 'x'.repeat(16000) };
  store.observeQueue('thread', [late]);
  seed(store, 'dismissed', { status: 'submitting', text: late.text });
  for (const status of ['pending', 'queued', 'unknown']) store.receipt('thread', { requestId: 'dismissed', status });
  const finishLatePost = store.beginPost('thread', 'dismissed');
  store.receipt('thread', { requestId: 'dismissed', status: 'not_found' });
  finishLatePost();
  assert.equal(store.getThread('thread')[0], tombstone);
  assert.deepEqual(submittedOutbox(store.getThread('thread'), [], [late]), []);
  store.receipt('thread', { requestId: 'dismissed', status: 'accepted' });
  const accepted = store.getThread('thread')[0];
  assert.equal(accepted.status, 'accepted', 'an actual receipt may still report late acceptance');
  assert.equal(accepted.text, ''); assert.equal(accepted.bodyReleased, true); assert.equal(accepted.dismissed, true);
  assert.equal(accepted.echoed, undefined);
  const emptyMessage = { id: 'unproven', role: 'user', clientMessageId: 'dismissed', text: '' };
  assert.equal(completeSubmittedEcho(accepted, [emptyMessage]), false);
  assert.equal(visibleSubmittedQueries([accepted], [], []).length, 0);
});

test('released echoes preserve attachment display and a single timeline row', () => {
  const store = createSubmittedQueryStore();
  const attachment = { id: 'file-one', name: 'note.md', size: 12, mime: 'text/markdown', kind: 'file',
    url: '/api/tasks/thread/attachments/file-one', sha256: 'a'.repeat(64) };
  const message = complete(store, 'with-file', { text: 'Read this file', attachments: [attachment] });
  laterCompletions(store);
  let entries = store.getThread('thread');
  assert.equal(entries[0].bodyReleased, true);
  assert.equal(entries[0].echoed, true);
  assert.deepEqual(entries[0].attachments, [attachment]);
  seed(store, 'with-file', { text: 'x'.repeat(16000), status: 'queued' });
  const queue = [{ id: 'with-file', text: 'An old queue snapshot', status: 'queued', revision: 90, createdAt: 0 }];
  store.observeQueue('thread', queue); entries = store.getThread('thread');
  assert.equal(entries[0].text, '');
  const messages = withSubmittedAttachments([{ ...message, attachments: undefined }], entries);
  const outbox = submittedOutbox(entries, messages, queue);
  const timeline = queryTimeline(messages, entries, visibleSubmittedQueries(entries, messages, outbox), outbox);
  assert.deepEqual(messages[0].attachments, [attachment]);
  assert.equal(timeline.tail.length, 0); assert.equal(timeline.byMessage.size, 1);
  assert.equal(timeline.byMessage.get(message.id).message.text, message.text);
  assert.equal(timeline.byMessage.get(message.id).hasControls, false);
});

test('clearing the store also releases its completion order and old POST cleanup ownership', () => {
  const store = createSubmittedQueryStore();
  const message = seed(store, 'same-id');
  const oldFinish = store.beginPost('thread', 'same-id');
  store.observeMessages('thread', [message]);
  store.clear();
  seed(store, 'same-id', { status: 'unknown', text: 'New session body' });
  oldFinish();
  assert.equal(store.getThread('thread')[0].text, 'New session body');
  assert.equal(store.getThread('thread')[0].bodyReleased, undefined);
  assert.ok(store.reloadBlocker());
});

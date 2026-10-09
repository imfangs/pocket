import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmittedQueryStore, seedSubmittedQuery, visibleSubmittedQueries, submittedOutbox, submittedQueryLabel, withSubmittedQueryPost } from '../src/submittedQueries.ts';

const seed = (store, status = 'submitting', text = 'Original submitted query', requestId = 'query') =>
  seedSubmittedQuery(store, { threadId: 'thread', requestId, text, status, createdAt: 1 });
const queued = (status = 'queued', revision = 0, text = 'Original submitted query') => ({ id: 'query', text, status, revision, createdAt: 1 });
const echo = (overrides = {}) => ({ id: 'native', role: 'user', clientMessageId: 'query', text: 'Original submitted query', ...overrides });
const cards = (store, messages = [], outbox = []) => visibleSubmittedQueries(store.getThread('thread'), messages, outbox);

test('submission captures text independently of every later draft, including identical new drafts', () => {
  const store = createSubmittedQueryStore();
  const draft = { text: 'Original submitted query' };
  seed(store, 'submitting', draft.text);
  draft.text = 'The next draft';
  seed(store, 'pending', draft.text);
  assert.equal(store.getThread('thread')[0].text, 'Original submitted query');
  store.receipt('thread', { requestId: 'query', status: 'accepted' });
  assert.equal(cards(store)[0].text, 'Original submitted query');
  assert.equal(draft.text, 'The next draft');
  assert.ok(Object.isFrozen(cards(store)[0]));
});

test('queued handoff deduplicates while retaining a fallback when the outbox disappears before echo', () => {
  const store = createSubmittedQueryStore(); seed(store);
  store.receipt('thread', { requestId: 'query', status: 'queued' });
  assert.equal(cards(store).length, 1, 'queue response before next history must keep the text visible');
  store.observeQueue('thread', [queued()]);
  assert.equal(cards(store, [], [queued()]).length, 0, 'the real outbox owns the one visible copy');
  store.observeQueue('thread', []);
  assert.equal(cards(store)[0].status, 'queued', 'absence does not claim acceptance');
  store.receipt('thread', { requestId: 'query', status: 'unknown' });
  assert.equal(cards(store)[0].status, 'unknown');
  assert.ok(store.reloadBlocker(), 'an empty next draft must not release unknown submitted text');
});

test('accepted text remains until an exact rendered user echo, never similar text or assistant IDs', () => {
  const store = createSubmittedQueryStore(); seed(store, 'accepted');
  for (const message of [echo({ clientMessageId: undefined }), echo({ clientMessageId: 'other' }), echo({ role: 'assistant' })]) {
    store.observeMessages('thread', [message]);
    assert.equal(cards(store, [message]).length, 1);
  }
  assert.equal(cards(store, [echo()]).length, 0);
  store.observeMessages('thread', [echo()]);
  assert.equal(cards(store).length, 0, 'later stale/short history cannot resurrect a retired card');
  assert.equal(store.reloadBlocker(), null);
});

test('native acceptance before a late pending or queued response cannot regress or resurrect text', () => {
  const store = createSubmittedQueryStore(); seed(store);
  store.receipt('thread', { requestId: 'query', status: 'accepted' });
  for (const status of ['pending', 'queued', 'unknown', 'rejected', 'not_found']) store.receipt('thread', { requestId: 'query', status });
  store.observeQueue('thread', [queued()]);
  assert.equal(cards(store)[0].status, 'accepted');
  store.observeMessages('thread', [echo()]);
  seed(store, 'queued', 'Unrelated later input');
  assert.equal(cards(store).length, 0);
  assert.equal(store.getThread('thread')[0].text, 'Original submitted query');
});

test('saved queue revisions survive a stale read, then provide the exact accepted fallback', () => {
  const store = createSubmittedQueryStore(); seed(store, 'queued');
  store.observeQueue('thread', [queued()]);
  const first = store.getThread('thread')[0];
  store.observeQueue('thread', [queued('editing', 1)]);
  store.observeQueue('thread', [queued('queued', 2, 'Saved edited query')]);
  store.observeQueue('thread', [queued('queued', 0)]);
  seed(store, 'queued', 'Stale clipboard original');
  assert.equal(store.getThread('thread')[0].text, 'Saved edited query');
  assert.equal(first.text, 'Original submitted query', 'older snapshots are immutable');
  store.receipt('thread', { requestId: 'query', status: 'accepted' });
  store.observeQueue('thread', []);
  assert.equal(cards(store)[0].text, 'Saved edited query');
});

test('pending and unknown queue states are not reopened by an older queued snapshot', () => {
  const store = createSubmittedQueryStore(); store.observeQueue('thread', [queued()]);
  for (const status of ['pending', 'unknown']) {
    store.receipt('thread', { requestId: 'query', status });
    store.observeQueue('thread', [queued()]);
    assert.equal(store.getThread('thread')[0].status, status);
    assert.equal(submittedOutbox(store.getThread('thread'), [], [queued()])[0].status, status);
  }
});

test('acceptance arriving before a saved edit response keeps the accepted text at the newer revision', () => {
  const store = createSubmittedQueryStore(); store.observeQueue('thread', [queued()]);
  store.receipt('thread', { requestId: 'query', status: 'accepted' });
  store.observeQueue('thread', [queued('queued', 2, 'The saved revision that was sent')]);
  store.observeQueue('thread', [queued()]);
  assert.equal(cards(store)[0].status, 'accepted');
  assert.equal(cards(store)[0].text, 'The saved revision that was sent');
  assert.equal(submittedOutbox(store.getThread('thread'), [], [queued()])[0].text, 'The saved revision that was sent');
});

test('accepted or cancelled outbox rows cannot show stale blue mutable controls or duplicate an echo', () => {
  const store = createSubmittedQueryStore(); store.observeQueue('thread', [queued()]);
  store.receipt('thread', { requestId: 'query', status: 'accepted' });
  assert.equal(submittedOutbox(store.getThread('thread'), [], [queued()])[0].status, 'accepted');
  assert.equal(submittedOutbox(store.getThread('thread'), [echo()], [queued()]).length, 0);
  const cancelled = createSubmittedQueryStore(); cancelled.observeQueue('thread', [queued()]);
  cancelled.receipt('thread', { requestId: 'query', status: 'cancelled' });
  cancelled.dismiss('thread', 'query');
  assert.equal(submittedOutbox(cancelled.getThread('thread'), [], [queued()]).length, 0);
  assert.equal(cards(cancelled).length, 0);
  cancelled.observeQueue('thread', [queued()]);
  assert.equal(cards(cancelled).length, 0);
});

test('quick-create seeds before first render and separate requests cannot overwrite each other', () => {
  const store = createSubmittedQueryStore();
  seed(store, 'not_queued', 'Clipboard query', 'first-message-id');
  assert.equal(store.getThread('thread')[0].text, 'Clipboard query');
  assert.equal(submittedQueryLabel(store.getThread('thread')[0]), '正在准备首条消息');
  store.receipt('thread', { requestId: 'creation-id', status: 'accepted' });
  assert.equal(store.getThread('thread')[0].status, 'not_queued');
  store.receipt('thread', { requestId: 'first-message-id', status: 'queued' });
  seed(store, 'submitting', 'Second independent query', 'second-id');
  assert.equal(cards(store).length, 2);
  assert.equal(cards(store)[0].status, 'queued');
  store.receipt('other-thread', { requestId: 'first-message-id', status: 'accepted' });
  assert.equal(cards(store)[0].status, 'queued');
});

test('external-store snapshots are stable until a real change and protected entries survive view subscriptions', () => {
  const store = createSubmittedQueryStore(); let updates = 0;
  const empty = store.getThread('thread'); assert.equal(store.getThread('thread'), empty);
  const unsubscribe = store.subscribe(() => { updates++; });
  seed(store, 'unknown'); const snapshot = store.getThread('thread');
  seed(store, 'unknown'); assert.equal(store.getThread('thread'), snapshot);
  assert.equal(updates, 1); unsubscribe();
  store.receipt('thread', { requestId: 'query', status: 'accepted' });
  assert.equal(cards(store).length, 1); assert.ok(store.reloadBlocker());
  assert.equal(updates, 1);
  store.clear(); assert.equal(store.getThread('thread').length, 0); assert.equal(store.reloadBlocker(), null);
});

test('a truncated or incomplete matching echo cannot retire the full accepted query', () => {
  for (const message of [echo({ text: 'Original', truncated: true }), echo({ text: 'Original' }), echo({ truncated: true })]) {
    const store = createSubmittedQueryStore(); seed(store, 'accepted');
    store.observeMessages('thread', [message]);
    assert.equal(cards(store, [message]).length, 1);
    assert.equal(submittedOutbox(store.getThread('thread'), [message], [queued()]).length, 1);
    assert.ok(store.reloadBlocker());
  }
});

test('complete rollout text cannot hide an unknown receipt, its queue controls or reload protection', () => {
  const store = createSubmittedQueryStore(); store.observeQueue('thread', [queued('unknown')]);
  store.observeMessages('thread', [echo()]);
  assert.equal(store.getThread('thread')[0].status, 'unknown');
  assert.equal(submittedOutbox(store.getThread('thread'), [echo()], [queued('unknown')]).length, 1);
  assert.equal(cards(store, [echo()]).length, 1, 'if the unknown queue disappears, a checkable receipt must still remain');
  assert.ok(store.reloadBlocker());
  store.receipt('thread', { requestId: 'query', status: 'accepted' });
  store.observeMessages('thread', [echo()]);
  assert.equal(cards(store).length, 0);
  assert.equal(store.reloadBlocker(), null);
});

test('every not_found stays uncertain while the original POST is in flight across repeated checks', () => {
  const store = createSubmittedQueryStore(); seed(store, 'submitting');
  const finishPost = store.beginPost('thread', 'query');
  store.receipt('thread', { requestId: 'query', status: 'unknown' });
  for (let n = 0; n < 3; n++) {
    store.receipt('thread', { requestId: 'query', status: 'not_found' });
    assert.equal(cards(store)[0].status, 'unknown');
    store.dismiss('thread', 'query');
    assert.equal(cards(store).length, 1);
    assert.ok(store.reloadBlocker());
  }
  store.receipt('thread', { requestId: 'query', status: 'accepted' });
  finishPost();
  assert.equal(cards(store)[0].status, 'accepted');
});

test('a same-revision pending to queued rollback requests a fresh receipt and then restores queued controls', () => {
  const store = createSubmittedQueryStore(); store.observeQueue('thread', [queued()]);
  store.receipt('thread', { requestId: 'query', status: 'pending' });
  const checkIds = store.observeQueue('thread', [{ ...queued(), code: 'thread_active' }]);
  for (const requestId of checkIds ?? []) store.receipt('thread', { requestId, status: 'queued', code: 'thread_active' });
  assert.equal(store.getThread('thread')[0].status, 'queued');
  assert.deepEqual(checkIds, ['query']);
  assert.equal(submittedOutbox(store.getThread('thread'), [], [queued()])[0].status, 'queued');
});

test('the real POST wrapper protects repeated checks until its deferred response settles', async () => {
  const store = createSubmittedQueryStore(); seed(store, 'connecting');
  let resolvePost;
  const pending = withSubmittedQueryPost(store, 'thread', 'query', () => new Promise(resolve => { resolvePost = resolve; }));
  for (let n = 0; n < 3; n++) {
    store.receipt('thread', { requestId: 'query', status: 'not_found' });
    assert.equal(cards(store)[0].status, 'unknown');
  }
  resolvePost({ requestId: 'query', status: 'accepted' });
  store.receipt('thread', await pending);
  assert.equal(cards(store)[0].status, 'accepted');
  store.observeMessages('thread', [echo()]);
  assert.equal(store.reloadBlocker(), null);
});

test('a full matching accepted echo permits only boundary whitespace normalization', () => {
  const store = createSubmittedQueryStore(); seed(store, 'accepted', '  Original submitted query\n');
  store.observeMessages('thread', [echo({ text: 'Original submitted' })]);
  assert.equal(cards(store).length, 1);
  store.observeMessages('thread', [echo()]);
  assert.equal(cards(store).length, 0);
});

test('a rejected original POST releases its in-flight guard while preserving the failed text', async () => {
  const store = createSubmittedQueryStore(); seed(store);
  await assert.rejects(withSubmittedQueryPost(store, 'thread', 'query', async () => { throw new Error('Rejected'); }), /Rejected/);
  store.receipt('thread', { requestId: 'query', status: 'not_found' });
  assert.equal(cards(store)[0].status, 'not_found');
  assert.ok(store.reloadBlocker());
  store.dismiss('thread', 'query');
  assert.equal(store.reloadBlocker(), null);
});

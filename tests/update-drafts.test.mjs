import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUpdateBlockingDraft } from '../src/updateDrafts.ts';

const task = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const key = `${task}/question/question-one`;
const cache = history => new Map([[task, { history, scrollTop: 0, nearBottom: true }]]);
const draft = (value, id = key) => new Map([[id, value]]);

test('nonempty text, whitespace, an unconfirmed request and an empty queue edit all protect input', () => {
  for (const value of [{ text: 'Unsent' }, { text: ' \n\t' }, { text: '', requestId: 'pending' }, { text: '', revision: 0 }]) {
    assert.equal(hasUpdateBlockingDraft(draft(value, task), new Map()), true);
  }
  assert.equal(hasUpdateBlockingDraft(draft({ text: '', revision: 0 }, `${task}/outbox/queued`), new Map()), true);
  assert.equal(hasUpdateBlockingDraft(draft({ text: '' }), new Map()), false);
  assert.equal(hasUpdateBlockingDraft(new Map(), new Map()), false);
});

test('only an explicit desktop list missing the exact question releases an obsolete answer', () => {
  const value = draft({ text: 'An earlier answer' });
  assert.equal(hasUpdateBlockingDraft(value, cache({ source: 'desktop', asyncQuestions: [] })), false);
  assert.equal(hasUpdateBlockingDraft(value, cache({ source: 'desktop', asyncQuestions: [{ key: 'another-question' }] })), false);
  assert.equal(hasUpdateBlockingDraft(value, cache({ source: 'desktop', asyncQuestions: [{ key: 'question-one' }] })), true);
});

test('missing, evicted, fallback, transcript-only and incomplete history keep protecting the answer', () => {
  const value = draft({ text: 'Keep this answer' });
  for (const history of [undefined, { source: 'rollout', asyncQuestions: [] }, { source: 'desktop' }, { source: 'desktop', asyncQuestions: null }, { asyncQuestions: [] }]) {
    assert.equal(hasUpdateBlockingDraft(value, cache(history)), true);
  }
  assert.equal(hasUpdateBlockingDraft(value, new Map()), true);
  assert.equal(hasUpdateBlockingDraft(value, new Map([[task, { transcript: { source: 'rollout', messages: [] }, scrollTop: 0, nearBottom: true }]])), true);
  assert.equal(hasUpdateBlockingDraft(value, new Map([[other, { history: { source: 'desktop', asyncQuestions: [] }, scrollTop: 0, nearBottom: true }]])), true);
});

test('a question removed from the current list cannot release an unconfirmed request ID', () => {
  const ended = cache({ source: 'desktop', asyncQuestions: [] });
  for (const text of ['', 'An answer awaiting its receipt']) {
    assert.equal(hasUpdateBlockingDraft(draft({ text, requestId: 'unknown-request' }), ended), true);
  }
  assert.equal(hasUpdateBlockingDraft(draft({ text: '', revision: 0 }), ended), true);
});

test('question evidence does not waive another task draft, an outbox edit or a malformed key', () => {
  const ended = cache({ source: 'desktop', asyncQuestions: [] });
  for (const id of [task, `${task}/outbox/question-one`, `${task}/question/`, `/question/question-one`]) {
    assert.equal(hasUpdateBlockingDraft(draft({ text: 'Keep' }, id), ended), true);
  }
  const mixed = new Map([[key, { text: 'Ended answer' }], [other, { text: ' \n' }]]);
  assert.equal(hasUpdateBlockingDraft(mixed, ended), true);
});

test('checking an ended answer neither deletes nor rewrites drafts or cached history', () => {
  const value = { text: 'Retain this original answer' };
  const drafts = draft(value);
  const history = { source: 'desktop', asyncQuestions: [] };
  const histories = cache(history);
  const before = { drafts: structuredClone(drafts), histories: structuredClone(histories) };
  assert.equal(hasUpdateBlockingDraft(drafts, histories), false);
  assert.deepEqual(drafts, before.drafts);
  assert.deepEqual(histories, before.histories);
  assert.equal(drafts.get(key), value);
  assert.equal(histories.get(task).history, history);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { answerMode, editAnswer, hasAnswerText, requestAnswerKey, requestAnswerValues, switchAnswerMode } from '../src/questionDrafts.ts';
import { captureDraft } from '../src/draftTransaction.ts';
import { hasUpdateBlockingDraft } from '../src/updateDrafts.ts';

test('switching between choices and a written answer preserves both texts and the active submission value', () => {
  const options = ['First choice', 'Second choice'];
  let draft = editAnswer({ text: '' }, options, options[1], 'options');
  draft = switchAnswerMode(draft, options, 'custom');
  assert.equal(draft.text, '');
  draft = editAnswer(draft, options, 'A detailed answer\nwith a second paragraph.');
  draft = switchAnswerMode(draft, options, 'options');
  assert.equal(draft.text, options[1]);
  draft = switchAnswerMode(draft, options, 'custom');
  assert.equal(draft.text, 'A detailed answer\nwith a second paragraph.');
  assert.equal(draft.optionText, options[1]);
});

test('a reopened question restores its chosen input mode and preserves legacy free-text drafts', () => {
  const options = ['Yes', 'No'];
  const drafts = new Map([['thread/question/key', switchAnswerMode({ text: 'Original free text' }, options, 'options')]]);
  const reopened = drafts.get('thread/question/key');
  assert.equal(answerMode(reopened, options), 'options');
  assert.equal(reopened.text, '');
  assert.equal(hasAnswerText(reopened), true);
  assert.equal(switchAnswerMode(reopened, options, 'custom').text, 'Original free text');
  assert.equal(answerMode({ text: 'Legacy answer' }, options), 'custom');
});

test('synchronous answers survive another view and remain scoped to the exact thread, request, and question', () => {
  const request = { key: 'request-one', questions: [{ id: 'first/part' }, { id: 'second' }] };
  const drafts = new Map([
    [requestAnswerKey('thread-a', request.key, 'first/part'), { text: 'Detailed answer\ncontinued' }],
    [requestAnswerKey('thread-a', request.key, 'second'), { text: 'Another answer' }],
    [requestAnswerKey('thread-b', request.key, 'second'), { text: 'Different task' }],
  ]);
  assert.deepEqual(requestAnswerValues(drafts, 'thread-a', request), { 'first/part': 'Detailed answer\ncontinued', second: 'Another answer' });
  assert.deepEqual(requestAnswerValues(drafts, 'thread-b', request), { 'first/part': '', second: 'Different task' });
  assert.deepEqual(requestAnswerValues(drafts, 'thread-a', { ...request, key: 'new-request' }), { 'first/part': '', second: '' });
});

test('a late accepted synchronous answer cannot clear a newer answer typed in a reopened view', () => {
  const key = requestAnswerKey('thread', 'request', 'question');
  const drafts = new Map([[key, { text: 'Submitted answer' }]]);
  const submitted = captureDraft(drafts, key);
  const newer = { text: 'Newer answer' };
  drafts.set(key, newer);
  assert.equal(submitted.clear(), false);
  assert.equal(drafts.get(key), newer);
});

test('hidden written answers block an update until the original async question is known to be gone', () => {
  const drafts = new Map([['thread/question/key', { text: '', answerMode: 'options', customText: 'Keep this written answer' }]]);
  const cache = new Map([['thread', { history: { source: 'desktop', asyncQuestions: [{ key: 'key' }] } }]]);
  assert.equal(hasUpdateBlockingDraft(drafts, cache), true);
  cache.set('thread', { history: { source: 'rollout', asyncQuestions: [] } });
  assert.equal(hasUpdateBlockingDraft(drafts, cache), true);
  cache.set('thread', { history: { source: 'desktop', asyncQuestions: [] } });
  assert.equal(hasUpdateBlockingDraft(drafts, cache), false);
});

test('synchronous answers protect updates until a fresh native request list confirms completion', () => {
  const key = requestAnswerKey('thread', 'request', 'question');
  const drafts = new Map([[key, { text: 'Keep this answer' }]]);
  const cache = new Map();
  assert.equal(hasUpdateBlockingDraft(drafts, cache), true);
  cache.set('thread', { history: { source: 'rollout', pendingRequests: [] } });
  assert.equal(hasUpdateBlockingDraft(drafts, cache), true);
  cache.set('thread', { history: { source: 'desktop', pendingRequests: [{ key: 'request', response: { status: 'unknown' } }] } });
  assert.equal(hasUpdateBlockingDraft(drafts, cache), true);
  cache.set('thread', { history: { source: 'desktop', pendingRequests: [{ key: 'request', response: { status: 'accepted' } }] } });
  assert.equal(hasUpdateBlockingDraft(drafts, cache), false);
  cache.set('thread', { history: { source: 'desktop', pendingRequests: [] } });
  assert.equal(hasUpdateBlockingDraft(drafts, cache), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { captureDraft } from '../src/draftTransaction.ts';

test('a late queue save cannot delete a newer edit in a reopened view', () => {
  const key = 'task/outbox/item';
  const drafts = new Map([[key, { text: 'Sent for saving', revision: 2 }]]);
  const save = captureDraft(drafts, key);
  const next = { text: 'Typed in the reopened view', revision: 3 };
  drafts.set(key, next);
  assert.equal(save.clear(), false);
  assert.equal(drafts.get(key), next);
});

test('a delayed rejected answer cannot overwrite the draft after a newer receipt check', () => {
  const key = 'task/question/question';
  const drafts = new Map([[key, { text: 'Original answer' }]]);
  const submission = captureDraft(drafts, key);
  submission.set({ text: 'Original answer', requestId: 'request-one' });
  const check = captureDraft(drafts, key);
  check.set({ text: 'Original answer' });
  const next = { text: 'Corrected answer' };
  drafts.set(key, next);
  assert.equal(submission.set({ text: 'Original answer' }), false);
  assert.equal(submission.clear(), false);
  assert.equal(drafts.get(key), next);
});

test('a later edit with identical text still owns its draft', () => {
  const drafts = new Map([['key', { text: 'Same content', revision: 1 }]]);
  const previous = captureDraft(drafts, 'key');
  const next = { text: 'Same content', revision: 1 };
  drafts.set('key', next);
  assert.equal(previous.clear(), false);
  assert.equal(drafts.get('key'), next);
});

test('a settled operation can clear its unchanged draft without leaving an orphan update blocker', () => {
  const drafts = new Map([['key', { text: 'Save this', revision: 1 }]]);
  const save = captureDraft(drafts, 'key');
  assert.equal(save.clear(), true);
  assert.equal(drafts.has('key'), false);
});

test('adding a submission ID retains ownership without changing another task draft', () => {
  const other = { text: 'Another task' };
  const drafts = new Map([['other', other]]);
  const submission = captureDraft(drafts, 'key');
  assert.equal(submission.set({ text: 'Answer', requestId: 'new-request' }), true);
  assert.equal(submission.current(), true);
  assert.equal(submission.clear(), true);
  assert.equal(drafts.get('other'), other);
});

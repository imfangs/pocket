import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftMap, draftThreadIds } from '../src/draftIndicators.ts';
import { captureDraft } from '../src/draftTransaction.ts';

test('draft badges belong to root threads and include hidden answer text but exclude submitted or blank values', () => {
  const drafts = new Map([
    ['main', { text: 'Main composer' }],
    ['async/question/key', { text: '', customText: 'Written answer' }],
    ['sync/request/key/question/id', { text: 'Synchronous answer' }],
    ['queue/outbox/id', { text: 'Queue edit', revision: 2 }],
    ['choice/question/key', { text: '', optionText: 'Selected choice' }],
    ['pending/question/key', { text: 'Submitted', customText: 'Other draft', requestId: 'in-flight' }],
    ['blank', { text: '\n ', customText: '  ', optionText: '\t' }],
    ['/missing-root', { text: 'Invalid owner' }],
  ]);
  assert.deepEqual(draftThreadIds(drafts), new Set(['main', 'async', 'sync', 'queue', 'choice']));
});

test('typing and changing between draft fields does not notify while a thread already has a draft', () => {
  let changes = 0;
  const drafts = createDraftMap(() => { changes++; });
  drafts.set('thread', { text: 'A' });
  for (let n = 0; n < 100; n++) drafts.set('thread', { text: `A${n}` });
  drafts.set('thread/question/key', { text: '', customText: 'Another input' });
  drafts.delete('thread');
  assert.equal(changes, 1);
  assert.deepEqual(draftThreadIds(drafts), new Set(['thread']));
  drafts.delete('thread/question/key');
  assert.equal(changes, 2);
});

test('submission and rejection update a badge only when the last unsubmitted draft changes state', () => {
  let changes = 0;
  const drafts = createDraftMap(() => { changes++; });
  drafts.set('thread/question/key', { text: '', customText: 'A preserved answer' });
  drafts.set('thread/question/key', { text: 'A preserved answer', requestId: 'request' });
  assert.equal(changes, 2);
  assert.deepEqual(draftThreadIds(drafts), new Set());
  drafts.set('thread/question/key', { text: 'A preserved answer', requestId: undefined });
  assert.equal(changes, 3);
  drafts.set('thread/question/key', { text: '  ', customText: '\n' });
  assert.equal(changes, 4);
});

test('delete and clear keep Map semantics and notify only when indicators actually disappear', () => {
  let changes = 0;
  const drafts = createDraftMap(() => { changes++; });
  drafts.set('empty', { text: ' ' });
  assert.equal(drafts.delete('missing'), false);
  assert.equal(drafts.delete('empty'), true);
  drafts.clear(); assert.equal(changes, 0);
  drafts.set('a', { text: 'A' }); drafts.set('b/request/r/question/q', { text: 'B' });
  drafts.clear();
  assert.equal(changes, 3);
  assert.equal(drafts.size, 0);
  drafts.clear(); assert.equal(changes, 3);
});

test('notifications see the updated map and draft transactions retain their exact identity ownership', () => {
  const observed = [];
  const drafts = createDraftMap(() => observed.push([...draftThreadIds(drafts)]));
  const first = { text: 'First' };
  assert.equal(drafts.set('thread', first), drafts);
  assert.ok(drafts instanceof Map);
  assert.equal(drafts.get('thread'), first);
  const old = captureDraft(drafts, 'thread');
  const newer = { text: 'First' };
  drafts.set('thread', newer);
  assert.equal(old.clear(), false);
  assert.equal(drafts.get('thread'), newer);
  const current = captureDraft(drafts, 'thread');
  assert.equal(current.clear(), true);
  assert.deepEqual(observed, [['thread'], []]);
});

test('setting a reused value object still detects a draft-state transition', () => {
  let changes = 0;
  const drafts = createDraftMap(() => { changes++; });
  const value = { text: '' };
  drafts.set('thread', value);
  value.text = 'Changed'; drafts.set('thread', value);
  assert.equal(changes, 1);
  value.text = ' '; drafts.set('thread', value);
  assert.equal(changes, 2);
});

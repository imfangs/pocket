import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmittedQueryStore, completeSubmittedEcho, submittedOutbox, visibleSubmittedQueries, withSubmittedAttachments } from '../src/submittedQueries.ts';
import { displayMessages } from '../src/transcript.ts';
const attachment = { id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', name: 'notes.txt', size: 5, mime: 'text/plain', kind: 'file', url: '/api/tasks/thread/attachments/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', sha256: 'a'.repeat(64) };
const entry = { threadId: 'thread', requestId: 'request', text: '', status: 'accepted', attachments: [attachment] };
const echo = { id: 'message', role: 'user', text: '', clientMessageId: 'request' };

test('attachment-only acceptance requires exact client ID and complete attachment identity, never an empty-text match', () => {
  assert.equal(completeSubmittedEcho(entry, [echo]), false);
  assert.equal(completeSubmittedEcho(entry, [{ ...echo, clientMessageId: 'other', attachments: [attachment] }]), false);
  assert.equal(completeSubmittedEcho(entry, [{ ...echo, attachments: [{ ...attachment, sha256: 'b'.repeat(64) }] }]), false);
  assert.equal(completeSubmittedEcho(entry, [{ ...echo, attachments: [attachment] }]), true);
});

test('known attachment metadata enriches only an exact user request echo and survives accepted-card retirement', () => {
  const store = createSubmittedQueryStore(); store.seed(entry);
  assert.equal(withSubmittedAttachments([{ ...echo, clientMessageId: 'other' }], store.getThread('thread'))[0].attachments, undefined);
  const messages = withSubmittedAttachments([echo], store.getThread('thread'));
  assert.equal(messages[0].attachments[0].id, attachment.id);
  store.observeMessages('thread', messages);
  assert.equal(visibleSubmittedQueries(store.getThread('thread'), messages, []).length, 0);
  assert.equal(withSubmittedAttachments([echo], store.getThread('thread'))[0].attachments[0].id, attachment.id);
  assert.equal(echo.attachments, undefined, 'display enrichment never mutates the source snapshot');
});

test('queued attachments remain intact through text edits, a late snapshot and the accepted fallback', () => {
  const store = createSubmittedQueryStore(); store.seed({ ...entry, status: 'queued' });
  const queued = { id: 'request', text: '', status: 'queued', revision: 0, createdAt: 1, attachments: [attachment] };
  store.observeQueue('thread', [queued]);
  store.observeQueue('thread', [{ ...queued, text: 'Edited caption', revision: 2, attachments: undefined }]);
  store.observeQueue('thread', [queued]);
  assert.equal(store.getThread('thread')[0].text, 'Edited caption');
  assert.equal(store.getThread('thread')[0].attachments[0].id, attachment.id);
  store.receipt('thread', { requestId: 'request', status: 'accepted' });
  assert.equal(submittedOutbox(store.getThread('thread'), [], [queued])[0].attachments[0].id, attachment.id);
  assert.equal(visibleSubmittedQueries(store.getThread('thread'), [], [])[0].attachments[0].id, attachment.id);
});

test('an attachment-only message is retained when transcript merging bounds the displayed history', () => {
  const user = { ...echo, turnId: 'turn', attachments: [attachment] };
  const final = { id: 'reply', role: 'assistant', phase: 'final_answer', text: 'Done', turnId: 'turn' };
  const result = displayMessages({ source: 'desktop', messages: [user], turnTiming: { turnId: 'turn', status: 'inProgress' } },
    { source: 'rollout', messages: [user, final], turnTiming: { turnId: 'turn', status: 'completed' } });
  assert.equal(result.length, 2); assert.equal(result[0].attachments[0].id, attachment.id);
});

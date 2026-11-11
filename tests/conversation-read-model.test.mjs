import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationReadModel } from '../src/conversationReadModel.ts';

const row = (id, extra = {}) => ({ id, turnId: 'turn', role: 'assistant', phase: 'final_answer', text: `Body ${id}`, ...extra });
const source = (messages, extra = {}) => ({ source: 'rollout', messages, checkedAt: 10, ...extra });
const history = (messages, extra = {}) => ({ source: 'desktop', messages, runtime: 'idle', canSend: true, hint: '', checkedAt: 10,
  turnTiming: { turnId: 'turn', status: 'completed', startedAt: 1, observedAt: 10, durationMs: 9 }, ...extra });
const content = (id, extra = {}) => ({ known: true, scope: 'scope', revision: 1, version: 'a'.repeat(64), messageId: id, ...extra });
const input = extra => ({ scope: 'ged:scope:thread', readingScope: 'scope', history: null, transcript: null,
  submitted: [], cachedPreview: null, previewAllowed: true, ...extra });

test('exact duplicate normalization is display-only and the original live receipt input remains intact', () => {
  const message = Object.freeze(row('same')), messages = Object.freeze([message, Object.freeze({ ...message })]);
  const original = JSON.stringify(messages), model = conversationReadModel(input({ history: history(messages) }));
  assert.equal(model.liveDisplay.messages.length, 2);
  assert.deepEqual(model.shownMessages, [message]);
  assert.equal(model.shownMessages[0], message);
  assert.equal(JSON.stringify(messages), original);
  for (const field of ['runtime', 'canSend', 'canStop', 'pendingRequests']) assert.equal(model[field], undefined);
});

test('same-scope rollout fallback keeps only the validated native prefix and always admits the new non-prefix final', () => {
  const prefix = row('older', { turnId: 'older' }), nativeFinal = row('final'), freshFinal = row('final', { text: 'A different complete recorded body' });
  const previous = { scope: 'ged:scope:thread', view: { messages: [prefix, nativeFinal], hasMore: false } };
  const data = input({ history: history([freshFinal], { source: 'rollout', canSend: false }) });
  const model = conversationReadModel(data, previous);
  assert.deepEqual(model.shownMessages, [prefix, freshFinal]);
  assert.equal(model.shownMessages.at(-1), freshFinal);
  assert.deepEqual(model.liveDisplay.messages, [freshFinal]);
  assert.deepEqual(conversationReadModel({ ...data, scope: 'wandou:scope:thread' }, previous).shownMessages, [freshFinal]);
});

test('an exact authenticated disk preview supplies its local read version without controls or new questions', () => {
  const answer = row('cached'), cached = source([answer], { pocketContent: content('cached'),
    runtime: 'active', canSend: true, canStop: true, asyncQuestions: [{ id: 'not-a-live-question' }] });
  const model = conversationReadModel(input({ cachedPreview: cached }));
  assert.equal(model.showingDiskPreview, true);
  assert.equal(model.pocketContent, cached.pocketContent);
  assert.deepEqual(model.liveDisplay.messages, []);
  assert.deepEqual(model.questions, []);
  assert.equal(model.questionsByMessage.size, 0);
  assert.deepEqual(model.unplacedQuestions, []);
  assert.equal(model.canSend, undefined); assert.equal(model.canStop, undefined);
});

test('cached read targets must have the exact active scope, complete text and unambiguous identity', () => {
  for (const cached of [
    source([row('cached')], { pocketContent: content('cached', { scope: 'another-scope' }) }),
    source([row('cached', { truncated: true })], { pocketContent: content('cached') }),
    source([row('cached'), row('cached', { text: 'Conflicting body' })], { pocketContent: content('cached') }),
  ]) assert.equal(conversationReadModel(input({ cachedPreview: cached })).pocketContent, null);
  assert.equal(conversationReadModel(input({ cachedPreview: source([row('cached')], { pocketContent: content('cached') }), readingScope: undefined })).pocketContent, null);
});

test('fresh source success supersedes disk preview, and a mismatched fresh body cannot borrow its read version', () => {
  const cached = source([row('cached')], { pocketContent: content('cached') });
  assert.equal(conversationReadModel(input({ cachedPreview: cached, previewAllowed: false })).showingDiskPreview, false);
  const saved = source([row('fresh')], { pocketContent: content('fresh') });
  const model = conversationReadModel(input({ cachedPreview: cached, transcript: saved, history: history([row('fresh', { text: 'Different native projection' })]) }));
  assert.equal(model.showingDiskPreview, false);
  assert.deepEqual(model.shownMessages, model.liveDisplay.messages);
  assert.equal(model.pocketContent, null);
});

test('conflicting identities remain visible but are excluded from timeline placement and relocate active questions', () => {
  const messages = [row('shared'), row('shared', { text: 'Conflict', isQuestion: true })];
  const question = { id: 'question', key: 'question-key', turnId: 'turn', sourceMessageId: 'shared', title: 'Choose', options: ['Yes'] };
  const model = conversationReadModel(input({ history: history(messages, { asyncQuestions: [question] }), transcript: source(messages, { pocketContent: content('shared') }) }));
  assert.equal(model.shownMessages.length, 2);
  assert.equal(model.ambiguousMessageIds.has('shared'), true);
  assert.deepEqual(model.timelineMessages, []);
  assert.deepEqual(model.unplacedQuestions, [question]);
  assert.equal(model.pocketContent, null);
});

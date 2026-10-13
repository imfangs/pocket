import test from 'node:test';
import assert from 'node:assert/strict';
import { checkQuestionAnswer, createQuestionPresentationStore, ignoreQuestion, questionPresentation, questionPresentationKey, questionSourceText, withQuestionAnswerPost, MAX_IGNORED_QUESTIONS } from '../src/questionPresentation.ts';

const fingerprint = 'a'.repeat(64);
function storageFixture() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

test('new questions are compact, local drafts reopen answers, and ignored drafts stay compact until reopened', () => {
  assert.equal(questionPresentation({ ignored: false }).state, 'compact');
  const draft = { text: '', customText: 'Preserved custom answer', answerMode: 'options' };
  assert.equal(questionPresentation({ ignored: false, draft }).state, 'answering');
  const ignored = questionPresentation({ ignored: true, draft });
  assert.equal(ignored.state, 'ignored'); assert.equal(ignored.hasDraft, true); assert.equal(ignored.expanded, false);
  assert.equal(questionPresentation({ ignored: false, answerOpen: true }).state, 'answering');
});

test('ignoring and reopening touch only local presentation keys and preserve the original answer draft', () => {
  const storage = storageFixture(), store = createQuestionPresentationStore(storage);
  const draft = Object.freeze({ text: 'Private answer', customText: 'Hidden private answer', optionText: 'A', answerMode: 'custom' });
  const before = JSON.stringify(draft);
  assert.equal(ignoreQuestion(store, 'thread', fingerprint, { draft }), true);
  assert.equal(store.isIgnored('thread', fingerprint), true);
  const saved = JSON.parse([...storage.values.values()][0]);
  assert.deepEqual(saved, { version: 1, ignored: [questionPresentationKey('thread', fingerprint)] });
  assert.doesNotMatch(JSON.stringify(saved), /Private answer|Hidden private answer|customText|optionText/);
  assert.equal(JSON.stringify(draft), before);
  store.setIgnored('thread', fingerprint, false);
  assert.equal(store.isIgnored('thread', fingerprint), false);
  assert.equal(JSON.stringify(draft), before);
});

test('busy and unconfirmed answers cannot be ignored even when an old ignored flag exists', () => {
  const store = createQuestionPresentationStore(storageFixture());
  for (const options of [{ busy: true }, { draft: { text: 'Waiting', requestId: 'original-request' } },
    ...['pending', 'unknown', 'accepted'].map(responseStatus => ({ responseStatus }))]) {
    assert.equal(ignoreQuestion(store, 'thread', fingerprint, options), false);
    assert.equal(store.isIgnored('thread', fingerprint), false);
    const state = questionPresentation({ ignored: true, ...options });
    assert.equal(state.state, 'pending'); assert.equal(state.expanded, true); assert.equal(state.canIgnore, false); assert.equal(state.ignored, false);
  }
});

test('ignore persists across reconstructed stores but is scoped to the exact thread and question fingerprint', () => {
  const storage = storageFixture(), first = createQuestionPresentationStore(storage);
  first.setIgnored('thread-a', fingerprint, true);
  const reopened = createQuestionPresentationStore(storage);
  assert.equal(reopened.isIgnored('thread-a', fingerprint), true);
  assert.equal(reopened.isIgnored('thread-b', fingerprint), false);
  assert.equal(reopened.isIgnored('thread-a', 'b'.repeat(64)), false);
  reopened.setIgnored('thread-a', fingerprint, false);
  assert.equal(createQuestionPresentationStore(storage).isIgnored('thread-a', fingerprint), false);
});

test('only the latest 200 ignored keys are persisted and old evictions do not change newer questions', () => {
  const storage = storageFixture(), store = createQuestionPresentationStore(storage);
  for (let n = 0; n < MAX_IGNORED_QUESTIONS + 5; n++) store.setIgnored('thread', `fingerprint-${n}`, true);
  const saved = JSON.parse([...storage.values.values()][0]);
  assert.equal(saved.ignored.length, MAX_IGNORED_QUESTIONS);
  assert.equal(store.isIgnored('thread', 'fingerprint-0'), false);
  assert.equal(store.isIgnored('thread', 'fingerprint-4'), false);
  assert.equal(store.isIgnored('thread', 'fingerprint-5'), true);
  assert.equal(createQuestionPresentationStore(storage).isIgnored('thread', 'fingerprint-204'), true);
});

test('blocked storage falls back to session memory and malformed persisted data does not break local actions', () => {
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
  const memory = createQuestionPresentationStore(unavailable);
  assert.equal(ignoreQuestion(memory, 'thread', fingerprint, {}), true);
  assert.equal(memory.isIgnored('thread', fingerprint), true);
  memory.setIgnored('thread', fingerprint, false); assert.equal(memory.isIgnored('thread', fingerprint), false);
  for (const value of ['{', 'null', '[]', '{"version":2,"ignored":[]}', '{"version":1,"ignored":["not a key",4,{}]}']) {
    const store = createQuestionPresentationStore({ getItem: () => value, setItem() {} });
    assert.equal(store.isIgnored('thread', fingerprint), false);
    assert.equal(ignoreQuestion(store, 'thread', fingerprint, {}), true);
  }
});

test('presentation subscriptions update mounted views only when the ignored value changes', () => {
  const store = createQuestionPresentationStore(storageFixture()); let changes = 0;
  const stop = store.subscribe(() => { changes++; });
  store.setIgnored('thread', fingerprint, false); assert.equal(changes, 0);
  store.setIgnored('thread', fingerprint, true); store.setIgnored('thread', fingerprint, true); assert.equal(changes, 1);
  stop(); store.setIgnored('thread', fingerprint, false); assert.equal(changes, 1);
});

test('source explanation is retained while an exactly repeated question body is not rendered twice', () => {
  const titles = ['First question?', 'Second question?'];
  assert.equal(questionSourceText(` ${titles.join('\n')} `, titles), '');
  const source = `I can continue without this answer.\n\n${titles[0]}`;
  assert.equal(questionSourceText(source, titles), source);
  assert.equal(questionSourceText(undefined, titles), '');
});

test('remounting during an answer POST cannot turn an early not_found check into permission to ignore or resend', async () => {
  const storage = storageFixture(), store = createQuestionPresentationStore(storage);
  let finishPost;
  const sending = withQuestionAnswerPost(store, 'thread', fingerprint, 'original-request', () => new Promise(resolve => { finishPost = resolve; }));
  for (let n = 0; n < 3; n++) {
    const receipt = await checkQuestionAnswer(store, 'thread', fingerprint, 'original-request', async () => ({ requestId: 'original-request', status: 'not_found' }));
    assert.equal(receipt.status, 'unknown');
    assert.equal(ignoreQuestion(store, 'thread', fingerprint, {}), false, 'even a remounted view missing the old busy ref must respect the shared POST');
  }
  assert.equal(storage.values.size, 0, 'in-flight request tracking is never persisted');
  finishPost({ status: 'accepted' }); await sending;
  assert.equal(store.answerRequestId('thread', fingerprint), undefined);
});

test('a check started during POST remains uncertain if the POST finishes before its stale not_found response', async () => {
  const store = createQuestionPresentationStore(storageFixture());
  let finishPost, finishRead;
  const sending = withQuestionAnswerPost(store, 'thread', fingerprint, 'request', () => new Promise(resolve => { finishPost = resolve; }));
  const checking = checkQuestionAnswer(store, 'thread', fingerprint, 'request', () => new Promise(resolve => { finishRead = resolve; }));
  finishPost({ status: 'accepted' }); await sending;
  finishRead({ status: 'not_found', requestId: 'request' });
  assert.equal((await checking).status, 'unknown');
});

test('answer POST tracking is scoped by thread and fingerprint and is released on rejection', async () => {
  const store = createQuestionPresentationStore(storageFixture());
  let rejectPost;
  const sending = withQuestionAnswerPost(store, 'thread-a', fingerprint, 'request', () => new Promise((_resolve, reject) => { rejectPost = reject; }));
  const rejected = assert.rejects(sending, /connection failed/);
  assert.equal(store.answerRequestId('thread-a', fingerprint), 'request');
  assert.equal(store.answerRequestId('thread-b', fingerprint), undefined);
  assert.equal(store.answerRequestId('thread-a', 'b'.repeat(64)), undefined);
  assert.equal(ignoreQuestion(store, 'thread-b', fingerprint, {}), true);
  rejectPost(new Error('connection failed')); await rejected;
  assert.equal(store.answerRequestId('thread-a', fingerprint), undefined);
});

test('a receipt for a different request cannot clear the original answer', async () => {
  const store = createQuestionPresentationStore(storageFixture());
  await assert.rejects(checkQuestionAnswer(store, 'thread', fingerprint, 'original', async () => ({ requestId: 'another', status: 'accepted' })), /不匹配/);
});

test('native title-plus-bullet options are recognized as generated question text, while context and images remain', () => {
  const titles=['选择第一步','是否继续'],options=[['先体验','先研究'],['继续','稍后']];
  const source=titles.map((title,i)=>[title,...options[i].map(option=>`- ${option}`)].join('\n')).join('\n\n');
  assert.equal(questionSourceText(source,titles,false,options),'');
  const context='先看这段背景说明。\n\n'+source;
  assert.equal(questionSourceText(context,titles,false,options),context);
  assert.equal(questionSourceText(source,titles,true,options),source);
  assert.equal(questionSourceText('代码里也可能出现 - 先体验',titles,false,options),'代码里也可能出现 - 先体验');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionPresentationStore, discardQuestionDraft, questionComposerPending } from '../src/questionPresentation.ts';
import { hasUpdateBlockingDraft } from '../src/updateDrafts.ts';

const makeStore = () => createQuestionPresentationStore({ getItem: () => null, setItem() {} });
const fingerprint = 'a'.repeat(64);
const key = `thread/question/${fingerprint}`;
const question = { key: fingerprint };

test('discard clears both answer modes and hidden update protection without changing ignored state or another question', () => {
  const store = makeStore(); store.setIgnored('thread', fingerprint, true);
  const draft = { text: '', answerMode: 'custom', optionText: 'A', customText: '' };
  const unrelated = { text: 'Keep another answer' };
  const drafts = new Map([[key, draft], ['other/question/one', unrelated]]);
  const history = new Map([['thread', { history: { source: 'desktop', asyncQuestions: [question] } }]]);
  assert.equal(hasUpdateBlockingDraft(new Map([[key, draft]]), history), true);
  let notifications = 0; const unsubscribe = store.subscribe(() => notifications++);
  assert.equal(discardQuestionDraft(store, 'thread', fingerprint, drafts), true);
  assert.equal(store.isIgnored('thread', fingerprint), true);
  assert.equal(drafts.has(key), false);
  assert.equal(drafts.get('other/question/one'), unrelated);
  assert.equal(hasUpdateBlockingDraft(new Map(), history), false);
  assert.equal(notifications, 1);
  unsubscribe();
});

test('busy, receipt-bound and shared in-flight answer drafts cannot be discarded', () => {
  for (const options of [{ busy: true }, ...['pending', 'unknown', 'accepted'].map(responseStatus => ({ responseStatus })), { bound: true }, { activePost: true }]) {
    const store = makeStore();
    const draft = { text: 'Keep', customText: 'Keep hidden', ...(options.bound ? { requestId: 'original' } : {}) };
    const drafts = new Map([[key, draft]]);
    const finish = options.activePost ? store.beginAnswerPost('thread', fingerprint, 'original') : () => {};
    assert.equal(discardQuestionDraft(store, 'thread', fingerprint, drafts, options), false, JSON.stringify(options));
    assert.equal(drafts.get(key), draft);
    finish();
  }
});

test('an ignored empty question releases the composer while hidden drafts and unknown answers still hold it', () => {
  const store = makeStore(), drafts = new Map();
  assert.equal(questionComposerPending(store, 'thread', [question], drafts), true);
  store.setIgnored('thread', fingerprint, true);
  assert.equal(questionComposerPending(store, 'thread', [question], drafts), false);
  drafts.set(key, { text: '', optionText: 'A' });
  assert.equal(questionComposerPending(store, 'thread', [question], drafts), true);
  discardQuestionDraft(store, 'thread', fingerprint, drafts);
  assert.equal(questionComposerPending(store, 'thread', [question], drafts), false);
  assert.equal(questionComposerPending(store, 'thread', [{ ...question, response: { status: 'unknown' } }], drafts), true);
  const finish = store.beginAnswerPost('thread', fingerprint, 'original');
  assert.equal(questionComposerPending(store, 'thread', [question], drafts), true);
  finish();
  drafts.set('other/question/one', { text: 'Another task' });
  assert.equal(questionComposerPending(store, 'thread', [question], drafts), false);
});

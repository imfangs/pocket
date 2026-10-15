import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { createQuestionPresentationStore } from '../src/questionPresentation.ts';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: Conversation }, { default: QuestionPrompts }] = await Promise.all([vite.ssrLoadModule('/src/Conversation.tsx'), vite.ssrLoadModule('/src/QuestionPrompts.tsx')]);
after(() => vite.close());
const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const renderArchived = (extra = {}, draft = { text: '继续这个想法' }) => {
  const drafts = new Map([[id, draft]]);
  const history = { source: 'rollout', runtime: 'unavailable', canSend: false, canQueue: false, canAttemptSend: false, messages: [], outbox: [], checkedAt: 15, hint: '', connection: { status: 'idle' } };
  const html = renderToStaticMarkup(createElement(Conversation, { thread: { id, archived: true, missing: false }, drafts,
    historyCache: new Map([[id, { history, scrollTop: 0, nearBottom: true }]]), onConnect: async () => {}, onRestore: async () => {}, ...extra }));
  return { html, drafts };
};
test('an archived conversation offers explicit restore on its sole main action while retaining the query', () => {
  const { html, drafts } = renderArchived();
  assert.match(html, /<button class="primary" type="button">.*恢复会话<\/button>/);
  assert.doesNotMatch(html, />加入队列<\/button>|>发送<\/button>/);
  assert.match(html, />继续这个想法<\/textarea>/);
  assert.equal(drafts.get(id).text, '继续这个想法');
});
test('archive management waits block a second restore without disabling draft editing', () => {
  const { html } = renderArchived({ managementBlocked: true, managementHint: '正在恢复…' });
  assert.match(html, /<button class="primary" type="button" disabled="">/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
});
test('an archived unknown query retains receipt checking instead of offering restore', () => {
  const { html } = renderArchived({}, { text: '', requestId: 'old-receipt' });
  assert.match(html, />核对发送状态<\/button>/);
  assert.doesNotMatch(html, />恢复会话<\/button>/);
});
const question = { key: 'b'.repeat(64), sourceMessageId: 'message', title: '选择下一步', options: ['A', 'B'] };
test('both visible and ignored answer drafts expose a discard action', () => {
  for (const ignored of [false, true]) {
    const store = createQuestionPresentationStore({ getItem: () => null, setItem() {} });
    store.setIgnored(id, question.key, ignored);
    const drafts = new Map([[`${id}/question/${question.key}`, { text: '', customText: '', optionText: 'A', answerMode: 'custom' }]]);
    const html = renderToStaticMarkup(createElement(QuestionPrompts, { threadId: id, questions: [question], disabled: false, drafts, refresh: async () => {}, presentationStore: store }));
    assert.match(html, />丢弃草稿<\/button>/);
    assert.equal(drafts.size, 1, 'rendering cannot discard a draft');
  }
});
test('unconfirmed answers never expose a discard action', () => {
  for (const status of ['pending', 'accepted', 'unknown']) {
    const drafts = new Map([[`${id}/question/${question.key}`, { text: 'Keep', requestId: 'original-answer' }]]);
    const html = renderToStaticMarkup(createElement(QuestionPrompts, { threadId: id, questions: [{ ...question, response: { requestId: 'original-answer', status } }], disabled: false, drafts, refresh: async () => {} }));
    assert.doesNotMatch(html, />丢弃草稿<\/button>/);
    assert.match(html, /核对回答状态/);
  }
});

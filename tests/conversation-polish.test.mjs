import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { requestAnswerKey } from '../src/questionDrafts.ts';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: Message } = await vite.ssrLoadModule('/src/ConversationMessage.tsx');
const { default: Questions } = await vite.ssrLoadModule('/src/QuestionPrompts.tsx');
const { default: Requests } = await vite.ssrLoadModule('/src/RequestActions.tsx');
const { default: Conversation } = await vite.ssrLoadModule('/src/Conversation.tsx');
after(() => vite.close());

test('user text is copyable while message phase remains separate from the author', () => {
  const user = renderToStaticMarkup(createElement(Message, { message: { id: 'user', role: 'user', text: 'A user message', timestamp: 1 } }));
  assert.match(user, /aria-label="复制这条消息"/);
  assert.match(user, /class="message-role">你/);
  assert.match(user, /dateTime="1970-01-01/);
  const answer = renderToStaticMarkup(createElement(Message, { message: { id: 'assistant', role: 'assistant', phase: 'final_answer', text: 'The final answer' } }));
  assert.match(answer, /aria-label="Codex · 最终回复"/);
  assert.match(answer, /class="message-phase">回复/);
  assert.match(answer, /aria-label="复制回复"/);
});

test('reopening an async question restores written text with a labelled native fieldset', () => {
  const question = { key: 'key', title: 'Which direction?', options: ['A', 'B'] };
  const drafts = new Map([['thread/question/key', { text: 'Preserved written answer', answerMode: 'custom', customText: 'Preserved written answer', optionText: 'B' }]]);
  const html = renderToStaticMarkup(createElement(Questions, { threadId: 'thread', questions: [question], disabled: false, drafts, refresh: async () => {} }));
  assert.match(html, /<fieldset class="question-fields">/);
  assert.match(html, /<legend[^>]*>Which direction\?/);
  assert.match(html, /<textarea[^>]*>Preserved written answer<\/textarea>/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
});

test('synchronous request fields restore only their own answers and retain secret masking', () => {
  const request = { key: 'request', kind: 'userInput', reason: 'Clarify the task', choices: [], questions: [{ id: 'details', question: 'Details' }, { id: 'secret', question: 'Secret', isSecret: true }] };
  const drafts = new Map([
    [requestAnswerKey('thread', request.key, 'details'), { text: 'Kept across task switches' }],
    [requestAnswerKey('thread', request.key, 'secret'), { text: 'fixture-value' }],
  ]);
  const html = renderToStaticMarkup(createElement(Requests, { threadId: 'thread', requests: [request], disabled: false, drafts, refresh: async () => {} }));
  assert.match(html, /class="approval-text-answer"/);
  assert.match(html, />Kept across task switches<\/textarea>/);
  assert.match(html, /type="password"[^>]*value="fixture-value"/);
  const waiting = renderToStaticMarkup(createElement(Requests, { threadId: 'thread', requests: [{ ...request, response: { responseId: 'reply', status: 'unknown' } }], disabled: false, drafts, refresh: async () => {} }));
  assert.match(waiting, /结果待核对，不会重复响应/);
  assert.doesNotMatch(waiting, />提交回答<\/button>/);
});

test('a restored reading position exposes a keyboard-accessible return to latest without moving the read marker', () => {
  const id = 'thread';
  const cache = new Map([[id, { nearBottom: false, scrollTop: 240, history: { source: 'desktop', runtime: 'idle', messages: [{ id: 'm', role: 'assistant', text: 'Existing content' }], checkedAt: 1, canSend: true, hint: '' } }]]);
  const html = renderToStaticMarkup(createElement(Conversation, { thread: { id, archived: false, missing: false }, drafts: new Map(), historyCache: cache, onConnect: async () => ({}) }));
  assert.match(html, /class="conversation-feed"/);
  assert.match(html, /class="conversation-messages" role="region" aria-label="会话正文" tabindex="0"/);
  assert.match(html, /class="conversation-latest"/);
  assert.match(html, /返回最新消息/);
});

test('optional questions stay at their message position while later progress and the composer remain visible', () => {
  const id = 'thread';
  const question = { key: 'question-key', sourceMessageId: 'question-message', turnId: 'turn', title: 'Prefer A or B?', options: ['A', 'B'] };
  const history = { source: 'desktop', runtime: 'active', checkedAt: 1, canSend: true,
    turnTiming: { turnId: 'turn' }, asyncQuestions: [question], messages: [
      { id: 'question-message', role: 'assistant', text: question.title, isQuestion: true },
      { id: 'later-progress', role: 'assistant', phase: 'commentary', text: 'Continuing the independent work.' },
    ] };
  const html = renderToStaticMarkup(createElement(Conversation, { thread: { id }, drafts: new Map(), historyCache: new Map([[id, { history }]]), onConnect: async () => ({}) }));
  const prompt = html.indexOf('Codex 想确认');
  assert.ok(prompt > html.indexOf('aria-label="会话正文"'));
  assert.ok(prompt < html.indexOf('Continuing the independent work.'), 'question controls precede later progress in the same transcript');
  assert.ok(prompt < html.indexOf('class="conversation-status"'), 'question controls belong to the scrollable transcript');
  assert.match(html, /class="conversation-composer"/);
});

test('an actionable question retains any surrounding source-message explanation', () => {
  const id = 'thread';
  const history = { source: 'desktop', runtime: 'idle', checkedAt: 1, canSend: true, turnTiming: { turnId: 'turn' },
    asyncQuestions: [{ key: 'question-key', sourceMessageId: 'question-message', turnId: 'turn', title: 'Which output?', options: [] }],
    messages: [{ id: 'question-message', role: 'assistant', isQuestion: true, text: 'The draft is ready. Which output?' }] };
  const html = renderToStaticMarkup(createElement(Conversation, { thread: { id }, drafts: new Map(), historyCache: new Map([[id, { history }]]), onConnect: async () => ({}) }));
  assert.match(html, /The draft is ready\./);
});

test('inline questions retain referenced images and the source truncation warning', () => {
  const id = 'thread';
  const imageUrl = '/api/tasks/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa/images/' + 'a'.repeat(64);
  const history = { source: 'desktop', runtime: 'idle', checkedAt: 1, canSend: true, turnTiming: { turnId: 'turn' },
    asyncQuestions: [{ key: 'question-key', sourceMessageId: 'question-message', turnId: 'turn', title: 'Which image?', options: [] }],
    messages: [{ id: 'question-message', role: 'assistant', isQuestion: true, truncated: true,
      text: 'Compare this image: ![Candidate](/workspace/candidate.png)', images: { '/workspace/candidate.png': imageUrl } }] };
  const html = renderToStaticMarkup(createElement(Conversation, { thread: { id }, drafts: new Map(), historyCache: new Map([[id, { history }]]), onConnect: async () => ({}) }));
  assert.ok(html.includes(imageUrl));
  assert.match(html, /内容较长，此处已截取/);
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { requestAnswerKey } from '../src/questionDrafts.ts';
import { groupProgressMessages } from '../src/progressGroups.ts';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: Message } = await vite.ssrLoadModule('/src/ConversationMessage.tsx');
const { default: Questions } = await vite.ssrLoadModule('/src/QuestionPrompts.tsx');
const { default: Requests } = await vite.ssrLoadModule('/src/RequestActions.tsx');
const { default: Conversation } = await vite.ssrLoadModule('/src/Conversation.tsx');
after(() => vite.close());

function renderConversation(history, viewState = {}) {
  const id = 'thread';
  return renderToStaticMarkup(createElement(Conversation, { thread: { id, archived: false, missing: false }, drafts: new Map(),
    historyCache: new Map([[id, { history, nearBottom: true, scrollTop: 0, ...viewState }]]), onConnect: async () => ({}) }));
}

function progressBodies(html) {
  // Each disclosure preserves its ConversationMessage articles inside the
  // controlled body. Keep the whole body so outer-content assertions can
  // detect a final reply or an actionable question folded by incorrect wiring.
  return [...html.matchAll(/<div\b([^>]*class="progress-disclosure-body"[^>]*)>([\s\S]*?<\/article>)<\/div>/g)];
}

test('a cached same-turn final folds process by default while its final reply and current question stay outside', () => {
  const question = { key: 'current-fold-question', sourceMessageId: 'question-source', turnId: 'completed-turn', title: 'Which follow-up should I use?', options: ['A', 'B'] };
  const history = { source: 'desktop', runtime: 'idle', canSend: true, checkedAt: 1, hint: '',
    turnTiming: { turnId: 'completed-turn', status: 'completed' }, asyncQuestions: [question], messages: [
      { id: 'process', turnId: 'completed-turn', role: 'assistant', phase: 'commentary', text: 'Completed independent process.' },
      // Native questions can refer to an ordinary commentary message without
      // isQuestion. Conversation must protect the mapped QuestionPrompts source.
      { id: question.sourceMessageId, turnId: 'completed-turn', role: 'assistant', phase: 'commentary', text: question.title },
      { id: 'final', turnId: 'completed-turn', role: 'assistant', phase: 'final_answer', text: 'Visible final deliverable.' },
    ] };
  const html = renderConversation(history), bodies = progressBodies(html);
  const toggles = [...html.matchAll(/<button\b([^>]*class="progress-disclosure-toggle"[^>]*)>/g)];
  assert.equal(bodies.length, 1);
  assert.equal(toggles.length, 1);
  assert.match(toggles[0][1], /aria-expanded="false"/);
  assert.match(bodies[0][1], /hidden=""/);
  assert.match(bodies[0][2], /Completed independent process\./, 'hidden process stays mounted');
  const outside = html.replace(bodies[0][0], '');
  assert.doesNotMatch(outside, /Completed independent process\./);
  assert.match(outside, /Visible final deliverable\./);
  assert.match(outside, /class="question-prompts"/);
  assert.match(outside, /Which follow-up should I use\?/);
  assert.doesNotMatch(bodies[0][2], /Visible final deliverable|Which follow-up|question-prompts/);
});

test('cached progress expansion reconnects to the helper group while a neighboring final leaves the current turn open', () => {
  const history = { source: 'desktop', runtime: 'active', canSend: true, checkedAt: 1, hint: '',
    turnTiming: { turnId: 'current-turn', status: 'inProgress' }, messages: [
      { id: 'older-process', turnId: 'older-turn', role: 'assistant', phase: 'commentary', text: 'Previously expanded process.' },
      { id: 'older-final', turnId: 'older-turn', role: 'assistant', phase: 'final_answer', text: 'Older completed reply.' },
      { id: 'current-process', turnId: 'current-turn', role: 'assistant', phase: 'commentary', text: 'Current turn still has no final.' },
      { id: 'neighbor-final', turnId: 'neighbor-turn', role: 'assistant', phase: 'final', text: 'Neighboring turn completed.' },
    ] };
  const group = groupProgressMessages(history.messages).find(entry => entry.type === 'progress');
  assert.ok(group);
  const html = renderConversation(history, { progressView: { expanded: [group.id], deferred: [], seen: [group.id] } });
  const bodies = progressBodies(html);
  assert.equal(bodies.length, 1);
  const bodyId = renderToStaticMarkup(createElement('div', { id: `${group.id}-content` })).match(/id="[^"]*"/)[0];
  assert.ok(bodies[0][1].includes(bodyId), 'the saved helper group ID controls the rendered disclosure');
  assert.doesNotMatch(bodies[0][1], /\bhidden=/);
  const toggle = html.match(/<button\b([^>]*class="progress-disclosure-toggle"[^>]*)>/)[1];
  assert.match(toggle, /aria-expanded="true"/);
  assert.match(html, /收起过程/);
  assert.match(bodies[0][2], /Previously expanded process\./);
  const outside = html.replace(bodies[0][0], '');
  assert.match(outside, /Older completed reply\./);
  assert.match(outside, /Current turn still has no final\./);
  assert.match(outside, /Neighboring turn completed\./);
  assert.doesNotMatch(bodies[0][2], /Current turn still has no final|Neighboring turn completed/);
});

test('a completed turn duration appears once beside its final reply while unmatched and running timing remains visible', () => {
  const history = { source: 'desktop', runtime: 'idle', canSend: true, checkedAt: 1, hint: '',
    turnTiming: { turnId: 'current-turn', status: 'completed', startedAt: 0, observedAt: 64000, durationMs: 64000 },
    messages: [{ id: 'final', turnId: 'current-turn', role: 'assistant', phase: 'final_answer', text: 'The reply', turnDurationMs: 64000 }] };
  const same = renderConversation(history);
  assert.equal((same.match(/总用时/g) || []).length, 1);
  assert.match(same, /class="message-duration"/);
  const missingReply = renderConversation({ ...history, messages: [] });
  assert.equal((missingReply.match(/总用时/g) || []).length, 1);
  assert.match(missingReply, /class="turn-duration"/);
  const olderReply = renderConversation({ ...history, messages: [{ ...history.messages[0], turnId: 'older-turn' }] });
  assert.equal((olderReply.match(/总用时/g) || []).length, 2, 'timings for different turns are not duplicate information');
  const running = renderConversation({ ...history, runtime: 'active', turnTiming: { ...history.turnTiming, status: 'inProgress', durationMs: null } });
  assert.match(running, /class="turn-duration"/);
  assert.match(renderConversation({ ...history, runtime: 'active' }), /class="turn-duration"/, 'active runtime still retains timing when turn metadata lags');
});

test('only known sendable desktop boilerplate is omitted; permission and unfamiliar hints remain visible', () => {
  const base = { source: 'desktop', resumeState: 'resumed', runtime: 'idle', canSend: true, messages: [], checkedAt: 2,
    connection: { status: 'connected', requestId: 'connect', startedAt: 0, checkedAt: 2 } };
  for (const hint of ['消息会在 Mac 的原任务中运行，沿用原模型与权限。', '正在运行，新消息默认进入 Pocket 待发列表。']) {
    const html = renderConversation({ ...base, hint });
    assert.equal(html.includes(hint), false);
    assert.doesNotMatch(html, /已连接 Mac 中的原任务/);
    assert.equal(renderConversation({ ...base, hint, canSend: false }).includes(hint.replaceAll('原任务','会话')), true);
  }
  for (const hint of ['请先处理原任务中的确认。', '正在压缩上下文，完成后可继续。', '需要核对的新状态'])
    assert.equal(renderConversation({ ...base, hint, canSend: false }).includes(hint.replaceAll('原任务','会话')), true);
  assert.equal(renderConversation({ ...base, hint: '需要核对的新状态' }).includes('需要核对的新状态'), true);
});

test('messages keep accessible identities while time, duration and copy actions follow the body', () => {
  const user = renderToStaticMarkup(createElement(Message, { message: { id: 'user', role: 'user', text: 'A user message', timestamp: 1 } }));
  assert.match(user, /aria-label="复制这条消息"/);
  assert.match(user, /data-message-id="user" aria-label="你"/);
  assert.doesNotMatch(user, /message-label|message-role|message-phase/);
  assert.match(user, /dateTime="1970-01-01/);
  assert.ok(user.indexOf('<footer class="message-footer">') > user.indexOf('A user message'));
  assert.match(user, /<footer[^>]*>[\s\S]*dateTime="[^"]+"[\s\S]*aria-label="复制这条消息"[\s\S]*<\/footer><\/article>$/);
  const answer = renderToStaticMarkup(createElement(Message, { message: { id: 'assistant', role: 'assistant', phase: 'final_answer', text: 'The final answer', turnDurationMs: 64000, truncated: true } }));
  assert.match(answer, /aria-label="Codex · 最终回复"/);
  assert.match(answer, /data-message-id="assistant"/);
  assert.doesNotMatch(answer, /message-label|message-role|message-phase/);
  assert.match(answer, /aria-label="复制回复"/);
  assert.ok(answer.indexOf('<footer class="message-footer">') > answer.indexOf('内容较长，此处已截取。'));
  assert.match(answer, /<footer[^>]*>[\s\S]*总用时 <time>1:04<\/time>[\s\S]*aria-label="复制回复"[\s\S]*<\/footer>/);
  assert.equal((answer.match(/总用时/g) || []).length, 1);
  const progress = renderToStaticMarkup(createElement(Message, { message: { id: 'process', role: 'assistant', phase: 'commentary', text: 'The process message' } }));
  assert.match(progress, /data-message-id="process" aria-label="Codex · 过程"/);
  assert.doesNotMatch(progress, /message-label|message-role|message-phase/);
  assert.match(progress, /<footer[^>]*>[\s\S]*aria-label="复制过程"[\s\S]*<\/footer>/);
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
  assert.doesNotMatch(html, /aria-label="跳到最新消息"/, 'the floating action is the only jump-to-latest control');
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

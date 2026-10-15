import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { createSubmittedQueryStore, seedSubmittedQuery } from '../src/submittedQueries.ts';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: Conversation } = await vite.ssrLoadModule('/src/Conversation.tsx');
after(() => vite.close());

function render(submissions, history, drafts = new Map()) {
  return renderToStaticMarkup(createElement(Conversation, {
    thread: { id: 'thread', archived: false, missing: false }, drafts, submissions,
    historyCache: history ? new Map([['thread', { history, scrollTop: 0, nearBottom: true }]]) : new Map(),
    onConnect: async () => ({}),
  }));
}
const history = overrides => ({ source: 'desktop', runtime: 'idle', canSend: true, checkedAt: 1, messages: [], outbox: [], hint: '', ...overrides });
const entry = { threadId: 'thread', requestId: 'submitted-one', text: 'The submitted first query', status: 'accepted', createdAt: 1 };
const outbox = { id: entry.requestId, text: entry.text, status: 'queued', revision: 0, createdAt: 1 };

test('accepted first query remains visible while native history has not echoed it and a new draft is being written', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, entry);
  const drafts = new Map([['thread', { text: 'An independent next query' }]]);
  const html = render(submissions, undefined, drafts);
  assert.match(html, /The submitted first query/);
  assert.match(html, /已发送/);
  assert.doesNotMatch(html, /<strong>你<\/strong>|原文已保留|消息出现前会保留/);
  assert.match(html, /<textarea[^>]*>An independent next query<\/textarea>/);
  assert.equal(drafts.get('thread').text, 'An independent next query');
});

test('quick creation shows a queued first query before the first history response', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, { ...entry, status: 'queued' });
  const html = render(submissions);
  assert.match(html, /data-submission-id="submitted-one"/);
  assert.match(html, /正在连接 Mac/);
  assert.doesNotMatch(html, /已发送|原文已保留/);
  assert.match(html, /The submitted first query/);
});

test('real outbox renders exactly one copy and accepted receipt overrides a stale queued row', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, entry);
  const html = render(submissions, history({ outbox: [outbox] }));
  assert.equal(html.split(entry.text).length - 1, 1);
  assert.doesNotMatch(html, /data-submission-id="submitted-one"/);
  assert.match(html, /data-feedback-state="accepted" data-outbox-id="submitted-one"/);
  assert.doesNotMatch(html, /is-queue-breathing|>直接发送<|>编辑<|>删除</);
});

test('rendered exact user echo replaces both temporary card and stale outbox in one frame', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, entry);
  const messages = [{ id: 'native-message', role: 'user', clientMessageId: entry.requestId, text: entry.text }];
  const html = render(submissions, history({ messages, outbox: [outbox] }));
  assert.equal(html.split(entry.text).length - 1, 1);
  assert.doesNotMatch(html, /data-submission-id|data-outbox-id/);
});

test('unknown submission retains its original text while the independent draft stays editable', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, { ...entry, status: 'unknown' });
  const html = render(submissions, history(), new Map([['thread', { text: 'A new draft' }]]));
  assert.match(html, /结果待核对/);
  assert.match(html, /核对不会重复发送/);
  assert.doesNotMatch(html, />重新编辑<|>收起<|>直接发送<|>重试发送<|data-feedback-state="accepted"/);
  assert.match(html, /The submitted first query/);
  assert.match(html, /<textarea[^>]*>A new draft<\/textarea>/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.ok(submissions.reloadBlocker());
});

test('a truncated history echo keeps the complete accepted text card rendered', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, entry);
  const messages = [{ id: 'truncated-native', role: 'user', clientMessageId: entry.requestId, text: 'The submitted', truncated: true }];
  const html = render(submissions, history({ messages }));
  assert.match(html, /data-submission-id="submitted-one"/);
  assert.match(html, /The submitted first query/);
  assert.match(html, /已发送/);
  assert.ok(submissions.reloadBlocker());
});

test('complete rollout text leaves unknown outbox status and verification controls visible', () => {
  const submissions = createSubmittedQueryStore(); seedSubmittedQuery(submissions, { ...entry, status: 'unknown' });
  const messages = [{ id: 'saved-message', role: 'user', clientMessageId: entry.requestId, text: entry.text }];
  const html = render(submissions, history({ source: 'rollout', messages, outbox: [{ ...outbox, status: 'unknown' }] }));
  assert.match(html, /data-feedback-state="unknown" data-outbox-id="submitted-one"/);
  assert.match(html, /核对状态/);
  assert.match(html, /首条结果待核对，队列已暂停/);
  assert.ok(submissions.reloadBlocker());
});

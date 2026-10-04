import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: Conversation } = await vite.ssrLoadModule('/src/Conversation.tsx');
after(() => vite.close());
const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const connection = status => ({ requestId: 'connection-one', status, startedAt: 10, checkedAt: 20, ...(status === 'failed' ? { code: 'connection_timeout' } : {}) });
function render(state, override = {}) {
  const history = { source: 'rollout', runtime: 'unavailable', canSend: false, canQueue: true, canAttemptSend: true, messages: [], outbox: [{ id: 'q', text: 'Saved instruction', status: 'queued', revision: 0 }], checkedAt: 15, hint: '显示已保存的历史。连接 Mac 中的原任务后可发送消息。', connection: connection(state), ...override };
  const drafts = new Map([[id, { text: 'Keep this draft' }]]);
  const html = renderToStaticMarkup(createElement(Conversation, { thread: { id, archived: false, missing: false }, drafts, historyCache: new Map([[id, { history, scrollTop: 0, nearBottom: true }]]), onConnect: async () => ({ connection: connection('connecting') }) }));
  return { html, drafts };
}

test('an acknowledged handoff remains visibly connecting and keeps the composer draft editable', () => {
  const { html, drafts } = render('connecting');
  assert.match(html, /正在连接 Mac 中的原任务/);
  assert.doesNotMatch(html, /已连接 Mac 中的原任务/);
  assert.match(html, /<textarea[^>]*>Keep this draft<\/textarea>/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.equal(drafts.get(id).text, 'Keep this draft');
});

test('failed connection preserves queued text and draft, and offers an explicit connection retry', () => {
  const { html, drafts } = render('failed');
  assert.match(html, /连接原任务超时/);
  assert.match(html, /重试连接/);
  assert.match(html, /Saved instruction/);
  assert.equal(drafts.get(id).text, 'Keep this draft');
});

test('verified connection does not grant sending permission before a fresh desktop snapshot', () => {
  const { html } = render('connected', { outbox: [] });
  assert.match(html, /已连接 Mac 中的原任务，正在同步发送状态/);
  assert.match(html, /加入队列/);
  assert.doesNotMatch(html, />发送<\/button>/);
});

test('a newer fallback read does not keep claiming an old verified connection is live', () => {
  const { html } = render('connected', { checkedAt: 30 });
  assert.doesNotMatch(html, /已连接 Mac 中的原任务/);
  assert.match(html, /重试连接/);
});

test('a fresh resumed desktop clears an old failed connection without overriding approval restrictions', () => {
  const { html } = render('failed', { source: 'desktop', resumeState: 'resumed', checkedAt: 100, canSend: false, canAttemptSend: false, hint: '请先处理原任务中的确认。', pendingRequests: [{ key: 'k', kind: 'unsupported', reason: '请在 Mac 处理', choices: [] }] });
  assert.match(html, /已连接 Mac 中的原任务/);
  assert.doesNotMatch(html, /连接原任务超时|重试连接/);
  assert.match(html, /请先处理原任务中的确认/);
  assert.doesNotMatch(html, />发送<\/button>/);
});

test('an incompatible app retains its concrete blocker instead of promising automatic send', () => {
  const { html } = render('idle', { connection: { status: 'idle' }, readOnlyReason: 'app_version_changed', canAttemptSend: false, hint: 'Codex 桌面版本已变化，发送功能需重新验证。' });
  assert.match(html, /发送功能需重新验证/);
  assert.doesNotMatch(html, /提交消息后自动连接/);
});

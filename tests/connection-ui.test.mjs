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
  assert.match(html, /发送并连接/);
  assert.doesNotMatch(html, />发送<\/button>/);
});

test('a newer fallback read does not keep claiming an old verified connection is live', () => {
  const { html } = render('connected', { checkedAt: 30 });
  assert.doesNotMatch(html, /已连接 Mac 中的原任务/);
  assert.match(html, /重试连接/);
});

test('a fresh resumed desktop clears an old failed connection without overriding approval restrictions', () => {
  const { html } = render('failed', { source: 'desktop', resumeState: 'resumed', checkedAt: 100, canSend: false, canAttemptSend: false, hint: '请先处理原任务中的确认。', pendingRequests: [{ key: 'k', kind: 'unsupported', reason: '请在 Mac 处理', choices: [] }] });
  assert.doesNotMatch(html, /已连接 Mac 中的原任务/);
  assert.doesNotMatch(html, /连接原任务超时|重试连接/);
  assert.match(html, /请先处理原任务中的确认/);
  assert.doesNotMatch(html, />发送<\/button>/);
});

test('incompatible history keeps text editable and queue storage available without promising automatic connection', () => {
  for (const readOnlyReason of ['desktop_protocol_incompatible', 'unsupported_app_identity', 'app_version_changed']) {
    const { html, drafts } = render('idle', { connection: { status: 'idle' }, readOnlyReason, canAttemptSend: false, canAttemptCompact: false });
    assert.match(html, /草稿和待发消息已保留/);
    assert.doesNotMatch(html, /版本已变化|提交消息后自动连接|发送并连接/);
    assert.match(html, /<button aria-label="直接发送第 1 条消息" disabled=""/);
    assert.doesNotMatch(html.match(/<button class="primary"[^>]*>/)[0], /disabled/);
    assert.match(html, /加入队列/);
    assert.match(html, /Saved instruction/);
    assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
    assert.equal(drafts.get(id).text, 'Keep this draft');
    const emptyQueue = render('idle', { connection: { status: 'idle' }, readOnlyReason, canAttemptSend: false, outbox: [] }).html;
    assert.doesNotMatch(emptyQueue, /发送并连接/);
    assert.match(emptyQueue, /加入队列/);
  }
});

test('an incompatible connection result blocks stale sending permissions before history finishes refreshing', () => {
  const { html } = render('failed', { connection: { ...connection('failed'), code: 'desktop_protocol_incompatible' }, canAttemptSend: true });
  assert.match(html, /接口与 Pocket 不兼容/);
  assert.match(html, /<button aria-label="直接发送第 1 条消息" disabled=""/);
  assert.doesNotMatch(html, /发送并连接/);
});

test('fresh resumed history clears an old incompatible connection while preserving the queued text and draft', () => {
  const { html, drafts } = render('failed', { connection: { ...connection('failed'), code: 'desktop_protocol_incompatible' },
    source: 'desktop', resumeState: 'resumed', checkedAt: 100, canSend: true, canAttemptSend: true,
    hint: '消息会在 Mac 的原任务中运行，沿用原模型与权限。' });
  assert.doesNotMatch(html, /接口与 Pocket 不兼容|重试连接/);
  assert.doesNotMatch(html.match(/<button aria-label="直接发送第 1 条消息"[^>]*>/)[0], /disabled/);
  assert.match(html, /Saved instruction/);
  assert.equal(drafts.get(id).text, 'Keep this draft');
});

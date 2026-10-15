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
function render(props = {}) {
  const drafts = new Map([[id, { text: 'Retained draft' }]]);
  return { drafts, html: renderToStaticMarkup(createElement(Conversation, { thread: { id, archived: false, missing: false }, drafts,
    historyCache: new Map([[id, { history: { source: 'rollout', runtime: 'unavailable', canSend: false, canQueue: true, messages: [], outbox: [], checkedAt: 1 }, scrollTop: 0, nearBottom: true }]]), onConnect: async () => ({}), ...props })) };
}
test('an empty persisted conversation can submit its first message and connect without a prior owner', () => {
  const { html } = render();
  assert.match(html, /<button class="primary"[^>]*>[\s\S]*发送<\/button>/);
  assert.doesNotMatch(html, /发送并连接|连接任务/);
  const primary = html.match(/<button class="primary"([^>]*)>/)[1];
  assert.doesNotMatch(primary, /disabled/);
});
test('waiting archive blocks sending and reconnecting but preserves an editable draft', () => {
  const { html, drafts } = render({ managementBlocked: true, managementHint: '等待 Codex 释放会话，释放后自动归档，可取消。' });
  assert.match(html, /等待 Codex 释放会话/);
  assert.match(html, /<button class="primary"[^>]*disabled=""[^>]*>/);
  assert.match(html, /暂不可发送/);
  assert.doesNotMatch(html, /连接任务/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.equal(drafts.get(id).text, 'Retained draft');
});

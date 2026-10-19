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
function assertPrimaryAction(html, { type, disabled, text }) {
  const matches = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(match =>
    (match[1].match(/(?:^|\s)class="([^"]*)"/)?.[1].split(/\s+/) || []).includes('primary'));
  assert.equal(matches.length, 1, 'exactly one primary action is visible');
  const [, attributes, content] = matches[0];
  assert.match(attributes, new RegExp(`(?:^|\\s)type="${type}"`));
  assert.equal(/(?:^|\s)disabled(?:=""|\s|$)/.test(attributes), disabled, 'primary action disabled state');
  assert.equal(content.replace(/<[^>]*>/g, ''), text);
}

test('an empty persisted conversation can submit its first message and connect without a prior owner', () => {
  const { html } = render();
  assertPrimaryAction(html, { type: 'submit', disabled: false, text: '发送' });
  assert.doesNotMatch(html, /发送并连接|连接任务/);
});
test('waiting archive blocks sending and reconnecting but preserves an editable draft', () => {
  const { html, drafts } = render({ managementBlocked: true, managementHint: '等待 Codex 释放会话，释放后自动归档，可取消。' });
  assert.match(html, /等待 Codex 释放会话/);
  assertPrimaryAction(html, { type: 'submit', disabled: true, text: '暂不可发送' });
  assert.match(html, /暂不可发送/);
  assert.doesNotMatch(html, /连接任务/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.equal(drafts.get(id).text, 'Retained draft');
});

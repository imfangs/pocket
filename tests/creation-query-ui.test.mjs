import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: NewConversationDialog } = await vite.ssrLoadModule('/src/NewConversationDialog.tsx');
after(() => vite.close());
const render = props => renderToStaticMarkup(createElement(NewConversationDialog, { onCreate: async () => {}, onCheck() {}, onCancelOperation() {}, onClose() {}, ...props }));

test('ordinary creation always puts Query and its clear action before directory and optional title', () => {
  const html = render({});
  assert.match(html, /<textarea[^>]*id="quick-create-query"/);
  assert.ok(html.indexOf('id="quick-create-query"') < html.indexOf('id="new-conversation-location"'));
  assert.ok(html.indexOf('id="new-conversation-location"') < html.indexOf('id="new-conversation-name"'));
  assert.match(html, /aria-label="清空 Query"/);
  assert.match(html, />创建会话<\/button>/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /required/);
});

test('a nonempty initial Query is visible and changes the action to create and send', () => {
  const html = render({ initialQuery: 'The clipboard query' });
  assert.match(html, />The clipboard query<\/textarea>/);
  assert.match(html, />创建并发送<\/button>/);
});

test('cleared or whitespace-only Query explicitly creates an empty conversation', () => {
  for (const initialQuery of ['', ' \n ']) {
    const html = render({ initialQuery });
    assert.match(html, />创建会话<\/button>/);
    assert.doesNotMatch(html, />创建并发送<\/button>/);
  }
});

test('restored pending creation displays its original Query with editing and clear controls locked', () => {
  const html = render({ initialQuery: 'Original pending query', operation: { requestId: 'pending-id', operation: 'create', status: 'pending' } });
  assert.match(html, />Original pending query<\/textarea>/);
  assert.match(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.match(html, /aria-label="清空 Query" disabled/);
  assert.match(html, /正在创建/);
});

test('a completed creation cannot turn its original Query into an enabled second submit', () => {
  const html = render({ initialQuery: 'Already submitted query', operation: { requestId: 'done-id', operation: 'create', status: 'succeeded', threadId: 'created-thread' } });
  assert.match(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.match(html, /aria-label="清空 Query" disabled/);
  assert.match(html, /class="primary" disabled/);
});

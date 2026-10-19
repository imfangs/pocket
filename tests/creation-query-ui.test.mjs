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

test('ordinary creation begins with an accessible message field before directory and optional title', () => {
  const html = render({});
  assert.match(html, /<textarea[^>]*id="quick-create-query"/);
  assert.ok(html.indexOf('id="quick-create-query"') < html.indexOf('id="new-conversation-location"'));
  assert.ok(html.indexOf('id="new-conversation-location"') < html.indexOf('id="new-conversation-name"'));
  assert.match(html, /<label class="sr-only" for="quick-create-query">首条消息<\/label>/);
  assert.doesNotMatch(html, /quick-create-query-heading|首条消息，可留空|aria-label="清空输入"/);
  assert.match(html, /<details[^>]*class="new-conversation-settings"/);
  assert.doesNotMatch(html.match(/<details[^>]*>/)[0], /\bopen\b/);
  assert.match(html, /noValidate/);
  assert.match(html, />正在准备…<\/button>/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /required/);
});

test('a nonempty initial Query stays visible while creation options load', () => {
  const html = render({ initialQuery: 'The clipboard query' });
  assert.match(html, />The clipboard query<\/textarea>/);
  const clear = html.match(/<button\b[^>]*aria-label="清空输入"[^>]*>/)?.[0];
  assert.ok(clear, 'the initial Query has a clear action');
  assert.match(clear, /class="[^"]*\bicon-button\b[^"]*"/);
  assert.match(clear, /class="[^"]*\bquick-create-clear\b[^"]*"/);
  assert.match(clear, /\stype="button"/);
  assert.match(html, />正在准备…<\/button>/);
});

test('empty Query remains optional while creation options load', () => {
  for (const initialQuery of ['', ' \n ']) {
    const html = render({ initialQuery });
    assert.match(html, />正在准备…<\/button>/);
    assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /required/);
  }
});

test('restored pending creation displays its original Query with editing and clear controls locked', () => {
  const html = render({ initialQuery: 'Original pending query', operation: { requestId: 'pending-id', operation: 'create', status: 'pending' } });
  assert.match(html, />Original pending query<\/textarea>/);
  assert.match(html.match(/<textarea[^>]*>/)[0], /disabled/);
  const clear = html.match(/<button\b[^>]*aria-label="清空输入"[^>]*>/)?.[0];
  assert.ok(clear, 'the original Query retains its clear action');
  assert.match(clear, /class="[^"]*\bquick-create-clear\b[^"]*"/);
  assert.match(clear, /\sdisabled(?:=""|\s|>)/);
  assert.match(html, /正在创建/);
});

test('a completed creation cannot turn its original Query into an enabled second submit', () => {
  const html = render({ initialQuery: 'Already submitted query', operation: { requestId: 'done-id', operation: 'create', status: 'succeeded', threadId: 'created-thread' } });
  assert.match(html.match(/<textarea[^>]*>/)[0], /disabled/);
  const clear = html.match(/<button\b[^>]*aria-label="清空输入"[^>]*>/)?.[0];
  assert.ok(clear, 'the original Query retains its clear action');
  assert.match(clear, /class="[^"]*\bquick-create-clear\b[^"]*"/);
  assert.match(clear, /\sdisabled(?:=""|\s|>)/);
  const submit = html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0];
  assert.ok(submit, 'the create action retains explicit form submission');
  assert.match(submit, /class="[^"]*\bprimary\b[^"]*"/);
  assert.match(submit, /\sdisabled(?:=""|\s|>)/);
});

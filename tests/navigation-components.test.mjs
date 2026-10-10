import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: TaskList }, { default: Inspector }, { default: ThreadProperties }, { Modal }] = await Promise.all([
  vite.ssrLoadModule('/src/TaskList.tsx'), vite.ssrLoadModule('/src/Inspector.tsx'), vite.ssrLoadModule('/src/ThreadProperties.tsx'), vite.ssrLoadModule('/src/Dialogs.tsx'),
]);
after(() => vite.close());
const thread = { id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', title: 'A conversation', archived: false, separator: false, missing: false, pinned: false, intent: 'none', groupIds: [], updatedAt: 1, createdAt: 1, revision: 0, note: '', reviewAt: null, projectName: 'Project', cwd: '/synthetic' };
const noop = () => {};
const listProps = { threads: [], groups: [], selected: null, view: 'all', checked: new Set(), onSelect: noop, onOpen: noop, onCheck: noop, onCheckAll: noop, onBatch: noop, onClear: noop, busy: false, query: '', onClearQuery: noop };

test('an empty filtered list offers its actual reset action', () => {
  const html = renderToStaticMarkup(createElement(TaskList, { ...listProps, hasFilters: true, onClearFilters: noop }));
  assert.match(html, /当前筛选下没有会话/);
  assert.match(html, /<button[^>]*>清除筛选<\/button>/);
});
test('a row has one readable unread indicator, draft context and a stable focus target', () => {
  const html = renderToStaticMarkup(createElement(TaskList, { ...listProps, threads: [{ ...thread, needsInput: true }], draftIds: new Set([thread.id]) }));
  assert.equal((html.match(/data-state="unread"/g) || []).length, 1);
  assert.doesNotMatch(html, /unread-dot/);
  assert.match(html, /data-state="draft"/);
  assert.match(html, new RegExp(`data-thread-id="${thread.id}"`));
  assert.doesNotMatch(html, /已显示全部|class="list-caption"/);
  assert.doesNotMatch(html, /条任务/);
});
test('the inspector exposes a management entry and linked tab panels without a one-tap archive action', () => {
  const html = renderToStaticMarkup(createElement(Inspector, { thread, groups: [], queryDrafts: new Map(), historyCache: new Map(), onSave: async () => thread, onOpen: async () => ({}), onArchive: async () => {}, onCheckOperation: noop, onCancelOperation: noop, onClose: noop, flushRef: { current: null }, onToast: noop }));
  assert.match(html, /inspector-management-trigger/);
  assert.doesNotMatch(html, />归档会话<\/button>/);
  const tabs = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => match[1]).filter(attributes => /role="tab"/.test(attributes));
  assert.equal(tabs.length, 2);
  assert.equal(tabs.filter(attributes => /tabindex="0"/.test(attributes)).length, 1);
  for (const attributes of tabs) {
    const target = attributes.match(/aria-controls="([^"]+)"/)[1];
    assert.ok(html.includes(`id="${target}"`));
  }
});
test('organizing presents the continuation note before arrangements and collapsible group choices', () => {
  const html = renderToStaticMarkup(createElement(ThreadProperties, { value: { intent: 'none', note: 'Keep my note', groupIds: [], reviewAt: null }, groups: [], disabled: false, onChange: noop, onSave: async () => {} }));
  assert.ok(html.indexOf('接续说明') < html.indexOf('我的安排'));
  assert.ok(html.indexOf('我的安排') < html.indexOf('inspector-group-picker'));
  assert.match(html, /Keep my note/);
});
test('a busy modal makes the close affordance explicitly unavailable', () => {
  const html = renderToStaticMarkup(createElement(Modal, { title: 'Saving', busy: true, onClose: noop }, 'Content'));
  assert.match(html, /aria-busy="true"/);
  const close = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => match[1]).find(attributes => /aria-label="关闭对话框"/.test(attributes));
  assert.match(close, /disabled/);
});

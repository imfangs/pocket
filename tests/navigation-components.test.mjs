import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: TaskList }, { default: Inspector }, { Modal }, { default: Sidebar }] = await Promise.all([
  vite.ssrLoadModule('/src/TaskList.tsx'), vite.ssrLoadModule('/src/Inspector.tsx'), vite.ssrLoadModule('/src/Dialogs.tsx'), vite.ssrLoadModule('/src/Sidebar.tsx'),
]);
after(() => vite.close());
const thread = { id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', title: 'A conversation', archived: false, separator: false, missing: false, pinned: false, intent: 'none', groupIds: [], updatedAt: 1, createdAt: 1, revision: 0, note: '', reviewAt: null, projectName: 'Project', cwd: '/synthetic' };
const noop = () => {};
const listProps = { threads: [], selected: null, view: 'all', onSelect: noop, onOpen: noop, busy: false, query: '', onClearQuery: noop };

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
test('the inspector opens directly into the conversation with one title entry for information', () => {
  const html = renderToStaticMarkup(createElement(Inspector, { thread: { ...thread, note: 'Legacy hidden note' }, queryDrafts: new Map(), historyCache: new Map(), onOpen: async () => ({}), onArchive: async () => {}, onRenamed: noop, onCheckOperation: noop, onCancelOperation: noop, onClose: noop }));
  assert.match(html, /class="inspector-title"/);
  assert.match(html, /class="inspector-title-trigger" aria-label="会话信息：A conversation" aria-haspopup="dialog"/);
  assert.match(html, /class="inspector-conversation"/);
  assert.doesNotMatch(html, /role="tab|inspector-management-trigger|inspector-savebar|id="continuation"|Legacy hidden note/);
  assert.doesNotMatch(html, />归档会话<\/button>/);
});
test('rows hide retired notes and arrangement fields while retaining runtime state', () => {
  const html = renderToStaticMarkup(createElement(TaskList, { ...listProps, threads: [{ ...thread, intent: 'later', reviewAt: '2000-01-01', groupIds: ['old-group'], note: 'Keep my note' }], runtimeStates: new Map([[thread.id, 'running']]) }));
  assert.doesNotMatch(html, /Keep my note|note-preview/);
  assert.match(html, /data-state="running"/);
  assert.doesNotMatch(html, /稍后继续|回顾时间|分组|row-check|批量操作|draggable/);
});
test('navigation hides retired routes and archive counts while keeping primary view counts', () => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    const html = renderToStaticMarkup(createElement(Sidebar, { catalog: { threads: [thread], groups: [{ id: 'old-group', name: 'Old group', parentId: null }] }, view: 'all', onView: noop, onClose: noop, onSettings: noop, mobileOpen: false }));
    assert.doesNotMatch(html, /我的分组|我的安排|未分组|正在推进|稍后继续|留作参考|Old group|data-view="group"/);
    assert.match(html, /data-view="pinned"[^>]*>[\s\S]*?<small>0<\/small>/);
    assert.match(html, /data-view="recent"/);
    const archive = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes('<span>归档</span>'));
    assert.ok(archive);
    assert.doesNotMatch(archive, /<small>/);
  } finally { globalThis.matchMedia = previous; }
});
test('a busy modal makes the close affordance explicitly unavailable', () => {
  const html = renderToStaticMarkup(createElement(Modal, { title: 'Saving', busy: true, onClose: noop }, 'Content'));
  assert.match(html, /aria-busy="true"/);
  const close = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => match[1]).find(attributes => /aria-label="关闭对话框"/.test(attributes));
  assert.match(close, /disabled/);
});

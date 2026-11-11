import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { isMacBrowser } from '../src/browserPlatform.ts';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: TaskList }, { default: Inspector }, { Modal }, { default: Sidebar }] = await Promise.all([
  vite.ssrLoadModule('/src/TaskList.tsx'), vite.ssrLoadModule('/src/Inspector.tsx'), vite.ssrLoadModule('/src/Dialogs.tsx'), vite.ssrLoadModule('/src/Sidebar.tsx'),
]);
after(() => vite.close());
const thread = { id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', title: 'A conversation', archived: false, separator: false, missing: false, pinned: false, intent: 'none', groupIds: [], updatedAt: 1, createdAt: 1, revision: 0, note: '', reviewAt: null, projectName: 'Project', cwd: '/synthetic' };
const noop = () => {};
const listProps = { threads: [], selected: null, view: 'all', onSelect: noop, onOpen: noop, busy: false, query: '', onClearQuery: noop };

test('the information panel Mac shortcut distinguishes desktop Macs from phones, tablets and other systems', () => {
  const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
  for (const browser of [
    { platform: 'MacIntel', userAgent: macSafari, maxTouchPoints: 0 },
    { platform: 'MacIntel', userAgent: macSafari.replace('Version/18.0 Safari/605.1.15', 'Chrome/141.0.0.0 Safari/537.36'), maxTouchPoints: 0 },
    { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.0; rv:144.0) Gecko/20100101 Firefox/144.0', maxTouchPoints: 0 },
    { userAgent: macSafari, maxTouchPoints: 0 },
  ]) assert.equal(isMacBrowser(browser), true, JSON.stringify(browser));
  for (const browser of [
    { platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 },
    { platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', maxTouchPoints: 5 },
    { platform: 'MacIntel', userAgent: macSafari, maxTouchPoints: 5 },
    { platform: 'MacIntel', userAgent: macSafari, maxTouchPoints: 2 },
    { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)', maxTouchPoints: 1 },
    { platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/141.0.0.0 Mobile Safari/537.36', maxTouchPoints: 5 },
    { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0 },
    { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', maxTouchPoints: 0 },
    {}, undefined,
  ]) assert.equal(isMacBrowser(browser), false, JSON.stringify(browser));
});

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
test('navigation shows concise independent shortcuts and counts while keeping archive and machine controls quiet', () => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    const html = renderToStaticMarkup(createElement(Sidebar, { catalog: { threads: [thread], groups: [{ id: 'old-group', name: 'Old group', parentId: null }] }, view: 'all', onView: noop, onClose: noop, onSettings: noop, mobileOpen: false }));
    assert.doesNotMatch(html, /我的分组|我的安排|未分组|正在推进|稍后继续|留作参考|Old group|data-view="group"/);
    assert.doesNotMatch(html, /data-view="(?:pinned|recent|unread)"/);
    assert.deepEqual([...html.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]), ['all', 'priority', 'codex-pinned', 'hidden', 'archived']);
    for (const [name, count] of [['全部', 1], ['关注', 0], ['置顶', 0], ['隐藏', 0]]) {
      assert.ok(html.includes(`aria-label="${name}，${count} 个会话"`));
      assert.ok(html.includes(`<span>${name}</span><small class="sidebar-nav-count" aria-hidden="true">${count}</small>`));
    }
    assert.doesNotMatch(html, />全部会话<|>优先关注<|>Codex 置顶</);
    assert.doesNotMatch(html, /machine-picker|格得 Mac|豌豆 Mac|切换电脑/);
    const archive = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(button => button.includes('<span>已归档</span>'));
    assert.ok(archive);
    assert.doesNotMatch(archive, /<small\b|sidebar-nav-count|个会话/);
  } finally { globalThis.matchMedia = previous; }
});
test('project menu counts preserve distinct names and suffixes and show zero for empty projects', () => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    const name = 'A long project name that must remain accessible';
    const projects = ['one', 'two', 'empty'].map((id, order) => ({ id, name, paths: [`/workspace/${id}/app`], order, separator: false }));
    const html = renderToStaticMarkup(createElement(Sidebar, {
      catalog: { threads: [{ ...thread, projectId: 'one' }, { ...thread, id: 'second', projectId: null }, { ...thread, id: 'archived', archived: true, projectId: 'two' }], projects, groups: [] },
      view: 'running', project: '', onView: noop, onProject: noop, onClose: noop, onSettings: noop, mobileOpen: false,
    }));
    const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
    for (const [id, count] of [['one', 1], ['two', 0], ['empty', 0], ['__unassigned__', 1]]) {
      const button = buttons.find(value => value.includes(`data-project-id="${id}"`));
      assert.ok(button, id);
      assert.ok(button.includes(`<small class="sidebar-nav-count" aria-hidden="true">${count}</small>`), id);
      assert.ok(button.includes(`，${count} 个会话"`), id);
      if (id !== '__unassigned__') {
        assert.ok(button.includes(`${name}，/workspace/${id}/app`));
        assert.ok(button.includes(`<small class="sidebar-project-suffix">${id}/app</small>`));
      }
    }
  } finally { globalThis.matchMedia = previous; }
});
test('each independent shortcut is the only selected menu item even with a stale project scope', () => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    for (const view of ['priority', 'codex-pinned']) {
      const html = renderToStaticMarkup(createElement(Sidebar, {
        catalog: { threads: [{ ...thread, projectId: 'project-a' }], projects: [{ id: 'project-a', name: 'Project', paths: ['/synthetic'], order: 0, separator: false }], groups: [] },
        view, project: 'project-a', onView: noop, onProject: noop, onClose: noop, onSettings: noop, mobileOpen: false,
      }));
      const current = [...html.matchAll(/<button\b[^>]*aria-current="page"[^>]*>/g)].map(match => match[0]);
      assert.equal(current.length, 1, view);
      assert.match(current[0], new RegExp(`data-view="${view}"`));
    }
  } finally { globalThis.matchMedia = previous; }
});
test('recent creation uses the existing all-conversations or project navigation base', () => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    for (const project of ['', 'project-a']) {
      const html = renderToStaticMarkup(createElement(Sidebar, {
        catalog: { threads: [{ ...thread, projectId: 'project-a' }], projects: [{ id: 'project-a', name: 'Project', paths: ['/synthetic'], order: 0, separator: false }], groups: [] },
        view: 'created', project, onView: noop, onProject: noop, onClose: noop, onSettings: noop, mobileOpen: false,
      }));
      const current = [...html.matchAll(/<button\b[^>]*aria-current="page"[^>]*>/g)].map(match => match[0]);
      assert.equal(current.length, 1);
      assert.match(current[0], project ? /data-project-id="project-a"/ : /data-view="all"/);
      assert.doesNotMatch(html, /data-view="created"/);
    }
  } finally { globalThis.matchMedia = previous; }
});
test('a busy modal makes the close affordance explicitly unavailable', () => {
  const html = renderToStaticMarkup(createElement(Modal, { title: 'Saving', busy: true, onClose: noop }, 'Content'));
  assert.match(html, /aria-busy="true"/);
  const close = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => match[1]).find(attributes => /aria-label="关闭对话框"/.test(attributes));
  assert.match(close, /disabled/);
});

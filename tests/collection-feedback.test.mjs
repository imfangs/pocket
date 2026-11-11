import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: Feedback }, { default: Panel }, { default: TaskList }] = await Promise.all([
  vite.ssrLoadModule('/src/CollectionReadFeedback.tsx'), vite.ssrLoadModule('/src/TaskListPanel.tsx'), vite.ssrLoadModule('/src/TaskList.tsx'),
]);
after(() => vite.close());
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const feedback = extra => render(Feedback, { hasCatalog: true, pending: false, error: '', retry() {}, ...extra });

test('a transient cached-list failure stays a decorative line without an error row', () => {
  const html = feedback({ error: 'timeout' });
  assert.match(html, /collection-feedback/);
  assert.match(html, /collection-sync-line/);
  assert.match(html, /data-collection-feedback="waiting"/);
  assert.doesNotMatch(html, /collection-feedback-retry|role="alert"|error-banner|collection-load-state/);
});

test('active refresh replaces old failure instead of displaying both states', () => {
  const html = feedback({ pending: true, error: 'old failure' });
  assert.match(html, /正在同步列表/);
  assert.match(html, /data-loading="true"/);
  assert.doesNotMatch(html, /old failure|暂未更新|重试刷新/);
  assert.match(feedback(), /data-collection-feedback="idle"/);
});

test('cached runtime and catalog uncertainty share one fixed line, including a pending retry', () => {
  for (const pending of [false, true]) {
    const html = feedback({ stale: true, cachedStatus: true, cachedList: true, pending, error: 'weak network' });
    assert.equal((html.match(/class="collection-sync-line"/g) || []).length, 1);
    assert.match(html, /data-collection-feedback="(?:syncing|waiting)"/);
    assert.doesNotMatch(html, /weak network|正在刷新|暂未更新，显示上次列表|role="alert"/);
  }
  assert.doesNotMatch(feedback({ stale: true }), /上次确认/);
  assert.match(feedback({ cachedList: true }), /等待列表同步/);
});

test('first-load failure has a recovery state and never claims an empty successful list', () => {
  const html = feedback({ hasCatalog: false, error: '连接中断，请重试。' });
  assert.match(html, /collection-load-state/);
  assert.match(html, /暂时无法读取会话/);
  assert.match(html, /重新读取/);
  assert.doesNotMatch(html, /还没有会话|上次列表|正在读取/);
  const pending = feedback({ hasCatalog: false, pending: true, error: 'old failure' });
  assert.match(pending, /正在读取会话/);
  assert.doesNotMatch(pending, /old failure|暂时无法读取|重试刷新/);
});

test('the list panel keeps rows alongside its small read-feedback slot', () => {
  const html = render(Panel, { busy: false, onRefresh: async () => {},
    feedback: createElement(Feedback, { hasCatalog: true, pending: false, error: 'slow', retry() {} }),
    children: createElement('div', { role: 'list' }, 'Existing conversation') });
  assert.match(html, /collection-sync-line/);
  assert.match(html, /Existing conversation/);
});

test('confirmed persistent transport loss stays one actionable warning through its retry', () => {
  const readHealth = [{ pending: false, failures: 3, failingSince: -30001, reachableAt: null }];
  for (const pending of [false, true]) {
    const html = feedback({ readHealth, pending, syncPending: pending });
    assert.match(html, /data-collection-feedback="unreachable"/);
    assert.match(html, /连接暂未恢复，请重试/);
    assert.equal((html.match(/class="collection-feedback"/g) || []).length, 1);
    assert.match(html, /aria-label="重试刷新"/);
  }
});

test('runtime unavailability does not add another notice above an existing list', () => {
  const props = { threads: [{ id: 'one', title: 'Existing conversation', groupIds: [], createdAt: 1, updatedAt: 1 }],
    selected: null, view: 'all', query: '', busy: false, runtimeUnavailable: true,
    onSelect() {}, onOpen() {}, onClearQuery() {} };
  const html = render(TaskList, props);
  assert.match(html, /Existing conversation/);
  assert.doesNotMatch(html, /task-runtime-availability|运行状态暂不可用/);
  const empty = render(TaskList, { ...props, threads: [], activity: 'running', onClearFilters() {} });
  assert.match(empty, /运行状态暂时不可用/);
  assert.match(empty, /取消运行筛选/);
});

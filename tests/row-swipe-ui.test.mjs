import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: Row }, { default: TaskList }] = await Promise.all([vite.ssrLoadModule('/src/SwipeTaskRow.tsx'), vite.ssrLoadModule('/src/TaskList.tsx')]);
after(() => vite.close());
const noop = () => {};
const renderRow = props => renderToStaticMarkup(createElement(Row, { threadId: 'thread', title: 'Original task', pinned: false, className: 'task-row', open: false, disabled: false, pending: false,
  onPin: noop, onOpenChange: noop, onClaim: noop, onDismissError: noop, children: createElement('button', { className: 'task-select' }, 'Original task'), ...props }));

test('a closed row keeps a keyboard pin entry while its hidden blue action cannot be activated', () => {
  const html = renderRow({});
  assert.match(html, /class="row-pin-action" aria-hidden="true" tabindex="-1"[^>]*disabled/);
  assert.match(html, /class="row-pin-shortcut icon-button"[^>]*tabindex="0"/);
  assert.match(html, /aria-label="置顶 Original task"/);
  assert.match(html, /draggable="true"/);
});

test('the revealed action reflects the authoritative pinned value and pending state prevents repeated activation', () => {
  const html = renderRow({ open: true, pinned: true });
  assert.match(html, /aria-hidden="false" tabindex="0" aria-label="取消置顶 Original task"/);
  assert.match(html, />取消置顶<\/span>/);
  const pending = renderRow({ open: true, pending: true, disabled: true });
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /处理中…/);
  assert.match(pending, /class="row-pin-action"[^>]*disabled/);
});

test('a rejected action retains a visible error without pretending that the pin state changed', () => {
  const html = renderRow({ open: true, error: '原任务状态尚未确认，请稍后核对。' });
  assert.match(html, /role="alert"/);
  assert.match(html, /原任务状态尚未确认，请稍后核对。/);
  assert.match(html, />置顶<\/span>/);
  assert.doesNotMatch(html, /取消置顶/);
});

test('batch selection disables row actions while ordinary checkbox and row targets remain', () => {
  const thread = Object.freeze({ id: 'thread', title: 'Original task', pinned: false, intent: 'none', projectName: 'Project', updatedAt: 1, groupIds: [] });
  const html = renderToStaticMarkup(createElement(TaskList, { threads: [thread], groups: [], view: 'all', selecting: true, checked: new Set(), selected: null,
    onSelect: noop, onOpen: noop, onCheck: noop, onCheckAll: noop, onBatch: noop, onClear: noop, onPin: async () => {}, busy: false, query: '', onClearQuery: noop }));
  assert.match(html, /data-swipe-enabled="false"/);
  assert.match(html, /class="row-pin-shortcut icon-button"[^>]*disabled/);
  assert.match(html, /aria-label="选择 Original task"/);
  assert.match(html, /data-thread-id="thread"/);
  assert.equal(thread.pinned, false);
});

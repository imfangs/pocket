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
const renderRow = props => renderToStaticMarkup(createElement(Row, { threadId: 'thread', title: 'Original task', prioritized: false, className: 'task-row', open: false, disabled: false, pending: false,
  onPriority: noop, onOpenChange: noop, onClaim: noop, onDismissError: noop, children: createElement('button', { className: 'task-select' }, 'Original task'), ...props }));

test('a closed row keeps a keyboard priority entry while its hidden blue action cannot be activated', () => {
  const html = renderRow({});
  assert.match(html, /class="row-priority-action" aria-hidden="true" tabindex="-1"[^>]*disabled/);
  assert.match(html, /class="row-priority-shortcut icon-button"[^>]*tabindex="0"/);
  assert.match(html, /aria-label="优先关注 Original task"/);
  assert.doesNotMatch(html, /draggable/);
});

test('the revealed action reflects the authoritative Pocket priority value and pending state prevents repeated activation', () => {
  const html = renderRow({ open: true, prioritized: true });
  assert.match(html, /aria-hidden="false" tabindex="0" aria-label="取消关注 Original task"/);
  assert.match(html, />取消关注<\/span>/);
  const pending = renderRow({ open: true, pending: true, disabled: true });
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /处理中…/);
  assert.match(pending, /class="row-priority-action"[^>]*disabled/);
});

test('a rejected action retains a visible error without pretending that the Pocket priority changed', () => {
  const html = renderRow({ open: true, error: '原任务状态尚未确认，请稍后核对。' });
  assert.match(html, /role="alert"/);
  assert.match(html, /原任务状态尚未确认，请稍后核对。/);
  assert.match(html, />优先关注<\/span>/);
  assert.doesNotMatch(html, /取消关注/);
});

test('a second hidden action has a separate keyboard entry and fits beside priority', () => {
  const html = renderRow({ onHidden: noop });
  assert.match(html, /class="row-swipe-actions" style="width:168px"/);
  assert.match(html, /class="row-hidden-action" aria-hidden="true" tabindex="-1"[^>]*disabled/);
  assert.match(html, /class="row-hidden-shortcut icon-button"[^>]*aria-label="隐藏 Original task"[^>]*tabindex="0"/);
  assert.match(html, /aria-label="优先关注 Original task"/);
  const hiddenOnly = renderRow({ onPriority: undefined, onHidden: noop });
  assert.match(hiddenOnly, /class="row-swipe-actions" style="width:84px"/);
  assert.doesNotMatch(hiddenOnly, /row-priority-action|row-priority-shortcut/);
});

test('hidden rows can be restored without changing their independent priority action', () => {
  const html = renderRow({ onHidden: noop, hidden: true, open: true, prioritized: true });
  assert.match(html, /class="row-hidden-action" aria-hidden="false" tabindex="0" aria-label="取消隐藏 Original task"/);
  assert.match(html, />取消隐藏<\/span>/);
  assert.match(html, /aria-label="取消关注 Original task"/);
  const pending = renderRow({ onHidden: noop, hidden: false, open: true, pending: true, pendingAction: 'hidden', disabled: true });
  assert.match(pending, /class="row-hidden-action"[^>]*disabled/);
  assert.match(pending, /class="row-priority-action"[^>]*disabled/);
  assert.equal((pending.match(/处理中…/g) || []).length, 1);
  assert.match(pending, />优先关注<\/span>/);
});

test('rows retain swipe and keyboard priority actions with no retired batch selection', () => {
  const thread = Object.freeze({ id: 'thread', title: 'Original task', pinned: false, intent: 'none', projectName: 'Project', updatedAt: 1, groupIds: [] });
  const html = renderToStaticMarkup(createElement(TaskList, { threads: [thread], view: 'all', selected: null,
    onSelect: noop, onOpen: noop, onPriority: async () => {}, busy: false, query: '', onClearQuery: noop }));
  assert.match(html, /data-swipe-enabled="true"/);
  assert.match(html, /class="row-priority-shortcut icon-button"[^>]*tabindex="0"/);
  assert.doesNotMatch(html, /aria-label="选择 Original task"|批量操作|row-check|draggable/);
  assert.match(html, /data-thread-id="thread"/);
  assert.equal(thread.pinned, false);
});

const priorityThread = Object.freeze({ id: 'priority-thread', title: 'Independent states', pinned: false,
  intent: 'none', projectName: 'Project', updatedAt: 1, groupIds: [] });
const renderPriorityList = (fields, view = 'all') => renderToStaticMarkup(createElement(TaskList, {
  threads: [{ ...priorityThread, ...fields }], view, selected: null,
  onSelect: noop, onOpen: noop, onPriority: async () => {}, busy: false, query: '', onClearQuery: noop,
}));

test('Pocket priority and Codex pin render independently in every combination', () => {
  for (const pocketPriority of [false, true]) for (const codexPinned of [false, true]) {
    // The effective legacy pin is true for either state, so using it to label
    // the Pocket action would incorrectly show cancel on a Codex-only pin.
    const fields = { pocketPriority, codexPinned, pinned: pocketPriority || codexPinned,
      pinSource: pocketPriority ? 'pocket' : 'codex' };
    for (const view of ['all', 'pinned', 'archived']) {
      const html = renderPriorityList(fields, view);
      assert.match(html, new RegExp(`data-row-priority="${pocketPriority}"`));
      assert.match(html, new RegExp(`aria-label="${pocketPriority ? '取消关注' : '优先关注'} Independent states"`));
      assert.equal((html.match(/aria-label="Pocket 优先关注"/g) || []).length, pocketPriority ? 1 : 0);
      assert.equal((html.match(/aria-label="Codex 置顶"/g) || []).length, codexPinned ? 1 : 0);
      if (pocketPriority) assert.match(html, /class="[^"]*lucide-star[^>]*role="img"[^>]*aria-label="Pocket 优先关注"/);
      if (codexPinned) assert.match(html, /class="[^"]*lucide-pin[^>]*role="img"[^>]*aria-label="Codex 置顶"/);
      assert.doesNotMatch(html, /取消置顶/);
    }
  }
});

test('cancelling Pocket priority removes only the star while Codex keeps its own pin', () => {
  const before = { pocketPriority: true, codexPinned: true, pinned: true, pinSource: 'pocket' };
  const after = { ...before, pocketPriority: false, pinSource: 'codex' };
  const html = renderPriorityList(after);
  assert.doesNotMatch(html, /aria-label="Pocket 优先关注"/);
  assert.match(html, /aria-label="Codex 置顶"/);
  assert.match(html, /aria-label="优先关注 Independent states"/);
  assert.equal(before.pocketPriority, true);
  assert.equal(after.codexPinned, true);
});

test('explicit new fields take precedence over stale legacy pin presentation', () => {
  const html = renderPriorityList({ pocketPriority: false, codexPinned: true, pinned: true, pinSource: 'pocket' });
  assert.doesNotMatch(html, /aria-label="Pocket 优先关注"/);
  assert.match(html, /aria-label="Codex 置顶"/);
  assert.match(html, /aria-label="优先关注 Independent states"/);
});

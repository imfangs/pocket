import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
  esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: TaskList }, { default: ThreadAutomations, ThreadAutomationsContent }] = await Promise.all([
  vite.ssrLoadModule('/src/TaskList.tsx'), vite.ssrLoadModule('/src/ThreadAutomations.tsx'),
]);
after(() => vite.close());
const noop = () => {};
const thread = { id: 'synthetic-thread', hostId: 'synthetic-host', title: '定时整理资料', projectName: 'Project',
  archived: false, pinned: false, createdAt: 1, updatedAt: 1, lastMessageAt: 1, groupIds: [], intent: 'active' };
const listProps = { selected: null, view: 'all', onSelect: noop, onOpen: noop, busy: false, query: '', onClearQuery: noop };
const renderList = (threads, extra = {}) => renderToStaticMarkup(createElement(TaskList, { ...listProps, threads, ...extra }));
const automation = { id: 'plan-one', name: '每天整理', prompt: '阅读当天的进展，整理成简报。', status: 'ACTIVE',
  scheduleLabel: '每天 09:00', scheduleSupported: true };
const source = { available: true, stale: false, timeZone: 'Asia/Shanghai', automations: [automation] };
const renderContent = (extra = {}) => renderToStaticMarkup(createElement(ThreadAutomationsContent, { source, onRetry: noop, ...extra }));

test('only explicit positive automation summaries add a list icon', () => {
  for (const automationSummary of [undefined, { count: 0, activeCount: 0, pausedCount: 0 }, { count: -1, activeCount: 0, pausedCount: 0 }]) {
    assert.doesNotMatch(renderList([{ ...thread, automationSummary }]), /data-list-status="automation"/);
  }
  const html = renderList([{ ...thread, automationSummary: { count: 1, activeCount: 1, pausedCount: 0 } }]);
  assert.match(html, /data-automation-state="active"/);
  assert.match(html, /role="img" aria-label="定时任务：1 个，1 个已启用" title="定时任务：1 个，1 个已启用"/);
  assert.match(html, /lucide-clock/);
});

test('paused, mixed, unknown, and stale plans remain visible with truthful labels', () => {
  const paused = renderList([{ ...thread, automationSummary: { count: 2, activeCount: 0, pausedCount: 2 } }]);
  assert.match(paused, /data-automation-state="paused"/);
  assert.match(paused, /lucide-alarm-clock-off/);
  assert.match(paused, /2 个已暂停/);
  const mixed = renderList([{ ...thread, automationSummary: { count: 3, activeCount: 1, pausedCount: 1, stale: true } }]);
  assert.match(mixed, /data-automation-state="active" data-automation-stale="true"/);
  assert.match(mixed, /1 个已启用，1 个已暂停，部分状态待确认；缓存可能已过期/);
  const unknown = renderList([{ ...thread, automationSummary: { count: 1, activeCount: 0, pausedCount: 0 } }]);
  assert.match(unknown, /data-automation-state="unknown"/);
  assert.doesNotMatch(unknown, /已暂停|已启用/);
});

test('clock, red priority, purple pin, running state, and caller ordering coexist', () => {
  const marked = { ...thread, pocketPriority: true, codexPinned: true,
    automationSummary: { count: 1, activeCount: 1, pausedCount: 0 } };
  const html = renderList([{ ...thread, id: 'first', title: '保持前排' }, marked],
    { runtimeStates: new Map([[thread.id, 'running']]) });
  assert.match(html, /aria-label="Pocket 优先关注"/);
  assert.match(html, /aria-label="Codex 置顶"/);
  assert.match(html, /data-state="running">运行中/);
  assert.equal((html.match(/data-list-status="automation"/g) || []).length, 1);
  assert.ok(html.indexOf('data-thread-id="first"') < html.indexOf(`data-thread-id="${thread.id}"`));
});

test('details show multiple names, independent statuses, and human schedule labels', () => {
  const html = renderContent({ source: { ...source, automations: [automation,
    { ...automation, id: 'plan-two', name: '每周回顾', status: 'PAUSED', scheduleLabel: '每周五 18:00' },
    { ...automation, id: 'plan-three', name: '待确认计划', status: 'UNKNOWN', scheduleSupported: false, scheduleLabel: '暂不支持展示此执行安排' },
  ] } });
  assert.match(html, /每天整理/); assert.match(html, /每天 09:00/);
  assert.match(html, /每周回顾/); assert.match(html, /每周五 18:00/);
  assert.match(html, /data-status="ACTIVE">已启用/);
  assert.match(html, /data-status="PAUSED">已暂停/);
  assert.match(html, /data-status="UNKNOWN">状态待确认/);
  assert.match(html, /暂不支持展示此执行安排/);
  assert.doesNotMatch(html, /启用任务|暂停任务|编辑|删除|RRULE|FREQ=/);
});

test('prompt content is collapsed plain text with no HTML execution or truncation', () => {
  const prompt = '<img src=x onerror="alert(1)">\n<script>bad()</script>\n' + '保留完整任务内容。'.repeat(300);
  const html = renderContent({ source: { ...source, automations: [{ ...automation, name: '<b>原始名字</b>', prompt }] } });
  assert.match(html, /&lt;b&gt;原始名字&lt;\/b&gt;/);
  assert.match(html, /&lt;img src=x onerror=/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /<details class="thread-automation-content"><summary>任务内容<\/summary>/);
  assert.doesNotMatch(html, /<script|<img|<details[^>]*\sopen\b/);
  assert.equal((html.match(/保留完整任务内容。/g) || []).length, 300);
});

test('loading and unavailable results never turn into a no-plan claim', () => {
  const loading = renderToStaticMarkup(createElement(ThreadAutomations, { thread }));
  assert.match(loading, /aria-busy="true"/); assert.match(loading, /正在读取/);
  assert.doesNotMatch(loading, /暂无关联/);
  for (const extra of [
    { source: null, error: '暂时无法读取定时任务，请重试。' },
    { source: { ...source, available: false, automations: [] } },
    { source: { ...source, stale: true, automations: [] } },
  ]) {
    const html = renderContent(extra);
    assert.doesNotMatch(html, /暂无关联/);
    assert.match(html, /重新读取/);
  }
  assert.match(renderContent({ source: { ...source, automations: [] } }), /暂无关联的定时任务/);
});

test('cache and failed-refresh states label retained plans and preserve their contents', () => {
  for (const extra of [{ source: { ...source, stale: true } }, { source: { ...source, available: false, stale: true } },
    { error: '读取超时，请重试。' }]) {
    const html = renderContent(extra);
    assert.match(html, /以下为缓存内容/);
    assert.match(html, /data-stale="true"/);
    assert.match(html, /每天整理/); assert.match(html, /阅读当天的进展/);
    assert.match(html, /重新读取/);
    assert.doesNotMatch(html, /暂无关联/);
  }
  const refreshing = renderContent({ source: { ...source, stale: true }, loading: true });
  assert.match(refreshing, /正在刷新/); assert.match(refreshing, /disabled=""/);
});

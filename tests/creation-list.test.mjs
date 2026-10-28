import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { creationCue, creationNeedsAttention, withCreatedThread } from '../src/creationList.ts';

const operation = (status = 'succeeded', initialStatus) => ({
  requestId: 'create-request', operation: 'create', status,
  threadId: 'native-thread', creationStatus: 'created', createdAt: Date.now(),
  ...(initialStatus ? { initialMessage: { requestId: 'first-request', status: initialStatus } } : {}),
});

test('only a successful lifecycle with no first message or an accepted first message is confirmed', () => {
  for (const status of ['pending', 'waiting', 'unknown', 'rejected', 'changed']) {
    for (const initialStatus of [undefined, 'queued', 'pending', 'accepted']) {
      const value = operation(status, initialStatus);
      assert.notEqual(creationCue(value)?.phase, 'confirmed', `${status}/${initialStatus}`);
      assert.equal(creationCue(value)?.requestId, value.requestId);
    }
  }
  for (const initialStatus of [undefined, 'accepted'])
    assert.equal(creationCue(operation('succeeded', initialStatus)).phase, 'confirmed');
  for (const initialStatus of ['queued', 'pending', 'unknown', 'rejected', 'not_queued', 'editing', 'cancelled', 'future-status'])
    assert.notEqual(creationCue(operation('succeeded', initialStatus))?.phase, 'confirmed', initialStatus);
  assert.notEqual(creationCue({ ...operation(), initialMessage: { requestId: 'first-request' } }).phase, 'confirmed');
});

test('normal creation and sending progress stay local to the row; read errors and uncertain results need attention', () => {
  assert.deepEqual(creationCue(operation('pending')), { requestId: 'create-request', phase: 'pending', label: '创建中' });
  assert.equal(creationCue(operation('waiting')).label, '创建中');
  for (const [initialStatus, label] of [['queued', '待发送'], ['pending', '发送中']]) {
    const value = operation('succeeded', initialStatus);
    assert.deepEqual(creationCue(value), { requestId: 'create-request', phase: 'pending', label });
    assert.equal(creationNeedsAttention(value), false);
    assert.equal(creationNeedsAttention(value, '暂时无法核对'), true);
  }
  for (const status of ['unknown', 'rejected', 'changed']) {
    assert.equal(creationCue(operation(status)).label, '待核对');
    assert.equal(creationNeedsAttention(operation(status)), true);
  }
  for (const initialStatus of ['unknown', 'rejected', 'not_queued']) {
    assert.equal(creationCue(operation('succeeded', initialStatus)).phase, 'attention');
    assert.equal(creationNeedsAttention(operation('succeeded', initialStatus)), true);
  }
});

test('paused messages remain actionable while a cancelled first message exits creation tracking', () => {
  for (const [initialStatus, label] of [['editing', '已暂停']]) {
    const value = operation('succeeded', initialStatus);
    assert.deepEqual(creationCue(value), { requestId: 'create-request', phase: 'attention', label });
    assert.equal(creationNeedsAttention(value), false);
  }
  assert.equal(creationCue(operation('succeeded', 'cancelled')), null);
  assert.equal(creationNeedsAttention(operation('succeeded', 'cancelled')), false);
  for (const value of [operation('cancelled'), { ...operation('unknown'), operation: 'archive' }, { ...operation('unknown'), operation: 'restore' }]) {
    assert.equal(creationCue(value), null);
    assert.equal(creationNeedsAttention(value, '读取失败'), false);
  }
});

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
  esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: TaskList } = await vite.ssrLoadModule('/src/TaskList.tsx');
const { default: CreationPendingRows } = await vite.ssrLoadModule('/src/CreationPendingRows.tsx');
after(() => vite.close());
const noop = () => {};
const thread = { id: 'native-thread', title: '新会话', projectName: 'Project', cwd: '/synthetic',
  archived: false, separator: false, missing: false, sourceExcluded: false, needsInput: false,
  pinned: true, pinSource: 'codex', pocketPriority: true, pinnedOrder: 0, priorityOrder: 0,
  intent: 'active', groupIds: [], createdAt: Date.now() - 1000, updatedAt: 1, lastMessageAt: 1,
  revision: 0, note: '', reviewAt: null };
const props = { threads: [thread], selected: null, view: 'all', query: '', busy: false,
  onSelect: noop, onOpen: noop, onClearQuery: noop, onPriority: noop };

test('late creation metadata cannot unarchive or reintroduce a source-excluded conversation', () => {
  const receipt = { ...operation(), thread: { ...thread, archived: false } };
  for (const current of [{ ...thread, archived: true }, { ...thread, missing: true }, { ...thread, sourceExcluded: true }]) {
    const catalog = { threads: [current] };
    assert.equal(withCreatedThread(catalog, receipt), catalog);
  }
  for (const exclusion of [{ excludedThreadIds: [thread.id] }, { excludedThreadStates: [{ id: thread.id, archived: true }] }]) {
    const catalog = { threads: [], ...exclusion };
    assert.equal(withCreatedThread(catalog, receipt), catalog);
  }
  assert.deepEqual(withCreatedThread({ threads: [] }, receipt).threads, [receipt.thread]);
});
const renderList = (value, extra = {}) => renderToStaticMarkup(createElement(TaskList, {
  ...props, creationCues: new Map([['native-thread', creationCue(value)]]), ...extra,
}));

test('queued or uncertain creation suppresses recent green and native primary activity while preserving real row actions', () => {
  for (const initialStatus of ['queued', 'pending', 'unknown', 'editing']) {
    for (const runtime of ['running', 'waiting_input', 'waiting_approval']) {
      const value = operation('succeeded', initialStatus);
      const html = renderList(value, { runtimeStates: new Map([['native-thread', runtime]]) });
      assert.doesNotMatch(html, /is-recently-created|5 分钟内新建/);
      assert.doesNotMatch(html, /data-state="(?:running|waiting_input|waiting_approval)"/);
      assert.match(html, /data-thread-id="native-thread"/);
      assert.match(html, /data-swipe-row-id="native-thread"/);
      assert.match(html, /data-creation-request-id="create-request"/);
      assert.match(html, new RegExp(`data-creation-state="${creationCue(value).phase}"`));
      assert.match(html, new RegExp(creationCue(value).label));
      assert.match(html, /data-row-action="priority"/);
      assert.match(html, /data-pin-source="codex"/);
      assert.match(html, /在 Codex 打开 新会话/);
    }
  }
});

test('confirmation restores native activity and the existing recent-creation styling', () => {
  for (const initialStatus of [undefined, 'accepted']) {
    for (const runtime of ['running', 'waiting_input', 'waiting_approval']) {
      const html = renderList(operation('succeeded', initialStatus), { runtimeStates: new Map([['native-thread', runtime]]) });
      assert.match(html, /is-recently-created/);
      assert.match(html, new RegExp(`data-state="${runtime}"`));
      assert.match(html, /data-creation-state="confirmed"/);
      assert.doesNotMatch(html, /creation-state-label/);
    }
  }
  const unrelated = renderList(operation('succeeded', 'queued'), { creationCues: new Map([['different-thread', creationCue(operation('unknown'))]]) });
  assert.match(unrelated, /is-recently-created/);
  assert.doesNotMatch(unrelated, /data-creation-request-id/);
});

test('pending placeholders have request identity without pretending to be real threads or offering an open action', () => {
  const value = { requestId: 'request-only', operation: 'create', status: 'pending' };
  const html = renderToStaticMarkup(createElement(CreationPendingRows, { onOpen: noop, onReview: noop,
    items: [{ operation: value, title: '正在准备的会话', projectName: '无项目', cue: creationCue(value), canOpen: false }] }));
  assert.match(html, /data-creation-request-id="request-only"/);
  assert.match(html, /data-creation-action="wait" disabled=""/);
  assert.match(html, /创建中/); assert.match(html, /独立会话/);
  assert.doesNotMatch(html, /data-thread-id|data-swipe-row-id|data-row-motion-id|<h[1-6]\b/);
});

test('placeholder recovery and opening are enabled only through explicit capability', () => {
  for (const [canOpen, status, action, disabled] of [[false, 'unknown', 'review', false], [true, 'pending', 'open', false], [false, 'succeeded', 'wait', true]]) {
    const value = operation(status);
    const html = renderToStaticMarkup(createElement(CreationPendingRows, { onOpen: noop, onReview: noop,
      items: [{ operation: value, title: '新会话', cue: creationCue(value), canOpen }] }));
    assert.match(html, new RegExp(`data-creation-action="${action}"`));
    assert.equal(/disabled=""/.test(html), disabled);
  }
  assert.equal(renderToStaticMarkup(createElement(CreationPendingRows, { items: [], onOpen: noop, onReview: noop })), '');
});

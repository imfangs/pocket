import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { startTaskStatusPolling, taskStatusMap } from '../src/taskStatuses.ts';
import { threadListStates } from '../src/listPresentation.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const response = (status = 'running', checkedAt = 9000000000000) => ({ available: true, checkedAt,
  states: [{ threadId: 'thread', status, checkedAt }] });
function fixture(request, options = {}) {
  const browser = new EventTarget(), visibility = new EventTarget(), timers = new Map();
  let now = 0, sequence = 0;
  Object.assign(browser, { navigator: { onLine: true },
    setTimeout: (fn, delay) => { timers.set(++sequence, { fn, at: now + delay }); return sequence; },
    clearTimeout: id => timers.delete(id) });
  visibility.visibilityState = 'visible';
  const views = [];
  const polling = startTaskStatusPolling({ request, onChange: value => views.push(value), browser, visibility, now: () => now, ...options });
  async function advance(ms) {
    const until = now + ms;
    await setImmediate();
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await setImmediate();
    }
    now = until;
  }
  return { browser, visibility, timers, polling, views, advance, last: () => views.at(-1), jump: value => { now = value; } };
}

test('the status contract never interprets unavailable, duplicate, or malformed data as idle', () => {
  assert.equal(taskStatusMap({ ...response(), available: false }), null);
  assert.equal(taskStatusMap({ ...response(), states: [...response().states, ...response().states] }), null);
  assert.equal(taskStatusMap(response('not-a-status')), null);
  assert.equal(taskStatusMap({ ...response(), checkedAt: null }), null);
  assert.equal(taskStatusMap(response('unknown')).get('thread'), 'unknown');
  assert.equal(taskStatusMap({ ...response(), states: [] }).size, 0);
});

test('one foreground collection is shared and the next request starts ten seconds after completion', async () => {
  let calls = 0, finish;
  const f = fixture(() => {
    calls++;
    if (calls === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve(response('idle'));
  });
  await f.advance(0);
  void f.polling.refresh(); void f.polling.refresh();
  await f.advance(5000); assert.equal(calls, 1);
  finish(response()); await f.advance(0);
  assert.equal(f.last().runtimeStates.get('thread'), 'running');
  await f.advance(9999); assert.equal(calls, 1);
  await f.advance(1); assert.equal(calls, 2);
  assert.equal(f.last().runtimeStates.get('thread'), 'idle');
  f.polling.stop();
});

test('hidden and offline pages clear prior running markers immediately and resume with a fresh read', async () => {
  for (const mode of ['hidden', 'offline']) {
    let calls = 0;
    const f = fixture(async () => { calls++; return response(); });
    await f.advance(0); assert.equal(f.last().runtimeStates.get('thread'), 'running');
    if (mode === 'hidden') { f.visibility.visibilityState = 'hidden'; f.visibility.dispatchEvent(new Event('visibilitychange')); }
    else { f.browser.navigator.onLine = false; f.browser.dispatchEvent(new Event('offline')); }
    assert.equal(f.last().runtimeUnavailable, true); assert.equal(f.last().runtimeStates.size, 0);
    await f.advance(60000); assert.equal(calls, 1);
    if (mode === 'hidden') { f.visibility.visibilityState = 'visible'; f.visibility.dispatchEvent(new Event('visibilitychange')); }
    else { f.browser.navigator.onLine = true; f.browser.dispatchEvent(new Event('online')); }
    await f.advance(0); assert.equal(calls, 2); assert.equal(f.last().runtimeUnavailable, false);
    f.polling.stop();
  }
});

test('failures and server unavailability remove old running data instead of keeping a green badge', async () => {
  for (const failure of ['throw', 'unavailable']) {
    let calls = 0;
    const f = fixture(async () => {
      if (++calls === 1) return response();
      if (failure === 'throw') throw new Error('Network failed');
      return { ...response(), available: false };
    });
    await f.advance(10000);
    assert.equal(calls, 2); assert.equal(f.last().runtimeUnavailable, true); assert.equal(f.last().runtimeStates.size, 0);
    f.polling.stop();
  }
});

test('an eighteen-second timeout invalidates the last success and a late response cannot revive it', async () => {
  let calls = 0, finish, signal;
  const f = fixture(current => {
    if (++calls === 1) return Promise.resolve(response());
    signal = current; return new Promise(resolve => { finish = resolve; });
  });
  await f.advance(27999); assert.equal(f.last().runtimeUnavailable, false);
  await f.advance(1); assert.equal(signal.aborted, true); assert.equal(f.last().runtimeUnavailable, true);
  finish(response()); await f.advance(0);
  assert.equal(f.last().runtimeStates.size, 0);
  f.polling.stop();
});

test('receipt-time expiry is independent of the server clock and still fires while a request is stalled', async () => {
  let calls = 0, finish;
  const f = fixture(() => ++calls === 1 ? Promise.resolve(response('running', 9000000000000))
    : new Promise(resolve => { finish = resolve; }), { timeoutMs: 60000 });
  await f.advance(29999); assert.equal(f.last().runtimeStates.get('thread'), 'running');
  await f.advance(1); assert.equal(f.last().runtimeUnavailable, true); assert.equal(f.last().runtimeStates.size, 0);
  f.polling.stop(); finish(response()); await setImmediate();
});

test('a response arriving after suspended timers cannot reset its own expired request deadline', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  await f.advance(0);
  f.jump(19000); finish(response()); await setImmediate();
  assert.equal(f.last().runtimeUnavailable, true); assert.equal(f.last().runtimeStates.size, 0);
  f.polling.stop();
});

test('leaving cancels in-flight reads; returning cannot overlap them or accept their late result', async () => {
  let calls = 0, finish, signal;
  const f = fixture(current => {
    calls++;
    if (calls === 1) { signal = current; return new Promise(resolve => { finish = resolve; }); }
    return Promise.resolve(response('waiting_input'));
  });
  await f.advance(0);
  f.visibility.visibilityState = 'hidden'; f.visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(signal.aborted, true);
  f.visibility.visibilityState = 'visible'; f.visibility.dispatchEvent(new Event('visibilitychange'));
  await f.advance(0); assert.equal(calls, 1);
  finish(response('running')); await f.advance(0);
  assert.equal(calls, 2); assert.equal(f.last().runtimeStates.get('thread'), 'waiting_input');
  assert.equal(f.views.some(view => view.runtimeStates.get('thread') === 'running'), false);
  f.polling.stop(); assert.equal(f.timers.size, 0);
});

test('unmount cancels the request and prevents late state updates', async () => {
  let finish, signal;
  const f = fixture(current => { signal = current; return new Promise(resolve => { finish = resolve; }); });
  await f.advance(0); f.polling.stop(); const count = f.views.length;
  assert.equal(signal.aborted, true); finish(response()); await f.advance(60000);
  assert.equal(f.views.length, count); assert.equal(f.timers.size, 0);
});

const thread = Object.freeze({ id: 'thread', title: 'Conversation', archived: false, separator: false, missing: false,
  pinned: false, intent: 'active', groupIds: [], updatedAt: 1, createdAt: 1, revision: 0, note: 'Keep the note',
  reviewAt: null, projectName: 'Project', cwd: '/synthetic', needsInput: true });
test('native activity replaces stale unread while drafts coexist, and archived or missing rows never run', () => {
  for (const status of ['running', 'waiting_input', 'waiting_approval']) {
    assert.deepEqual(threadListStates(thread, true, status).map(item => item.key), ['draft', status]);
    assert.deepEqual(threadListStates({ ...thread, archived: true }, false, status).map(item => item.key), ['archived']);
    assert.deepEqual(threadListStates({ ...thread, missing: true }, false, status).map(item => item.key), ['missing']);
  }
  assert.deepEqual(threadListStates(thread, false, 'idle').map(item => item.key), ['unread']);
  assert.deepEqual(threadListStates(thread, true, 'unknown').map(item => item.key), ['draft', 'unknown', 'unread']);
  assert.deepEqual(threadListStates({ ...thread, needsInput: false }, false).map(item => item.key), []);
  assert.equal(thread.intent, 'active');
});

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: TaskList } = await vite.ssrLoadModule('/src/TaskList.tsx');
after(() => vite.close());
const noop = () => {};
const props = { threads: [thread], groups: [], selected: null, view: 'all', checked: new Set(), onSelect: noop, onOpen: noop,
  onCheck: noop, onCheckAll: noop, onBatch: noop, onClear: noop, busy: false, query: '', onClearQuery: noop };
test('the list renders running separately from manual intent, and failure is not presented as all idle', () => {
  const states = new Map([['thread', 'running']]);
  const active = renderToStaticMarkup(createElement(TaskList, { ...props, runtimeStates: states, draftIds: new Set(['thread']) }));
  assert.match(active, /推进中/); assert.match(active, /data-state="running">运行中/);
  assert.match(active, /data-state="draft"/); assert.doesNotMatch(active, /data-state="unread"/);
  const failed = renderToStaticMarkup(createElement(TaskList, { ...props, runtimeStates: states, runtimeUnavailable: true }));
  assert.match(failed, /运行状态暂不可用/); assert.doesNotMatch(failed, /data-state="running"|空闲/);
  const loading = renderToStaticMarkup(createElement(TaskList, { ...props, runtimeStates: states, runtimeLoading: true }));
  assert.doesNotMatch(loading, /正在读取运行状态|data-state="running"|空闲/);
  const unknown = renderToStaticMarkup(createElement(TaskList, { ...props, runtimeStates: new Map([['thread', 'unknown']]) }));
  assert.match(unknown, /data-state="unknown">状态待确认/); assert.match(unknown, /data-state="unread"/);
  const unobserved = renderToStaticMarkup(createElement(TaskList, { ...props, runtimeStates: new Map() }));
  assert.doesNotMatch(unobserved, /状态待确认/);
});

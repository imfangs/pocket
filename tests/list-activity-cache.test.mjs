import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createListActivityCache, listActivityCacheLimit } from '../src/listActivityCache.ts';
import { startTaskStatusPolling, taskStatusMap } from '../src/taskStatuses.ts';
import { filterThreads } from '../src/model.ts';
import { navigationActivityCounts, normalizeNavigationPrefs } from '../src/navigationModel.ts';
import { threadListStates } from '../src/listPresentation.ts';
import { smartThreadScore } from '../src/smartOrder.ts';
import { conversationIsWorking } from '../src/conversationWorking.ts';

const now = Date.UTC(2026, 10, 10);
const rows = [
  { id: 'running', title: 'Running', pocketUnread: true, hasUnreadTurn: true, needsInput: true,
    createdAt: now - 1000, lastMessageAt: now - 1000, updatedAt: now - 1000, groupIds: [] },
  { id: 'unread', title: 'Unread', pocketUnread: true, hasUnreadTurn: true, needsInput: true,
    createdAt: now - 1000, lastMessageAt: now - 1000, updatedAt: now - 1000, groupIds: [] },
];
const response = (status = 'running', checkedAt = now, threadId = 'running', rowAt = checkedAt) => ({ available: true, checkedAt,
  states: [{ threadId, status, checkedAt: rowAt }] });
const fresh = value => ({ runtimeStates: taskStatusMap(value), runtimeUnavailable: false, runtimeLoading: false });
const failed = { runtimeStates: new Map(), runtimeUnavailable: true, runtimeLoading: false };
const loading = { runtimeStates: new Map(), runtimeUnavailable: false, runtimeLoading: true };
const native = patch => ({ source: 'desktop', resumeState: 'resumed', checkedAt: now + 100,
  runtime: 'active', canSend: true, activeTurnId: 'current', latestTurnStatus: 'inProgress',
  messages: [{ id: 'message', role: 'user', text: 'test', turnId: 'current' }], pendingRequests: [], hint: '', ...patch });
const cache = () => { const result = createListActivityCache('ged', 'source-a', () => now + 1000); result.update(rows); return result; };
function presentation(states, draftIds, pocketActivity) {
  const prefs = normalizeNavigationPrefs(null);
  return { order: filterThreads(rows, 'all', '', '', 'smart', states, { now, draftIds, pocketActivity }).map(row => row.id),
    counts: navigationActivityCounts(rows, prefs, '', states),
    running: filterThreads(rows, 'all', '', '', 'smart', states, { now }, 'running').map(row => row.id),
    unread: filterThreads(rows, 'all', '', '', 'smart', states, { now }, 'unread').map(row => row.id),
    badges: threadListStates(rows[0], false, states.get('running')).map(item => item.key),
    score: smartThreadScore(rows[0], { now, runtimeStates: states }) };
}

test('weak reads preserve list badge, count, filter and rank while fresh runtime stays empty', () => {
  const c = cache(), value = response(); c.observe(value);
  const before = presentation(c.project(fresh(value)).listRuntimeStates);
  for (const view of [failed, loading]) {
    const projected = c.project(view);
    assert.deepEqual(presentation(projected.listRuntimeStates), before);
    assert.equal(projected.listRuntimeStale, true);
    assert.equal(projected.listRuntimeCached, true);
    assert.equal(view.runtimeStates.size, 0, 'the execution/prefetch feed is not revived');
  }
  assert.deepEqual(before.counts, { unread: 1, running: 1 });
  assert.deepEqual(before.badges, ['running']);
  const next = response('idle', now + 1); c.observe(next);
  const ended = c.project(fresh(next));
  assert.equal(ended.listRuntimeStale, false);
  assert.deepEqual(presentation(ended.listRuntimeStates).counts, { unread: 2, running: 0 });
  assert.deepEqual(presentation(ended.listRuntimeStates).badges, ['unread']);
  assert.notDeepEqual(presentation(ended.listRuntimeStates).order, before.order);
  assert.equal(rows[0].pocketUnread, true, 'list state never consumes unread content');
});

test('unknown, absent and a retry loading state keep confirmed activity until explicit native facts arrive', () => {
  for (const status of ['running', 'waiting_input', 'waiting_approval']) {
    const c = cache(); c.observe(response(status));
    const before = presentation(c.project(fresh(response(status))).listRuntimeStates);
    for (const value of [response('unknown', now + 10), { available: true, checkedAt: now + 11, states: [] }]) {
      c.observe(value);
      const projected = c.project(fresh(value));
      assert.deepEqual(presentation(projected.listRuntimeStates), before);
      assert.equal(projected.listRuntimeStale, true);
    }
    assert.deepEqual(presentation(c.project(loading).listRuntimeStates), before);
    const next = response('idle', now + 20); c.observe(next);
    assert.equal(c.project(failed).listRuntimeStates.size, 0);
  }
});

test('the list recomputes current user ranking preferences instead of freezing a final order', () => {
  const c = cache(); c.observe(response());
  const states = c.project(failed).listRuntimeStates;
  const original = presentation(states);
  assert.notDeepEqual(presentation(states, new Set(['running']), new Map([['running', { visitedAt: now }]])).order, original.order);
  assert.deepEqual(presentation(states).order, original.order);
});

test('idle/waiting watermarks defeat old and equal-time conflicting running rows, including the raw map', () => {
  for (const status of ['idle', 'waiting_input', 'waiting_approval']) {
    const c = cache(); c.observe(response()); c.observe(response(status, now + 20));
    for (const value of [response('running', now + 21, 'running', now), response('running', now + 22, 'running', now + 20), response('running', now - 1)]) {
      c.observe(value);
      const projected = c.project(fresh(value));
      assert.equal(value.states[0].status, 'running');
      assert.equal(projected.listRuntimeStates.get('running'), status);
      assert.equal(projected.listRuntimeStale, true);
    }
    c.observe(response('running', now + 30));
    assert.equal(c.project(failed).listRuntimeStates.get('running'), 'running', 'a genuinely newer run may start');
  }
});

test('a newer unknown attempt cannot block an intervening explicit native idle fact', () => {
  const at = Date.now(), c = createListActivityCache('ged', 'source-a'); c.update(rows);
  c.observe(response('running', at - 3000));
  c.observe(response('unknown', at - 1000));
  assert.equal(c.observeNativeHistory('running', native({ checkedAt: at - 2000, runtime: 'idle', latestTurnStatus: 'completed' })), true);
  assert.equal(c.project(failed).listRuntimeStates.has('running'), false);
  c.observe(response('running', at, 'running', at - 3000));
  assert.equal(c.project(fresh(response())).listRuntimeStates.get('running'), 'idle');
});

test('native history rejects explicit other scopes, locally late reads and old terminal turns', () => {
  for (const history of [native({ pocketContent: { scope: 'source-b' }, runtime: 'idle', latestTurnStatus: 'completed' }),
    native({ runtime: 'active', activeTurnId: null, latestTurnStatus: 'completed',
      messages: [{ turnId: 'previous' }], turnTiming: { turnId: 'previous', status: 'completed' },
      stopRequest: { targetTurnId: 'previous', status: 'stopped' } })]) {
    const c = cache(); c.observe(response());
    assert.equal(c.observeNativeHistory('running', history), false);
    assert.equal(c.project(failed).listRuntimeStates.get('running'), 'running');
  }
  const c = cache(); c.observe(response());
  assert.equal(c.observeNativeHistory('running', native({ runtime: 'idle', latestTurnStatus: 'completed' }), now - 30000), false);
  assert.equal(c.project(failed).listRuntimeStates.get('running'), 'running');
});

test('client freshness uses request elapsed time while source clocks remain independent', () => {
  for (const skew of [86400000, -86400000]) {
    const c = createListActivityCache('ged', 'source-a', () => 1000); c.update(rows);
    const sourceAt = Date.now() + skew;
    c.observe(response('running', sourceAt));
    assert.equal(c.observeNativeHistory('running', native({ checkedAt: sourceAt + 1, runtime: 'idle', latestTurnStatus: 'completed' }), 999), true);
    assert.equal(c.project(failed).listRuntimeStates.has('running'), false);
  }
});

test('removal and reentry preserve a safe discard watermark against an older running row', () => {
  const c = cache(); c.observe(response()); c.observe(response('idle', now + 20));
  c.update([]); c.update(rows);
  const old = response('running', now + 30, 'running', now); c.observe(old);
  assert.equal(c.project(fresh(old)).listRuntimeStates.has('running'), false);
  c.observe(response('running', now + 40));
  assert.equal(c.project(failed).listRuntimeStates.get('running'), 'running');
});

test('native detail facts clear a stopped run but cached, mismatched and older facts cannot change it', () => {
  const c = cache(); c.observe(response());
  for (const history of [native({ source: 'rollout', runtime: 'idle' }), native({ resumeState: 'unavailable', runtime: 'idle' }),
    native({ checkedAt: now - 1, runtime: 'idle', latestTurnStatus: 'completed' }),
    native({ canSend: false, latestTurnStatus: 'unknown' }),
    native({ stopRequest: { requestId: 'stop', targetTurnId: 'old', status: 'stopped' } })]) {
    c.observeNativeHistory('running', history);
    assert.equal(c.project(failed).listRuntimeStates.get('running'), 'running');
  }
  for (const status of ['pending', 'accepted', 'unknown']) {
    c.observeNativeHistory('running', native({ stopRequest: { requestId: 'stop', targetTurnId: 'current', status } }));
    assert.equal(c.project(failed).listRuntimeStates.get('running'), 'running');
  }
  assert.equal(c.observeNativeHistory('running', native({ checkedAt: now + 110, stopRequest: { requestId: 'stop', targetTurnId: 'current', status: 'stopped' } })), true);
  assert.equal(c.project(failed).listRuntimeStates.has('running'), false);
  const old = response('running', now + 111, 'running', now);
  c.observe(old); assert.equal(c.project(fresh(old)).listRuntimeStates.get('running'), 'idle');
});

test('fresh exact turn completion or waiting facts replace running without lighting cached detail dots', () => {
  for (const history of [native({ runtime: 'idle', latestTurnStatus: 'completed' }),
    native({ turnTiming: { turnId: 'current', status: 'interrupted' } }),
    native({ pendingRequests: [{ kind: 'questions' }] }), native({ pendingRequests: [{ kind: 'command' }] })]) {
    const c = cache(); c.observe(response()); c.observeNativeHistory('running', history);
    assert.notEqual(c.project(failed).listRuntimeStates.get('running'), 'running');
    assert.equal(conversationIsWorking(history, { observed: false }), false);
  }
});

test('machines and reading scopes have independent memory, unknown scope cannot seed later identity', () => {
  const a = cache(); a.observe(response());
  for (const c of [createListActivityCache('wandou', 'source-a'), createListActivityCache('ged', 'source-b'),
    createListActivityCache('ged'), createListActivityCache(null, 'source-a')]) {
    c.update(rows); assert.equal(c.project(failed).listRuntimeStates.size, 0);
  }
  const unscoped = createListActivityCache('ged'); unscoped.update(rows); unscoped.observe(response());
  assert.equal(unscoped.project(failed).listRuntimeStates.size, 0);
  assert.equal(a.project(failed).listRuntimeStates.get('running'), 'running');
});

test('archived, missing, excluded and removed rows cannot keep cached activity', () => {
  for (const flag of ['archived', 'missing', 'separator', 'sourceExcluded']) {
    const c = cache(); c.observe(response()); c.update(rows.map(row => ({ ...row, [flag]: true })));
    assert.equal(c.project(failed).listRuntimeStates.size, 0);
  }
  const c = cache(); c.observe(response()); c.update(rows, ['running']);
  assert.equal(c.project(failed).listRuntimeStates.size, 0);
});

test('malformed/old source observations never seed running and the page cache is bounded', () => {
  const c = cache();
  for (const value of [response('running', now, 'running', 0), response('running', now, 'running', now + 1001),
    response('running', now, 'running', now - 30000), { ...response(), available: false }]) c.observe(value);
  assert.equal(c.project(failed).listRuntimeStates.size, 0);
  const many = Array.from({ length: listActivityCacheLimit + 30 }, (_, i) => ({ ...rows[0], id: String(i) }));
  c.update(many);
  for (const row of many) c.observe(response('running', now + Number(row.id), row.id));
  assert.equal(c.project(failed).listRuntimeStates.size, listActivityCacheLimit);
});

test('a complete fresh collection exceeds fallback capacity without losing rows, even with one shared timestamp', () => {
  for (const reversed of [false, true]) {
    const c = cache();
    const many = Array.from({ length: 160 }, (_, index) => ({ ...rows[0], id: String(index) }));
    c.update(many);
    const value = { available: true, checkedAt: now, states: many.map((row, index) => ({ threadId: row.id,
      status: index < 128 ? 'idle' : 'running', checkedAt: now })) };
    if (reversed) value.states.reverse();
    for (const next of [value, value, { ...value, checkedAt: now + 1, states: [...value.states].reverse() }]) {
      c.observe(next);
      const projected = c.project(fresh(next));
      assert.equal(projected.listRuntimeStates.size, 160);
      assert.equal(projected.listRuntimeStale, false);
      assert.deepEqual(navigationActivityCounts(many, normalizeNavigationPrefs(null), '', projected.listRuntimeStates), { unread: 128, running: 32 });
      assert.equal(filterThreads(many, 'all', '', '', 'smart', projected.listRuntimeStates, { now }, 'running').length, 32);
    }
    const fallback = c.project(failed);
    assert.ok(fallback.listRuntimeStates.size <= listActivityCacheLimit);
    assert.equal([...fallback.listRuntimeStates.values()].filter(status => status === 'running').length, 32);
    assert.equal(c.observeNativeHistory('159', native({ checkedAt: now + 2, runtime: 'idle', latestTurnStatus: 'completed' })), true);
    c.observe({ ...value, checkedAt: now + 3 });
    assert.equal(c.project(fresh(value)).listRuntimeStates.get('159'), 'idle');
    assert.equal(c.project(fresh(value)).listRuntimeStates.size, 160);
  }
});

test('fresh-only facts keep their watermarks when a large cache evicts them and the row later leaves', () => {
  const c = cache(), many = Array.from({ length: 160 }, (_, index) => ({ ...rows[0], id: String(index) }));
  c.update(many);
  const value = { available: true, checkedAt: now + 10, states: many.map((row, index) => ({ threadId: row.id,
    status: index === 0 ? 'idle' : 'running', checkedAt: now + 10 })) };
  c.observe(value);
  assert.equal(c.project(fresh(value)).listRuntimeStates.get('0'), 'idle');
  assert.equal(c.project(failed).listRuntimeStates.has('0'), false);
  c.update(many.filter(row => row.id !== '0')); c.update(many);
  const old = { ...value, checkedAt: now + 20, states: [{ threadId: '0', status: 'running', checkedAt: now }] };
  c.observe(old);
  assert.equal(c.project(fresh(old)).listRuntimeStates.has('0'), false);
  assert.equal(c.project(failed).listRuntimeStates.has('0'), false);
});

test('accepted polling facts survive throw, unavailable, offline, TTL and timeout only in the list', async () => {
  for (const failure of ['throw', 'unavailable', 'offline', 'ttl', 'timeout']) {
    const c = cache(), browser = new EventTarget(), visibility = new EventTarget(), timers = new Map();
    let time = 0, sequence = 0, calls = 0, view, finish;
    Object.assign(browser, { navigator: { onLine: true }, setTimeout(fn, delay) { timers.set(++sequence, { fn, at: time + delay }); return sequence; },
      clearTimeout(id) { timers.delete(id); } }); visibility.visibilityState = 'visible';
    const poller = startTaskStatusPolling({ browser, visibility, now: () => time, timeoutMs: failure === 'ttl' ? 60000 : 18000,
      request: async () => {
        if (++calls === 1) return response();
        if (failure === 'throw') throw new Error('weak network');
        if (failure === 'unavailable') return { ...response(), available: false };
        return new Promise(resolve => { finish = resolve; });
      }, onObservation: value => c.observe(value), onChange: next => { view = next; } });
    const advance = async until => {
      await setImmediate();
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn(); await setImmediate();
      }
      time = until;
    };
    await advance(0); const before = presentation(c.project(view).listRuntimeStates);
    if (failure === 'offline') { browser.navigator.onLine = false; browser.dispatchEvent(new Event('offline')); }
    else await advance(failure === 'ttl' ? 30000 : failure === 'timeout' ? 28000 : 10000);
    assert.equal(view.runtimeUnavailable, true, failure);
    assert.equal(view.runtimeStates.size, 0, failure);
    assert.deepEqual(presentation(c.project(view).listRuntimeStates), before, failure);
    poller.stop(); finish?.(response('idle', now + 10)); await setImmediate();
    assert.deepEqual(presentation(c.project(view).listRuntimeStates), before, 'cancelled response cannot clear cache');
  }
});

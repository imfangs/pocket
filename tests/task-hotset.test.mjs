import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createTaskHotset, taskHotsetLifetimeMs, taskHotsetLimit, taskStatusRequestPath } from '../src/taskHotset.ts';
import { startTaskStatusPolling } from '../src/taskStatuses.ts';

const epoch = 2_000_000_000_000;
const id = value => `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, '0')}`;
const thread = (value, updates = {}) => ({ id: id(value), createdAt: epoch - 86400000,
  archived: false, missing: false, separator: false, ...updates });
const context = (threads, updates = {}) => ({ threads, selectedId: null, activity: new Map(), ...updates });
const response = (checkedAt, states) => ({ available: true, checkedAt,
  states: states.map(([threadId, status, at = checkedAt]) => ({ threadId, status, checkedAt: at })) });

test('recent creation, genuine visit, active observation and the current detail feed a private bounded hint', () => {
  const threads = Object.freeze([thread(1), thread(2, { createdAt: epoch - 2000 }),
    thread(3, { createdAt: 0 }), thread(4), thread(5), thread(6)].map(Object.freeze));
  const activity = new Map([[id(1), Object.freeze({ visitedAt: epoch - 1000 })],
    [id(3), Object.freeze({ createdAt: epoch - 3000 })]]);
  const before = structuredClone({ threads, activity });
  const hotset = createTaskHotset(() => epoch);
  hotset.update(context(threads, { activity, selectedId: id(5) }));
  hotset.observe(response(10000, [[id(6), 'waiting_approval']]));
  assert.deepEqual(hotset.priorityThreadIds(), [id(5), id(6), id(1), id(2), id(3)]);
  assert.deepEqual({ threads, activity }, before, 'prefetch never rewrites ranking or catalog metadata');
  assert.deepEqual(Object.keys(hotset).sort(), ['observe', 'priorityThreadIds', 'update']);
});

test('repeated context, cached observations, idle and unknown cannot renew a real event', () => {
  let now = epoch;
  const hotset = createTaskHotset(() => now), threads = [thread(1, { createdAt: epoch }), thread(2), thread(3)];
  const input = context(threads, { activity: new Map([[id(2), { visitedAt: epoch }]]) });
  hotset.update(input);
  const first = response(1000, [[id(3), 'running']]);
  hotset.observe(first);
  now += taskHotsetLifetimeMs - 1;
  hotset.update(input); hotset.observe(first);
  hotset.observe(response(900, [[id(3), 'running']]));
  hotset.observe(response(2000, [[id(2), 'idle'], [id(3), 'unknown']]));
  assert.equal(hotset.priorityThreadIds().length, 3);
  now++;
  hotset.update(input);
  assert.deepEqual(hotset.priorityThreadIds(), []);
  hotset.observe(response(3000, [[id(3), 'running']]));
  assert.deepEqual(hotset.priorityThreadIds(), [id(3)], 'new native activity is a new observation');
});

test('only fresh, valid observations may seed activity and server clock skew does not affect local lifetime', () => {
  let now = epoch;
  const hotset = createTaskHotset(() => now);
  hotset.update(context([thread(1), thread(2), thread(3), thread(4), thread(5)]));
  hotset.observe({ ...response(10000, [[id(1), 'running']]), available: false });
  hotset.observe(response(10000, [[id(1), 'running'], [id(1), 'running']]));
  hotset.observe(response(10000, [[id(1), 'not-a-state']]));
  assert.deepEqual(hotset.priorityThreadIds(), []);
  hotset.observe(response(9000000000000, [[id(1), 'running'], [id(2), 'waiting_input'],
    [id(3), 'idle'], [id(4), 'running', 8999999970000], [id(5), 'running', 9000000005000]]));
  assert.deepEqual(hotset.priorityThreadIds(), [id(1), id(2)]);
  now += taskHotsetLifetimeMs;
  assert.deepEqual(hotset.priorityThreadIds(), []);
});

test('selection survives a long read and leaving retains a recent view without persisting a click', () => {
  let now = epoch;
  const hotset = createTaskHotset(() => now), input = context([thread(1)], { selectedId: id(1) });
  hotset.update(input);
  now += 2 * taskHotsetLifetimeMs;
  hotset.update(input);
  assert.deepEqual(hotset.priorityThreadIds(), [id(1)]);
  hotset.update({ ...input, selectedId: null });
  now += taskHotsetLifetimeMs - 1;
  assert.deepEqual(hotset.priorityThreadIds(), [id(1)]);
  now++;
  assert.deepEqual(hotset.priorityThreadIds(), []);
  assert.equal(input.activity.size, 0);
});

test('old original creation dates and invalid future events cannot become newly created by refreshing', () => {
  let now = epoch;
  const hotset = createTaskHotset(() => now);
  const input = context([thread(1), thread(2, { createdAt: epoch + taskHotsetLifetimeMs }), thread(3)], {
    activity: new Map([[id(1), { createdAt: epoch }], [id(3), { visitedAt: Infinity, createdAt: NaN }]]),
  });
  hotset.update(input);
  assert.deepEqual(hotset.priorityThreadIds(), []);
  now += 10000;
  hotset.update(input);
  assert.deepEqual(hotset.priorityThreadIds(), []);
});

test('the current detail is reserved inside 32 slots and eligibility is enforced again before hints', () => {
  const hotset = createTaskHotset(() => epoch);
  const threads = [...Array.from({ length: 40 }, (_, n) => thread(n, { createdAt: epoch - n })), thread(99)];
  hotset.update(context(threads, { selectedId: id(99) }));
  const ids = hotset.priorityThreadIds();
  assert.equal(ids.length, taskHotsetLimit);
  assert.equal(ids[0], id(99));
  assert.ok(ids.includes(id(0))); assert.ok(!ids.includes(id(39)));
  const forbidden = ['archived', 'missing', 'separator', 'sourceExcluded'].map((flag, n) => thread(n, { [flag]: true }));
  hotset.update(context([...forbidden, thread(4), thread(5), thread(99, { archived: true }),
    thread(6, { id: 'not-a-thread' })], { excludedThreadIds: [id(4)], selectedId: id(99),
    activity: new Map(forbidden.map(item => [item.id, { visitedAt: epoch }])) }));
  hotset.observe(response(1000, [...Array.from({ length: 7 }, (_, n) => [id(n), 'running']), [id(99), 'running']]));
  assert.deepEqual(hotset.priorityThreadIds(), [id(5)]);
});

test('machine/App instances never share bare thread IDs or activity', () => {
  const ged = createTaskHotset(() => epoch), wandou = createTaskHotset(() => epoch);
  const input = context([thread(1)]);
  ged.update(input); wandou.update(input);
  ged.observe(response(10000, [[id(1), 'running']]));
  assert.deepEqual(ged.priorityThreadIds(), [id(1)]);
  assert.deepEqual(wandou.priorityThreadIds(), []);
  const reopened = createTaskHotset(() => epoch);
  reopened.update(input);
  assert.deepEqual(reopened.priorityThreadIds(), [], 'activity observations are not persisted across App owners');
});

test('the existing GET endpoint receives only unique bounded UUID hints', () => {
  assert.equal(taskStatusRequestPath([]), '/api/task-statuses');
  assert.equal(taskStatusRequestPath(['../../open', 'x&priorityThreadIds=foreign']), '/api/task-statuses');
  const path = taskStatusRequestPath([id(1), id(1), ...Array.from({ length: 50 }, (_, n) => id(n))]);
  const url = new URL(path, 'https://pocket.example');
  assert.equal(url.pathname, '/api/task-statuses');
  assert.deepEqual([...url.searchParams.keys()], ['priorityThreadIds']);
  const ids = url.searchParams.get('priorityThreadIds').split(',');
  assert.equal(ids.length, taskHotsetLimit); assert.equal(new Set(ids).size, taskHotsetLimit);
});

test('one poller reads current hints on the next collection and stops for hidden/offline pages', async () => {
  let now = 0, nextTimer = 0;
  const browser = new EventTarget(), visibility = new EventTarget(), timers = new Map(), paths = [];
  Object.assign(browser, { navigator: { onLine: true },
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; },
    clearTimeout(key) { timers.delete(key); } });
  visibility.visibilityState = 'visible';
  const hotset = createTaskHotset(() => epoch + now), threads = [thread(1), thread(2), thread(3)];
  hotset.update(context(threads, { selectedId: id(1) }));
  const polling = startTaskStatusPolling({ browser, visibility, now: () => now,
    request: async () => { paths.push(taskStatusRequestPath(hotset.priorityThreadIds()));
      return response(1000 + paths.length, [[id(3), 'running']]); },
    onObservation: value => hotset.observe(value), onChange() {} });
  async function advance(ms) {
    await setImmediate(); const until = now + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await setImmediate();
    }
    now = until;
  }
  const hint = path => new URL(path, 'https://pocket.example').searchParams.get('priorityThreadIds').split(',');
  await advance(0);
  assert.deepEqual(hint(paths[0]), [id(1)]);
  hotset.update(context(threads, { selectedId: id(2) }));
  await advance(9999); assert.equal(paths.length, 1);
  await advance(1); assert.equal(paths.length, 2);
  assert.deepEqual(hint(paths[1]), [id(2), id(1), id(3)]);
  for (const mode of ['hidden', 'offline']) {
    if (mode === 'hidden') { visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange')); }
    else { browser.navigator.onLine = false; browser.dispatchEvent(new Event('offline')); }
    const before = paths.length;
    await advance(60000); assert.equal(paths.length, before);
    if (mode === 'hidden') { visibility.visibilityState = 'visible'; visibility.dispatchEvent(new Event('visibilitychange')); }
    else { browser.navigator.onLine = true; browser.dispatchEvent(new Event('online')); }
    await advance(0); assert.equal(paths.length, before + 1);
  }
  polling.stop(); assert.equal(timers.size, 0);
});

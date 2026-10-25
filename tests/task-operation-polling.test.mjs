import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskOperationPolling } from '../src/taskOperationPolling.ts';
import { mergeOperation } from '../src/taskOperations.ts';

const id = 'new-create', archive = 'old-archive';
const pending = { requestId: id, operation: 'create', status: 'pending', createdAt: 9999999999999 };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function clock() {
  let time = 0, sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => { const key = ++sequence; timers.set(key, { callback, at: time + delay }); return key; },
    clearTimer: key => timers.delete(key),
    async advance(delta) {
      const target = time + delta;
      await flush();
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      time = target; await flush();
    },
    get size() { return timers.size; },
  };
}
function fixture(request = async () => pending) {
  const timer = clock(), calls = [], errors = [], received = [], operations = new Map();
  const reader = createTaskOperationPolling({
    ...timer,
    request: async (requestId, signal) => { calls.push({ requestId, signal, at: timer.now() }); return request(requestId, signal, calls.length); },
    receive: incoming => { const next = mergeOperation(operations.get(incoming.requestId), incoming); operations.set(next.requestId, next); received.push(next); return next; },
    onError: (requestId, error) => errors.push({ requestId, error }),
  });
  reader.setActive(true);
  return { timer, reader, calls, errors, received, operations, observe(operation) { operations.set(operation.requestId, operation); reader.observe(operation); } };
}

test('only a durable creation receipt starts immediate checks, then pending polls after 500ms', async () => {
  const f = fixture();
  f.observe({ requestId: id, operation: 'create', status: 'pending' });
  await f.timer.advance(5000); assert.equal(f.calls.length, 0);
  f.observe(pending); await f.timer.advance(0);
  assert.deepEqual(f.calls.map(c => c.at), [5000]);
  await f.timer.advance(499); assert.equal(f.calls.length, 1);
  await f.timer.advance(1); assert.deepEqual(f.calls.map(c => c.at), [5000, 5500]);
  f.reader.stop();
});

test('a slow archive read cannot delay a separately confirmed creation', async () => {
  const old = deferred();
  const f = fixture(requestId => requestId === archive ? old.promise : Promise.resolve({ ...pending, status: 'succeeded' }));
  const oldRead = f.reader.check(archive); await flush();
  f.observe(pending); await f.timer.advance(0);
  assert.deepEqual(f.calls.map(c => [c.requestId, c.at]), [[archive, 0], [id, 0]]);
  assert.equal(f.operations.get(id).status, 'succeeded');
  old.resolve({ requestId: archive, operation: 'archive', status: 'waiting' }); await oldRead;
  f.reader.stop();
});

test('manual and automatic checks for one request share one GET and one received result', async () => {
  const waiting = deferred(), f = fixture(() => waiting.promise);
  const first = f.reader.check(id), second = f.reader.check(id);
  assert.equal(first, second);
  f.observe(pending); await f.timer.advance(0); assert.equal(f.calls.length, 1);
  waiting.resolve({ ...pending, status: 'succeeded' }); await first; await flush();
  assert.equal(f.received.length, 1); await f.timer.advance(10000); assert.equal(f.calls.length, 1);
  f.reader.stop();
});

test('background suspension aborts only reads, stays silent, and resuming checks immediately', async () => {
  const f = fixture((_id, signal, attempt) => attempt === 1 ? new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) : Promise.resolve({ ...pending, status: 'succeeded' }));
  f.observe(pending); await f.timer.advance(0); f.reader.setActive(false); await flush();
  assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.errors.length, 0);
  await f.timer.advance(5000); assert.equal(f.calls.length, 1);
  f.reader.setActive(true); await f.timer.advance(0);
  assert.deepEqual(f.calls.map(c => c.at), [0, 5000]); assert.equal(f.operations.get(id).status, 'succeeded');
  f.reader.stop();
});

test('quick hide/show during an aborted read still resumes without waiting for an old timer', async () => {
  const waiting = deferred(), f = fixture((_id, _signal, attempt) => attempt === 1 ? waiting.promise : Promise.resolve({ ...pending, status: 'succeeded' }));
  f.observe(pending); await f.timer.advance(0); f.reader.setActive(false); f.reader.setActive(true);
  waiting.resolve(pending); await flush(); await f.timer.advance(0);
  assert.equal(f.calls.length, 2); assert.equal(f.operations.get(id).status, 'succeeded'); assert.equal(f.errors.length, 0);
  f.reader.stop();
});

test('unknown and terminal states stop automatic creation checks and retain explicit checking', async () => {
  for (const status of ['succeeded', 'rejected', 'unknown', 'cancelled', 'changed']) {
    const f = fixture(async () => ({ ...pending, status }));
    f.observe(pending); await f.timer.advance(0); await f.timer.advance(60000);
    assert.equal(f.calls.length, 1, status); assert.equal(f.timer.size, 0, status);
    await f.reader.check(id); assert.equal(f.calls.length, 2, status); f.reader.stop();
  }
});

test('transient read errors back off and successful reads restore the fast pending cadence', async () => {
  const f = fixture(async (_id, _signal, attempt) => { if (attempt < 3) throw new TypeError('offline fixture'); return pending; });
  f.observe(pending); await f.timer.advance(3500);
  assert.deepEqual(f.calls.map(c => c.at), [0, 1000, 3000, 3500]); assert.equal(f.errors.length, 2);
  f.reader.setActive(false); await f.timer.advance(5000); f.reader.setActive(true); await f.timer.advance(0);
  assert.equal(f.calls.at(-1).at, 8500); f.reader.stop();
});

test('long pending work backs off using local observation time, independent of remote createdAt', async () => {
  const f = fixture(); f.observe(pending); await f.timer.advance(35000);
  const times = f.calls.map(c => c.at);
  assert(times.includes(10000)); assert(times.includes(11500)); assert(times.includes(31000)); assert(times.includes(35000));
  assert(!times.includes(10500)); assert(!times.includes(31500)); f.reader.stop();
});

test('a stopped reader ignores late results and cannot schedule or check again', async () => {
  const waiting = deferred(), f = fixture(() => waiting.promise);
  f.observe(pending); await f.timer.advance(0); f.reader.stop();
  waiting.resolve({ ...pending, status: 'succeeded' }); await flush(); await f.timer.advance(60000);
  assert.equal(f.received.length, 0); assert.equal(f.errors.length, 0); assert.equal(f.timer.size, 0);
  await f.reader.check(id); f.reader.observe(pending); f.reader.setActive(true); await f.timer.advance(0); assert.equal(f.calls.length, 1);
});

test('mismatched read receipts report an error without adopting or completing another operation', async () => {
  const f = fixture(async () => ({ ...pending, requestId: 'another-create', status: 'succeeded' }));
  f.observe(pending); await f.timer.advance(0);
  assert.equal(f.received.length, 0); assert.equal(f.errors.length, 1); assert.match(f.errors[0].error.message, /编号不匹配/); f.reader.stop();
});

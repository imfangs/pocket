import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreationOptionsReader } from '../src/creationOptions.ts';

const available = { available: true, locations: [{ id: 'work', label: 'Work', cwd: '/work' }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(request, extra = {}) {
  const data = [], errors = [], loading = [];
  const reader = createCreationOptionsReader({ request, onData: value => data.push(value), onError: value => errors.push(value), onLoading: value => loading.push(value), ...extra });
  return { reader, data, errors, loading };
}

test('failed creation option reads can retry in place while duplicate reads share one request', async () => {
  let calls = 0, finish;
  const f = fixture(() => ++calls === 1 ? new Promise((_, reject) => { finish = reject; }) : Promise.resolve(available));
  const first = f.reader.read();
  assert.equal(f.reader.read(), first);
  finish(new Error('Mac 暂时不可达')); await first;
  assert.equal(calls, 1); assert.equal(f.errors.at(-1), 'Mac 暂时不可达');
  await f.reader.read();
  assert.equal(calls, 2); assert.deepEqual(f.data, [available]); assert.equal(f.errors.at(-1), '');
  assert.deepEqual(f.loading, [true, false, true, false]); f.reader.dispose();
});

test('a stalled transport times out, remains retryable, and its late result cannot replace the retry', async () => {
  let finish, calls = 0, firstSignal;
  const f = fixture(signal => ++calls === 1 ? new Promise(resolve => { firstSignal = signal; finish = resolve; }) : Promise.resolve(available), { timeoutMs: 10 });
  await f.reader.read();
  assert.equal(firstSignal.aborted, true); assert.match(f.errors.at(-1), /超时/);
  assert.deepEqual(f.data, [], 'timeout does not turn the previous directory snapshot into unavailable');
  await f.reader.read();
  finish({ available: false, locations: [] }); await tick();
  assert.deepEqual(f.data, [available]); assert.equal(f.errors.at(-1), ''); f.reader.dispose();
});

test('reconnect retries a failed read once without looping on repeated online events', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error('offline'); });
  await f.reader.read(); await f.reader.reconnect(); await f.reader.reconnect();
  assert.equal(calls, 2);
  f.reader.offline(); await f.reader.reconnect();
  assert.equal(calls, 3, 'a new offline/online transition may retry once');
  await f.reader.read(); assert.equal(calls, 4, 'manual retry remains available'); f.reader.dispose();
});

test('an online event during the failing read schedules one follow-up after it settles', async () => {
  let calls = 0, fail;
  const f = fixture(() => ++calls === 1 ? new Promise((_, reject) => { fail = reject; }) : Promise.resolve(available));
  const first = f.reader.read();
  assert.equal(f.reader.reconnect(), first); assert.equal(f.reader.reconnect(), first);
  fail(new Error('old offline request')); await first; await tick();
  assert.equal(calls, 2); assert.deepEqual(f.data, [available]);
  await f.reader.reconnect(); assert.equal(calls, 2); f.reader.dispose();
});

test('successful reads do not refresh on every online event, and closed dialogs ignore late results', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return available; });
  await f.reader.read(); f.reader.offline(); await f.reader.reconnect();
  assert.equal(calls, 1); f.reader.dispose();
  let finish;
  const closed = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = closed.reader.read(); closed.reader.dispose(); await pending;
  finish(available); await tick();
  assert.deepEqual(closed.data, []); assert.deepEqual(closed.errors, []);
  assert.deepEqual(closed.loading, [true]);
});

test('an explicit unavailable response is distinct from transport failure and permits bounded reconnect', async () => {
  let calls = 0;
  const missing = { available: false, locations: [] };
  const f = fixture(async () => ++calls === 1 ? missing : available);
  await f.reader.read();
  assert.deepEqual(f.data, [missing]); assert.match(f.errors.at(-1), /工作目录/);
  await f.reader.reconnect(); assert.deepEqual(f.data, [missing, available]); f.reader.dispose();
});

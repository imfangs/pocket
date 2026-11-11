import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api.ts';
import { getReloadBlocker } from '../src/updateSafety.ts';

const task = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const reply = data => new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json', 'X-Pocket-Machine': 'ged' },
});
function stalledClient(t, options = {}) {
  let signal, resolve, calls = 0;
  const request = new Promise(done => { resolve = done; });
  const client = createApiClient(() => 'ged', (_url, init) => {
    calls++; signal = init.signal;
    return new Promise((done, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      void request.then(done);
    });
  }, () => { throw new Error('A timeout is not authentication expiry'); });
  const pending = client.api(`/api/tasks/${task}/stop`, 'POST', { requestId: task }, options);
  // A failed baseline assertion must still release the API's global reload hold.
  t.after(async () => { resolve(reply({ requestId: task, status: 'unknown' })); await pending.catch(() => {}); });
  return { pending, signal: () => signal, calls: () => calls };
}

test('a stalled control POST times out once and releases its reload hold without replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = stalledClient(t);
  assert.ok(f.signal() instanceof AbortSignal, 'The actual API transport must always receive a bounded signal');
  assert.ok(getReloadBlocker());
  t.mock.timers.tick(24999); assert.equal(f.signal().aborted, false);
  const outcome = assert.rejects(f.pending, { name: 'TimeoutError' });
  t.mock.timers.tick(1); await outcome;
  assert.equal(f.calls(), 1, 'No mutation retries after an unknown transport outcome');
  assert.equal(getReloadBlocker(), null);
});

test('the caller cancellation wins over the transport deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(), failure = new DOMException('Left view', 'AbortError');
  const f = stalledClient(t, { signal: controller.signal });
  const outcome = assert.rejects(f.pending, error => error === failure);
  controller.abort(failure); await outcome;
  t.mock.timers.tick(25000);
  assert.equal(f.signal().reason, failure); assert.equal(f.calls(), 1);
  assert.equal(getReloadBlocker(), null);
});

test('successful requests release their deadline and caller listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(); let transport;
  const client = createApiClient(() => 'ged', async (_url, init) => { transport = init.signal; return reply({ ok: true }); });
  assert.deepEqual(await client.api('/api/catalog', 'GET', undefined, { signal: controller.signal }), { ok: true });
  assert.ok(transport instanceof AbortSignal);
  controller.abort(); t.mock.timers.tick(25000);
  assert.equal(transport.aborted, false, 'A settled transport must not retain the caller or its timer');
});

test('CSRF recovery shares one deadline, including JSON body transfer and the catalog read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = []; let blocked, unblock, started;
  const bodyStarted = new Promise(resolve => { started = resolve; });
  const client = createApiClient(() => 'ged', async (url, init) => {
    calls.push(url);
    if (calls.length > 2) return reply({ requestId: task, status: 'unknown' });
    if (calls.length === 1) return new Response(JSON.stringify({ error: '请求已过期，请刷新页面' }), {
      status: 403, headers: { 'Content-Type': 'application/json', 'X-Pocket-Machine': 'ged' },
    });
    blocked = init.signal;
    const response = reply(null);
    response.json = () => new Promise((resolve, reject) => {
      unblock = resolve;
      started();
      if (blocked?.aborted) reject(blocked.reason);
      else blocked?.addEventListener('abort', () => reject(blocked.reason), { once: true });
    });
    return response;
  });
  const pending = client.api(`/api/tasks/${task}/stop`, 'POST', { requestId: task });
  t.after(async () => { unblock?.({ csrfToken: 'fixture' }); await pending.catch(() => {}); });
  await bodyStarted;
  assert.ok(unblock, 'The actual recovery branch reached the catalog body');
  assert.ok(blocked instanceof AbortSignal);
  const outcome = assert.rejects(pending, { name: 'TimeoutError' });
  t.mock.timers.tick(25000); await outcome;
  assert.equal(calls.length, 2, 'A timed-out CSRF read cannot trigger another POST');
  assert.equal(getReloadBlocker(), null);
});

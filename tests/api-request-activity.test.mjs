import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api.ts';
import { createRequestActivity } from '../src/requestActivity.ts';
import { getReloadBlocker } from '../src/updateSafety.ts';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const version = `W/"pocket-read-v1-${'a'.repeat(64)}"`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const reply = (data, status = 200, headers = {}) => new Response([204, 304].includes(status) ? null : JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'X-Pocket-Machine': 'ged', ...headers },
});
function fixture(steps, scope = () => 'ged', injected) {
  const store = createRequestActivity(), states = [], calls = [], expired = [];
  store.subscribe(() => states.push(store.isPending('ged', id)));
  const client = createApiClient(scope, async (url, options) => {
    calls.push({ url, options }); assert.ok(steps.length, `Unexpected request ${url}`);
    const next = steps.shift(); return typeof next === 'function' ? next(url, options) : next;
  }, machine => expired.push(machine), injected ?? store);
  return { client, store, states, calls, expired };
}

test('a logical request remains active through fetch and JSON decoding then returns its actual value', async () => {
  const network = deferred(), decoding = deferred(), startedDecode = deferred(), response = reply(null);
  response.json = () => { startedDecode.resolve(); return decoding.promise; };
  const f = fixture([() => network.promise]), pending = f.client.api(`/api/tasks/${id}/history`);
  assert.equal(f.store.isPending('ged', id), true); assert.equal(f.store.isPending('ged', other), false);
  network.resolve(response); await startedDecode.promise; assert.equal(f.store.isPending('ged', id), true);
  const data = { source: 'desktop', runtime: 'active', pendingRequests: ['not a network request'] };
  decoding.resolve(data); assert.deepEqual(await pending, data);
  assert.deepEqual(f.states, [true, false]); assert.equal(f.store.isPending('ged'), false);
});

test('activity observers receive routing metadata while the body remains solely with the original transport', async () => {
  const observed = [], observer = { begin(metadata) { observed.push(metadata); return () => {}; }, clearMachine() {} };
  const f = fixture([reply({ status: 'accepted' })], () => 'ged', observer);
  const body = { requestId: other, text: 'private synthetic input', credential: 'synthetic secret' };
  await f.client.api(`/api/tasks/${id}/messages`, 'POST', body);
  assert.deepEqual(observed, [{ machine: 'ged', path: `/api/tasks/${id}/messages`, method: 'POST' }]);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), body);
});

test('403 token refresh and original retry remain one uninterrupted activity token', async () => {
  const refresh = deferred(), refreshing = deferred(), retry = deferred(), retrying = deferred();
  const f = fixture([
    reply({ error: '请求已过期，请刷新页面' }, 403),
    () => { refreshing.resolve(); return refresh.promise; },
    () => { retrying.resolve(); return retry.promise; },
  ]);
  const pending = f.client.api(`/api/tasks/${id}/messages`, 'POST', { requestId: other, text: 'synthetic' });
  await refreshing.promise; assert.deepEqual(f.states, [true]); assert.equal(f.store.isPending('ged', id), true);
  refresh.resolve(reply({ csrfToken: 'fixture-token' })); await retrying.promise;
  assert.deepEqual(f.states, [true]); retry.resolve(reply({ status: 'accepted' }));
  assert.deepEqual(await pending, { status: 'accepted' }); assert.deepEqual(f.states, [true, false]);
  assert.equal(f.calls.length, 3); assert.equal(getReloadBlocker(), null);
});

test('304 fallback and successful 304 hydration are real request activity without duplicate tokens', async () => {
  const full = deferred(), started = deferred();
  const f = fixture([reply(null, 304, { ETag: version }), () => { started.resolve(); return full.promise; },
    reply(null, 304, { ETag: version, 'X-Pocket-Source-Synced-At': '2000' })]);
  const pending = f.client.api('/api/catalog'); await started.promise; assert.deepEqual(f.states, [true]);
  full.resolve(reply({ sourceInfo: { syncedAt: 1000 }, threads: [] }, 200, { ETag: version })); await pending;
  assert.deepEqual(f.states, [true, false]);
  assert.equal((await f.client.api('/api/catalog')).sourceInfo.syncedAt, 2000);
  assert.deepEqual(f.states, [true, false, true, false]);
});

test('fetch, abort, JSON, wrong-machine and HTTP errors release activity without changing their failures', async () => {
  const fetchFailure = new Error('fetch failed'), abort = new DOMException('cancelled', 'AbortError'), jsonFailure = new SyntaxError('bad JSON');
  const brokenJson = reply(null); brokenJson.json = async () => { throw jsonFailure; };
  for (const [step, expected] of [[() => { throw fetchFailure; }, fetchFailure], [() => { throw abort; }, abort],
    [brokenJson, jsonFailure], [reply({}, 200, { 'X-Pocket-Machine': 'wandou' }), /来源不匹配/], [reply({ error: 'server failed' }, 500), /server failed/]]) {
    const f = fixture([step]);
    await assert.rejects(f.client.api(`/api/tasks/${id}/messages`, 'POST', {}), error => expected instanceof RegExp ? expected.test(error.message) : error === expected);
    assert.deepEqual(f.states, [true, false]); assert.equal(f.store.isPending('ged'), false); assert.equal(getReloadBlocker(), null);
  }
});

test('abort during body decoding and a circular input both leave no active or reload hold', async () => {
  const controller = new AbortController(), response = reply(null), bodyStarted = deferred();
  response.json = () => new Promise((_, reject) => { bodyStarted.resolve(); controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }); });
  const f = fixture([response]), pending = f.client.api(`/api/tasks/${id}/messages`, 'POST', {}, { signal: controller.signal });
  await bodyStarted.promise; assert.equal(f.store.isPending('ged'), true); controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.deepEqual(f.states, [true, false]);
  const circular = {}; circular.self = circular;
  await assert.rejects(f.client.api(`/api/tasks/${id}/messages`, 'POST', circular), TypeError);
  assert.equal(f.store.isPending('ged'), false); assert.equal(getReloadBlocker(), null); assert.equal(f.calls.length, 1);
});

test('auth epoch changes clear old activity, whose finally cannot extinguish a newer same-scope request', async () => {
  const oldResponse = deferred(), newResponse = deferred();
  const f = fixture([() => oldResponse.promise, reply({ authenticated: true }), () => newResponse.promise]);
  const old = f.client.api(`/api/tasks/${id}/history`);
  await f.client.api('/api/auth/login', 'POST', { passphrase: 'fixture' }); assert.equal(f.store.isPending('ged'), false);
  const current = f.client.api(`/api/tasks/${id}/history`);
  oldResponse.resolve(reply({ error: 'old unauthorized' }, 401)); await assert.rejects(old, error => error.status === 401);
  assert.equal(f.store.isPending('ged', id), true); assert.deepEqual(f.expired, []);
  newResponse.resolve(reply({ messages: [] })); await current;
  assert.deepEqual(f.states, [true, false, true, false]);
});

test('cache invalidation is not request completion, and scope changes do not move an in-flight token', async () => {
  let machine = 'ged'; const ged = deferred(), remote = deferred();
  const f = fixture([() => ged.promise, () => remote.promise], () => machine);
  const a = f.client.api(`/api/tasks/${id}/history`); f.client.clearReadResponses('ged');
  assert.equal(f.store.isPending('ged', id), true);
  machine = 'wandou'; const b = f.client.api(`/api/tasks/${id}/history`);
  f.client.invalidateAuthentication('ged'); assert.equal(f.store.isPending('ged'), false); assert.equal(f.store.isPending('wandou', id), true);
  ged.resolve(reply({ messages: [] })); await a; assert.equal(f.store.isPending('wandou', id), true);
  remote.resolve(reply({ messages: [] }, 200, { 'X-Pocket-Machine': 'wandou' })); await b;
  assert.equal(f.store.isPending('wandou'), false);
});

test('subscriber and injected observer failures never prevent dispatch or replace a real result/error', async () => {
  const f = fixture([reply({ status: 'accepted' })]);
  f.store.subscribe(() => { throw new Error('subscriber broke'); });
  assert.deepEqual(await f.client.api(`/api/tasks/${id}/messages`, 'POST', {}), { status: 'accepted' });
  assert.deepEqual(f.states, [true, false]); assert.equal(getReloadBlocker(), null);
  for (const failAt of ['begin', 'finish']) {
    const observer = { begin() { if (failAt === 'begin') throw new Error('broken observer'); return () => { throw new Error('broken observer'); }; },
      clearMachine() { throw new Error('broken clear'); } };
    const broken = fixture([reply({ authenticated: true }), reply({ status: 'accepted' }), reply({ error: 'actual server failure' }, 500)], () => 'ged', observer);
    assert.deepEqual(await broken.client.api('/api/auth/login', 'POST', {}), { authenticated: true });
    assert.deepEqual(await broken.client.api(`/api/tasks/${id}/messages`, 'POST', {}), { status: 'accepted' });
    await assert.rejects(broken.client.api(`/api/tasks/${id}/messages`, 'POST', {}), /actual server failure/);
    assert.equal(broken.calls.length, 3); assert.equal(getReloadBlocker(), null);
  }
});

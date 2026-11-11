import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createReadHealth, persistentCollectionFailureAt, isReadTransportFailure } from '../src/readHealth.ts';
import { startTaskStatusPolling } from '../src/taskStatuses.ts';

const network = () => Object.assign(new Error('relay unavailable'), { status: 503 });
const failure = store => { store.observe({ type: 'pending' }); store.observe({ type: 'failed', error: network() }); store.observe({ type: 'settled' }); };

test('a short failure keeps diagnostics separate from reachability and a retry does not reset the streak', () => {
  let now = 0; const store = createReadHealth(() => now);
  failure(store); assert.deepEqual(store.getSnapshot(), { pending: false, failures: 1, failingSince: 0, reachableAt: null });
  now = 10000; store.observe({ type: 'pending' }); assert.equal(store.getSnapshot().failures, 1);
  assert.equal(persistentCollectionFailureAt([store.getSnapshot()]), null);
  store.observe({ type: 'reachable' }); store.observe({ type: 'settled' });
  assert.deepEqual(store.getSnapshot(), { pending: false, failures: 0, failingSince: null, reachableAt: 10000 });
});

test('persistent feedback needs three completed failures and a thirty-second grace deadline', () => {
  let now = 0; const store = createReadHealth(() => now);
  store.observe({ type: 'reachable' }); failure(store);
  now = 10000; failure(store); assert.equal(persistentCollectionFailureAt([store.getSnapshot()]), null);
  now = 20000; failure(store); assert.equal(persistentCollectionFailureAt([store.getSnapshot()]), 30000);
  store.observe({ type: 'pending' }); assert.equal(persistentCollectionFailureAt([store.getSnapshot()]), 30000, 'warning remains during its retry');
});

test('a reachable sibling list route prevents status-only failure from claiming lost connection', () => {
  let now = 0; const status = createReadHealth(() => now), catalog = createReadHealth(() => now);
  failure(status); now = 10000; failure(status); now = 20000; failure(status);
  now = 30000; catalog.observe({ type: 'reachable' });
  assert.equal(persistentCollectionFailureAt([catalog.getSnapshot(), status.getSnapshot()]), null);
  now = 31000; failure(catalog); now = 41000; failure(catalog); now = 51000; failure(catalog);
  assert.equal(persistentCollectionFailureAt([catalog.getSnapshot(), status.getSnapshot()]), 61000);
});

test('reset on scope/background clears the failure clock without asserting restored runtime', () => {
  const store = createReadHealth(() => 10); failure(store); store.reset();
  assert.deepEqual(store.getSnapshot(), { pending: false, failures: 0, failingSince: null, reachableAt: null });
});

test('native/source/auth failures differ from network/relay/timeout diagnostics', () => {
  for (const error of [new Error('native unavailable'), Object.assign(new Error('source unavailable'), { name: 'CatalogSourceError' }),
    Object.assign(new TypeError('bad request'), { status: 400 }), Object.assign(new Error('expired'), { status: 401 })])
    assert.equal(isReadTransportFailure(error), false);
  for (const error of [network(), new TypeError('Failed to fetch'), new DOMException('deadline', 'TimeoutError')])
    assert.equal(isReadTransportFailure(error), true);
});

function polling(request) {
  const browser = new EventTarget(), doc = new EventTarget(), timers = new Map();
  let clock = 0, id = 0;
  Object.assign(browser, { navigator: { onLine: true }, setTimeout: (fn, delay) => { const ticket = ++id; timers.set(ticket, { fn, at: clock + delay }); return ticket; }, clearTimeout: ticket => timers.delete(ticket) });
  doc.visibilityState = 'visible';
  const health = createReadHealth(() => clock), views = [];
  const feed = startTaskStatusPolling({ request, browser, visibility: doc, now: () => clock,
    onChange: view => views.push(view), onReadHealth: health.observe });
  const advance = async ms => {
    const end = clock + ms; await setImmediate();
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      clock = next[1].at; timers.delete(next[0]); next[1].fn(); await setImmediate();
    }
    clock = end;
  };
  return { feed, health, views, advance, browser, doc };
}

test('real status feed treats HTTP-success native unavailable as reachable while runtime remains unavailable', async () => {
  const f = polling(async () => ({ available: false, checkedAt: 1, states: [] }));
  await f.advance(0);
  assert.equal(f.views.at(-1).runtimeUnavailable, true); assert.equal(f.health.getSnapshot().failures, 0);
  assert.equal(f.health.getSnapshot().reachableAt, 0); assert.equal(f.health.getSnapshot().pending, false);
  f.feed.stop();
});

test('real timed-out status attempt reports one transport failure and ends pending', async () => {
  const f = polling(signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  await f.advance(18000);
  assert.equal(f.health.getSnapshot().failures, 1); assert.equal(f.health.getSnapshot().pending, false);
  assert.equal(f.views.at(-1).runtimeUnavailable, true); f.feed.stop();
});

test('real visibility cancellation and TTL expiration do not report network failures', async () => {
  let calls = 0;
  const f = polling(signal => ++calls === 1 ? Promise.resolve({ available: true, checkedAt: 1, states: [] })
    : new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  await f.advance(10000); f.doc.visibilityState = 'hidden'; f.doc.dispatchEvent(new Event('visibilitychange')); await f.advance(30000);
  assert.equal(f.health.getSnapshot().failures, 0); f.feed.stop();
});

test('a suspended read that delays abort acknowledgement cannot report an old timeout into new health', async () => {
  let finish;
  const f = polling(() => new Promise(resolve => { finish = resolve; }));
  await f.advance(1000);
  f.doc.visibilityState = 'hidden'; f.doc.dispatchEvent(new Event('visibilitychange')); f.health.reset();
  await f.advance(18000);
  assert.equal(f.health.getSnapshot().failures, 0); assert.equal(f.health.getSnapshot().pending, false);
  finish({ available: false, checkedAt: 1, states: [] }); await f.advance(0);
  assert.equal(f.health.getSnapshot().failures, 0); f.feed.stop();
});

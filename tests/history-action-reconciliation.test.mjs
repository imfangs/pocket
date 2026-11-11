import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';

const threadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const questionKey = 'a'.repeat(64);
const desktopHistory = (extra = {}) => ({ ok: true, source: 'desktop', resumeState: 'resumed',
  runtime: 'idle', canSend: true, canCompact: true, messages: [], pendingRequests: [], ...extra });

function fixture(t, request) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-history-actions-'));
  const store = new NavigatorStore(directory);
  store.sync({ threads: [{ id: threadId, title: 'Synthetic thread', cwd: directory, archived: false }], projects: [], sourceInfo: {} });
  const service = new DesktopService(store, directory, request,
    () => ({ source: 'rollout', runtime: 'unavailable', canSend: false, messages: [] }));
  const pending = [], gates = [];
  const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; });
    const gate = { promise, resolve }; gates.push(gate); return gate; };
  const track = promise => { pending.push(promise); promise.catch(() => {}); return promise; };
  t.after(async () => {
    for (const gate of gates) gate.resolve({ ok: false, code: 'dispatch_unknown', sent: null });
    await Promise.allSettled(pending);
    service.stopQueue(); service.models.stop(); store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { service, store, defer, track };
}

test('an older empty snapshot cannot resolve an approval submitted after that read started or hide its rejection', async t => {
  let oldRead, nativeResponse;
  const f = fixture(t, payload => {
    if (payload.operation === 'history') return oldRead.promise;
    assert.equal(payload.operation, 'respond'); return nativeResponse.promise;
  });
  oldRead = f.defer(); nativeResponse = f.defer();
  const read = f.track(f.service.history(threadId));
  const responding = f.track(f.service.respond(threadId, questionKey, { responseId: requestId, decision: 'accept' }));
  assert.equal(f.service.getResponseReceipt(threadId, requestId).status, 'pending');
  oldRead.resolve(desktopHistory()); await read;
  assert.equal(f.service.getResponseReceipt(threadId, requestId).status, 'pending', 'absence before this response existed is not its resolution');
  nativeResponse.resolve({ ok: false, sent: false, code: 'request_changed' });
  assert.deepEqual({ ...await responding }, { responseId: requestId, status: 'rejected', code: 'request_changed' });
});

test('an older compaction snapshot cannot complete a newer compaction or hide its native rejection', async t => {
  let oldRead, nativeCompaction, compactionStarted, reads = 0;
  const f = fixture(t, payload => {
    if (payload.operation === 'history') return ++reads === 1 ? oldRead.promise : Promise.resolve(desktopHistory({ compaction: { latestId: 'new-baseline', completed: true } }));
    assert.equal(payload.operation, 'compact'); compactionStarted.resolve(); return nativeCompaction.promise;
  });
  oldRead = f.defer(); nativeCompaction = f.defer(); compactionStarted = f.defer();
  const read = f.track(f.service.history(threadId));
  const compacting = f.track(f.service.compact(threadId, { requestId })); await compactionStarted.promise;
  assert.equal(f.service.getCompactionReceipt(threadId, requestId).status, 'pending');
  oldRead.resolve(desktopHistory({ compaction: { latestId: 'older-completed', completed: true } })); await read;
  assert.equal(f.service.getCompactionReceipt(threadId, requestId).status, 'pending', 'an old different baseline is not completion evidence');
  nativeCompaction.resolve({ ok: false, sent: false, code: 'thread_changed' });
  assert.deepEqual(await compacting, { requestId, status: 'rejected', code: 'thread_changed' });
});

test('a fresh read cannot infer an in-flight approval result before its native rejection arrives', async t => {
  let nativeResponse;
  const f = fixture(t, payload => payload.operation === 'history' ? Promise.resolve(desktopHistory()) : nativeResponse.promise);
  nativeResponse = f.defer();
  const responding = f.track(f.service.respond(threadId, questionKey, { responseId: requestId, decision: 'accept' }));
  await f.service.history(threadId);
  assert.equal(f.service.getResponseReceipt(threadId, requestId).status, 'pending');
  nativeResponse.resolve({ ok: false, sent: false, code: 'request_changed' });
  assert.equal((await responding).status, 'rejected');
});

test('a fresh read cannot infer an in-flight compaction result before its native rejection arrives', async t => {
  let nativeCompaction, compactionStarted, reads = 0;
  const f = fixture(t, payload => {
    if (payload.operation === 'history') return Promise.resolve(desktopHistory({ compaction: {
      latestId: ++reads === 1 ? 'baseline' : 'different-completed', completed: true } }));
    assert.equal(payload.operation, 'compact'); compactionStarted.resolve(); return nativeCompaction.promise;
  });
  nativeCompaction = f.defer(); compactionStarted = f.defer();
  const compacting = f.track(f.service.compact(threadId, { requestId })); await compactionStarted.promise;
  await f.service.history(threadId);
  assert.equal(f.service.getCompactionReceipt(threadId, requestId).status, 'pending');
  nativeCompaction.resolve({ ok: false, sent: false, code: 'thread_changed' });
  assert.equal((await compacting).status, 'rejected');
});

for (const outcome of ['accepted', 'unknown']) test(`fresh native absence resolves an ${outcome} approval exactly once without replay`, async t => {
  let responseCalls = 0;
  const f = fixture(t, payload => {
    if (payload.operation === 'history') return Promise.resolve(desktopHistory());
    assert.equal(payload.operation, 'respond'); responseCalls++;
    return Promise.resolve(outcome === 'accepted' ? { ok: true } : { ok: false, sent: null, code: 'dispatch_unknown' });
  });
  const input = { responseId: requestId, decision: 'accept' };
  assert.equal((await f.service.respond(threadId, questionKey, input)).status, outcome);
  await f.service.history(threadId);
  assert.equal(f.service.getResponseReceipt(threadId, requestId).status, 'resolved');
  assert.equal((await f.service.respond(threadId, questionKey, input)).status, 'resolved');
  assert.equal(responseCalls, 1);
});

for (const outcome of ['accepted', 'unknown']) test(`fresh completed compaction settles an ${outcome} receipt only after its baseline changes`, async t => {
  let compactionCalls = 0, latestId = 'baseline';
  const f = fixture(t, payload => {
    if (payload.operation === 'history') return Promise.resolve(desktopHistory({ compaction: { latestId, completed: true } }));
    assert.equal(payload.operation, 'compact'); compactionCalls++;
    return Promise.resolve(outcome === 'accepted' ? { ok: true } : { ok: false, sent: null, code: 'dispatch_unknown' });
  });
  assert.equal((await f.service.compact(threadId, { requestId })).status, outcome);
  await f.service.history(threadId);
  assert.equal(f.service.getCompactionReceipt(threadId, requestId).status, outcome, 'a completed old baseline does not settle this request');
  latestId = 'new-completed'; f.service.cache.clear(); await f.service.history(threadId);
  assert.equal(f.service.getCompactionReceipt(threadId, requestId).status, 'completed');
  assert.equal((await f.service.compact(threadId, { requestId })).status, 'completed');
  assert.equal(compactionCalls, 1);
});

test('positive exact message identity can still confirm a send made after a history read started', async t => {
  let oldRead, nativeSend;
  const f = fixture(t, payload => payload.operation === 'history' ? oldRead.promise : nativeSend.promise);
  oldRead = f.defer(); nativeSend = f.defer();
  const read = f.track(f.service.history(threadId));
  const sending = f.track(f.service.send(threadId, { requestId, text: 'Synthetic query' }));
  oldRead.resolve(desktopHistory({ messages: [{ id: 'native-message', role: 'user', text: 'Synthetic query', clientMessageId: requestId, turnId: 'native-turn' }] }));
  await read; assert.equal(f.service.getReceipt(threadId, requestId).status, 'accepted');
  nativeSend.resolve({ ok: false, sent: null, code: 'dispatch_unknown' });
  assert.equal((await sending).status, 'accepted');
});

for (const outcome of ['accepted', 'unknown']) test(`an old absence cannot resolve a newly ${outcome} approval; a subsequent read can`, async t => {
  let oldRead, reads = 0;
  const f = fixture(t, payload => {
    if (payload.operation === 'history') return ++reads === 1 ? oldRead.promise : Promise.resolve(desktopHistory());
    assert.equal(payload.operation, 'respond');
    return Promise.resolve(outcome === 'accepted' ? { ok: true } : { ok: false, sent: null, code: 'dispatch_unknown' });
  });
  oldRead = f.defer(); const read = f.track(f.service.history(threadId));
  assert.equal((await f.service.respond(threadId, questionKey, { responseId: requestId, decision: 'accept' })).status, outcome);
  oldRead.resolve(desktopHistory()); await read;
  assert.equal(f.service.getResponseReceipt(threadId, requestId).status, outcome, 'settling the RPC does not renew an older observation');
  await f.service.history(threadId);
  assert.equal(f.service.getResponseReceipt(threadId, requestId).status, 'resolved');
});

for (const outcome of ['accepted', 'unknown']) test(`an old compaction item cannot complete a newly ${outcome} request; a subsequent read can`, async t => {
  let oldRead, reads = 0;
  const f = fixture(t, payload => {
    if (payload.operation === 'history') {
      if (++reads === 1) return oldRead.promise;
      return Promise.resolve(desktopHistory({ compaction: { latestId: reads === 2 ? 'new-baseline' : 'new-completed', completed: true } }));
    }
    assert.equal(payload.operation, 'compact');
    return Promise.resolve(outcome === 'accepted' ? { ok: true } : { ok: false, sent: null, code: 'dispatch_unknown' });
  });
  oldRead = f.defer(); const read = f.track(f.service.history(threadId));
  assert.equal((await f.service.compact(threadId, { requestId })).status, outcome);
  oldRead.resolve(desktopHistory({ compaction: { latestId: 'old-completed', completed: true } })); await read;
  assert.equal(f.service.getCompactionReceipt(threadId, requestId).status, outcome);
  await f.service.history(threadId);
  assert.equal(f.service.getCompactionReceipt(threadId, requestId).status, 'completed');
});

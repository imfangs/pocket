import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { HistoryPageReader } from '../server/history-pages.mjs';
import { withReadRequest } from '../server/read-request.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', home = '/synthetic/codex';
const data = label => ({ source: 'rollout', messages: [{ id: label, text: label }], nextCursor: 'signed-opaque', hasMore: true });
class WorkerAdapter extends EventEmitter {
  requests = []; cancelled = []; terminated = false;
  ref() {} unref() {}
  postMessage(request) { (request.kind === 'cancel' ? this.cancelled : this.requests).push(request); }
  terminate() { this.terminated = true; return Promise.resolve(0); }
  complete(request, value = data('result')) { this.emit('message', { id: request.id, data: value }); }
}
function fixture(t, options = {}) {
  const workers = [], reader = new HistoryPageReader({ ...options, createWorker: () => {
    const worker = new WorkerAdapter(); workers.push(worker); return worker;
  } });
  t.after(() => reader.close());
  return { reader, workers };
}
const isCancelled = error => error.status === 499 && error.code === 'HISTORY_SOURCE_ABORTED';

test('a pre-cancelled read does not start a worker or consume its bounded queue', async t => {
  const { reader, workers } = fixture(t, { maxPending: 1 });
  await assert.rejects(reader.read(home, id, { signal: AbortSignal.abort() }), isCancelled);
  assert.equal(workers.length, 0);
  const live = reader.read(home, id); workers[0].complete(workers[0].requests[0]);
  assert.equal((await live).messages[0].id, 'result');
});

test('same-source consumers share one operation and cancellation does not take another reader or its cursor down', async t => {
  const { reader, workers } = fixture(t), a = new AbortController(), b = new AbortController();
  const first = reader.read(home, id, { signal: a.signal }), second = reader.read(home, id, { signal: b.signal });
  const firstFailure = assert.rejects(first, isCancelled);
  assert.equal(workers[0].requests.length, 1);
  a.abort(); await firstFailure; assert.equal(workers[0].cancelled.length, 0);
  workers[0].complete(workers[0].requests[0]);
  const page = await second; assert.equal(page.nextCursor, 'signed-opaque');
  assert.equal(workers[0].terminated, false);
});

test('last-consumer cancellation frees eight backend slots and late data cannot replace a new same-source operation', async t => {
  const { reader, workers } = fixture(t, { maxPending: 8 });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const reads = controllers.map((controller, n) => reader.read(home, id, { before: `position-${n}`, signal: controller.signal }));
  const rejected = Promise.all(reads.map(read => assert.rejects(read, isCancelled)));
  await assert.rejects(reader.read(home, id, { before: 'foreground' }), /历史读取繁忙/);
  controllers.forEach(controller => controller.abort()); await rejected;
  assert.equal(workers[0].cancelled.length, 8);
  const next = reader.read(home, id, { before: 'position-0' });
  let settled = false; void next.then(() => { settled = true; });
  workers[0].complete(workers[0].requests[0], data('cancelled-old')); await setImmediate();
  assert.equal(settled, false);
  workers[0].complete(workers[0].requests.at(-1), data('foreground'));
  assert.equal((await next).messages[0].id, 'foreground');
  assert.equal(workers.length, 1, 'Cancelling a consumer preserves the shared worker and signed snapshot state');
});

test('an uncancellable legacy consumer keeps its shared operation alive when a cancellable subscriber leaves', async t => {
  const { reader, workers } = fixture(t), controller = new AbortController();
  const legacy = reader.recent(home, id), other = reader.recent(home, id, { signal: controller.signal });
  assert.equal(reader.recent(home, id), legacy);
  const failure = assert.rejects(other, isCancelled); controller.abort(); await failure;
  assert.equal(workers[0].cancelled.length, 0); workers[0].complete(workers[0].requests[0]);
  assert.equal((await legacy).messages[0].id, 'result');
});

test('a timed-out worker retires its flights before a retry and old worker events cannot end the replacement', async t => {
  const { reader, workers } = fixture(t, { timeoutMs: 10 });
  await assert.rejects(reader.read(home, id), /历史读取超时/);
  assert.equal(workers[0].terminated, true);
  reader.timeoutMs = 1000;
  const retry = reader.read(home, id); const currentRequest = workers[1].requests[0];
  workers[0].emit('message', { id: currentRequest.id, data: data('wrong-worker') });
  workers[0].emit('exit', 1); workers[1].complete(currentRequest, data('replacement'));
  assert.equal((await retry).messages[0].id, 'replacement');
});

test('closing the owner rejects shared consumers once and late data cannot restore work', async t => {
  const { reader, workers } = fixture(t), controller = new AbortController();
  const a = reader.read(home, id), b = reader.read(home, id, { signal: controller.signal });
  const failures = Promise.all([a, b].map(value => assert.rejects(value, /历史分页读取已关闭/)));
  reader.close(); await failures;
  controller.abort(); workers[0].complete(workers[0].requests[0]);
  await assert.rejects(reader.read(home, id), /历史分页读取已关闭/);
});

test('HTTP consumer lifetime supplies cancellation, suppresses a disconnected reply and removes listeners', async () => {
  const req = new EventEmitter(), res = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  let signal, release;
  const pending = withReadRequest(req, res, selected => { signal = selected; return new Promise(done => { release = done; }); });
  res.destroyed = true; res.emit('close'); assert.equal(signal.aborted, true);
  release(data('late')); assert.equal(await pending, undefined);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});

test('HTTP successful reads keep errors honest and a normal finished close does not cancel another owner', async () => {
  const req = new EventEmitter(), res = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false });
  await assert.rejects(withReadRequest(req, res, async () => { throw new Error('actual read failure'); }), /actual read failure/);
  const result = await withReadRequest(req, res, async signal => {
    res.writableFinished = true; res.emit('close'); assert.equal(signal.aborted, false); return data('visible');
  });
  assert.equal(result.messages[0].id, 'visible'); assert.equal(res.listenerCount('close'), 0);
});

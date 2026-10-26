import './helpers/block-native-open.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';
import { LifecycleService } from '../server/lifecycle.mjs';

const oldId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const newId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const rid = n => `cccccccc-cccc-7ccc-8ccc-${String(n).padStart(12, '0')}`;
const attachmentId = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 4; i++) await setImmediate(); };

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-queue-wakeup-'));
  const store = new NavigatorStore(dir), calls = [], opens = [], gates = [];
  const states = new Map([oldId, newId].map(id => [id, { runtime: id === oldId ? 'active' : 'idle' }]));
  const source = (ids = [oldId, newId]) => ({ threads: ids.map(id => ({ id, title: 'Synthetic thread', cwd: dir, archived: false })), projects: [], sourceInfo: {} });
  store.sync(source());
  const request = async payload => {
    const state = states.get(payload.threadId);
    calls.push({ ...payload });
    if (payload.operation === 'history') {
      await state.historyGate?.promise;
      return { ok: true, source: 'desktop', resumeState: 'resumed', runtime: state.runtime, canSend: true,
        queueReady: state.runtime === 'idle', latestTurnId: 'turn', latestTurnStatus: state.runtime === 'active' ? 'inProgress' : 'completed', messages: [] };
    }
    assert.equal(payload.operation, 'send');
    await state.sendGate?.promise;
    return { ok: true, turnId: 'turn' };
  };
  const service = new DesktopService(store, dir, request, () => ({ source: 'rollout', runtime: 'unavailable', messages: [] }),
    { openThread: async id => { opens.push(id); } });
  service.startQueue();
  clearTimeout(service.queueTimer); // Drive the background scan explicitly; keep real wakeups enabled.
  const defer = () => { const value = gate(); gates.push(value); return value; };
  const queueWithoutConnection = async (id, n, extra = {}) => {
    const openThread = service.openThread; service.openThread = undefined;
    try { return await service.send(id, { requestId: rid(n), text: `Synthetic instruction ${n}`, enqueue: true, autoDirect: true, ...extra }); }
    finally { service.openThread = openThread; }
  };
  const sends = () => calls.filter(call => call.operation === 'send');
  t.after(async () => {
    service.stopQueue(); gates.forEach(value => value.resolve()); await settle();
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, service, states, source, calls, opens, defer, sends, queueWithoutConnection };
}

test('a created first query runs when its owner connects without waiting for another thread history', async t => {
  const f = fixture(t), slow = f.defer();
  await f.queueWithoutConnection(oldId, 1, { autoDirect: false });
  f.states.get(oldId).historyGate = slow;
  const background = f.service.processQueue(); await settle();
  assert.equal(f.calls.length, 1);
  let created = false, createCalls = 0;
  f.store.sync(f.source([oldId]));
  const lifecycle = new LifecycleService(f.store, f.service, f.dir, () => f.store.sync(f.source(created ? [oldId, newId] : [oldId])), {
    locations: () => [{ id: 'fixture-location', label: 'Fixture', cwd: f.dir }],
    create: async payload => {
      created = true; createCalls++;
      writeFileSync(payload.receiptPath, JSON.stringify({ requestId: payload.requestId, threadId: newId }));
      return { status: 'created', threadId: newId, verified: true, processStopped: true };
    },
  });
  t.after(() => lifecycle.stop());
  const input = { requestId: rid(80), locationId: 'fixture-location', initialQuery: 'Synthetic first query', autoDirect: true };
  try {
    lifecycle.startCreate(input); await lifecycle.running.get(input.requestId); await settle();
    const receipt = lifecycle.receipt(lifecycle.row(input.requestId));
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.initialMessage.status, 'accepted', 'a ready first query must not wait for the blocked background scan');
    assert.equal(f.sends().length, 1); assert.equal(f.sends()[0].threadId, newId);
    assert.equal(f.sends()[0].requestId, receipt.initialMessage.requestId);
    assert.equal(f.sends()[0].text, input.initialQuery); assert.equal(f.sends()[0].delivery, 'auto');
    assert.deepEqual(f.opens, [], 'an already resumed owner needs no native open');
    lifecycle.startCreate(input); await lifecycle.get(input.requestId); await settle();
    assert.equal(createCalls, 1); assert.equal(f.sends().length, 1);
  } finally { slow.resolve(); await background; }
});

test('duplicate connection wakeups and background checks send the same queued request once', async t => {
  const f = fixture(t), sending = f.defer();
  f.states.get(newId).runtime = 'active'; f.states.get(newId).sendGate = sending;
  await f.queueWithoutConnection(newId, 2);
  f.service.connect(newId, { open: false }); await settle();
  assert.equal(f.sends().length, 1, 'connection readiness wakes the queue');
  assert.equal(f.sends()[0].delivery, 'auto-now');
  f.service.connect(newId, { open: false });
  const checks = [f.service.processQueueForThread(newId), f.service.processQueueForThread(newId)];
  await settle(); assert.equal(f.sends().length, 1);
  sending.resolve(); await Promise.all(checks); await settle();
  await f.service.processQueueForThread(newId);
  assert.equal(f.sends().length, 1); assert.equal(f.sends()[0].requestId, rid(2));
  assert.equal(f.service.getReceipt(newId, rid(2)).status, 'accepted');
});

test('a successful connection is rechecked after an older same-thread history read falls back', async t => {
  const f = fixture(t), stale = f.defer(); await f.queueWithoutConnection(newId, 1);
  const request = f.service.request; let historyReads = 0;
  f.service.request = async payload => {
    if (payload.operation === 'history' && ++historyReads === 1) {
      await stale.promise; return { ok: false, code: 'desktop_unavailable', sent: false };
    }
    return request(payload);
  };
  const background = f.service.processQueueForThread(newId); await settle();
  f.service.connect(newId, { open: false }); await settle();
  assert.equal(f.service.connection(newId).status, 'connected');
  assert.equal(f.sends().length, 0, 'the prior same-thread check remains single-flight');
  stale.resolve(); await background; await settle();
  assert.equal(f.service.getReceipt(newId, rid(1)).status, 'accepted', 'the newer readiness observation must not be lost');
  assert.equal(f.sends().length, 1); assert.equal(f.sends()[0].requestId, rid(1));
});

test('a connection wakeup does not upgrade an older same-thread next-turn entry', async t => {
  const f = fixture(t); f.states.get(newId).runtime = 'active';
  await f.queueWithoutConnection(newId, 1, { autoDirect: false });
  await f.queueWithoutConnection(newId, 2);
  f.service.connect(newId, { open: false }); await settle();
  assert.deepEqual(f.service.outbox(newId).map(row => [row.id, row.autoDirect]), [[rid(1), false], [rid(2), true]]);
  assert.equal(f.sends().length, 0);
  f.states.get(newId).runtime = 'idle'; f.service.cache.clear();
  f.service.connect(newId, { open: false }); await settle();
  assert.deepEqual(f.sends().map(row => row.requestId), [rid(1)]);
  assert.deepEqual(f.service.outbox(newId).map(row => row.id), [rid(2)]);
});

test('connection wakeups preserve paused, editing, pending, rejected and unknown queue heads', async t => {
  for (const status of ['paused', 'editing', 'pending', 'rejected', 'unknown']) await t.test(status, async t => {
    const f = fixture(t); await f.queueWithoutConnection(newId, 1); await f.queueWithoutConnection(newId, 2);
    if (status === 'paused') f.store.db.prepare('INSERT INTO queue_pauses VALUES(?,?,?)').run(newId, rid(90), Date.now());
    else f.store.db.prepare('UPDATE dispatches SET status=? WHERE id=?').run(status, rid(1));
    f.service.connect(newId, { open: false }); await settle();
    assert.equal(f.sends().length, 0); assert.equal(f.service.outbox(newId).length, 2);
    assert.equal(f.service.getReceipt(newId, rid(1)).status, status === 'paused' ? 'queued' : status);
  });
});

test('stopping queue processing discards a late successful connection', async t => {
  const f = fixture(t), reading = f.defer(); f.states.get(newId).historyGate = reading;
  await f.service.send(newId, { requestId: rid(1), text: 'Synthetic late connection', enqueue: true, autoDirect: true });
  await settle(); assert.equal(f.service.connection(newId).status, 'connecting');
  f.service.stopQueue(); reading.resolve(); await settle();
  assert.equal(f.sends().length, 0); assert.equal(f.service.getReceipt(newId, rid(1)).status, 'queued');
  assert.equal(f.service.connection(newId).status, 'failed');
});

test('stopping queue processing prevents a late history check from starting a send', async t => {
  const f = fixture(t), reading = f.defer(); await f.queueWithoutConnection(newId, 1);
  f.states.get(newId).historyGate = reading;
  const processing = f.service.processQueueForThread(newId); await settle();
  f.service.stopQueue(); reading.resolve(); await processing;
  assert.equal(f.sends().length, 0); assert.equal(f.service.getReceipt(newId, rid(1)).status, 'queued');
});

test('stopping a background scan prevents later threads from dispatching even after a restart', async t => {
  for (const restart of [false, true]) await t.test(restart ? 'stop then restart' : 'stop', async t => {
    const f = fixture(t), reading = f.defer();
    await f.queueWithoutConnection(oldId, 1, { autoDirect: false });
    await f.queueWithoutConnection(newId, 2);
    f.states.get(oldId).historyGate = reading;
    const oldScan = f.service.processQueue(); await settle();
    f.service.stopQueue();
    if (restart) { f.service.startQueue(); clearTimeout(f.service.queueTimer); }
    reading.resolve(); await oldScan;
    assert.equal(f.sends().length, 0, 'an old scan must not continue into a new thread after stopping');
    assert.equal(f.service.getReceipt(newId, rid(2)).status, 'queued');
    if (restart) {
      await f.service.processQueue();
      assert.equal(f.sends().length, 1, 'a newly started scan may process the durable queue');
      assert.equal(f.sends()[0].requestId, rid(2));
    }
  });
});

test('a stopped background tick cannot create a second polling loop after restart', async t => {
  const f = fixture(t), oldTick = f.defer(); f.service.stopQueue();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let scans = 0;
  f.service.processQueue = async () => { if (++scans === 1) await oldTick.promise; };
  f.service.startQueue(); t.mock.timers.tick(100); await settle();
  assert.equal(scans, 1);
  f.service.stopQueue(); f.service.startQueue();
  t.mock.timers.tick(100); await settle(); assert.equal(scans, 2);
  oldTick.resolve(); await settle();
  t.mock.timers.tick(2000); await settle(); assert.equal(scans, 3, 'only the new generation may schedule another scan');
  t.mock.timers.tick(2000); await settle(); assert.equal(scans, 4);
});

test('stopping during automatic attachment preparation keeps the original queued request', async t => {
  const f = fixture(t), preparing = f.defer(), release = f.defer();
  await f.service.attachments.upload(newId, attachmentId, 'synthetic.txt', 'text/plain', Readable.from([Buffer.from('Synthetic content')]));
  await f.queueWithoutConnection(newId, 1, { attachments: [attachmentId] });
  const prepare = f.service.attachments.prepare.bind(f.service.attachments);
  f.service.attachments.prepare = async saved => { preparing.resolve(); await release.promise; return prepare(saved); };
  const processing = f.service.processQueueForThread(newId); await preparing.promise;
  assert.equal(f.service.getReceipt(newId, rid(1)).status, 'pending');
  f.service.stopQueue(); release.resolve(); await processing;
  assert.equal(f.sends().length, 0); assert.equal(f.service.getReceipt(newId, rid(1)).status, 'queued');
  assert.equal(f.service.outbox(newId)[0].attachments[0].id, attachmentId);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';

const thread = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attachmentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const rid = n => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`;
const turn = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', wrongTurn = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const bytes = Buffer.from('Synthetic immutable original');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await setImmediate(); } assert.ok(check()); }

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-dispatch-lifecycle-'));
  const store = new NavigatorStore(directory), calls = [], notifications = [], messages = [], gates = [];
  const source = overrides => ({ threads: [{ id: thread, title: 'Synthetic', cwd: directory, archived: false, ...overrides }], projects: [], sourceInfo: {} });
  store.sync(source());
  let onSend = async () => ({ ok: true, turnId: turn });
  const request = async payload => {
    calls.push(structuredClone(payload));
    if (payload.operation === 'send') return onSend(payload);
    assert.equal(payload.operation, 'history', 'No actual owner or settings operation is available to this fixture');
    return { ok: true, source: 'desktop', runtime: 'idle', resumeState: 'resumed', canSend: true, queueReady: true,
      latestTurnId: turn, latestTurnStatus: 'completed', messages };
  };
  const service = new DesktopService(store, directory, request, () => ({ source: 'rollout', messages: [] }));
  service.connectForSubmission = () => {};
  service.onAccepted = (threadId, turnId) => notifications.push({ threadId, turnId });
  const defer = () => { const value = gate(); gates.push(value); return value; };
  const upload = () => service.attachments.upload(thread, attachmentId, 'notes.txt', 'text/plain', Readable.from([bytes]));
  const manifest = () => [{ id: attachmentId, name: 'notes.txt', size: bytes.length, mime: 'text/plain' }];
  const reserve = (extra = {}) => service.send(thread, { requestId: rid(1), text: 'Read the complete original', attachmentUploads: manifest(), enqueue: true, ...extra });
  const holdPreparation = (ordinal = 1) => {
    const waiting = defer(), entered = defer(), prepare = service.attachments.prepare.bind(service.attachments); let count = 0;
    service.attachments.prepare = async files => { if (++count === ordinal) { entered.resolve(); await waiting.promise; } return prepare(files); };
    return { waiting, entered };
  };
  const block = kind => {
    if (kind === 'archived') store.sync(source({ archived: true }));
    else if (kind === 'missing') store.sync({ threads: [], projects: [], sourceInfo: {} });
    else if (kind === 'lifecycle') service.lifecycleBlocked = () => true;
    else if (kind === 'model') service.models.pending = () => true;
    else if (kind === 'compaction') service.compactionPending = () => true;
    else if (kind === 'stop') service.stops.pending = () => true;
    else assert.fail('Unknown control fixture');
  };
  t.after(async () => {
    gates.forEach(value => value.resolve({ ok: false, sent: null })); service.stopQueue(); service.models.stop();
    await Promise.allSettled([...service.uploadReservations.finalizing.values(), ...service.models.running.values()]);
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, service, calls, notifications, messages, source, defer, upload, manifest, reserve, holdPreparation, block,
    setOnSend(handler) { onSend = handler; }, sends() { return calls.filter(call => call.operation === 'send'); } };
}

test('actual upload verification excludes new model writes while missing files never hold the preparation lock', async t => {
  const f = fixture(t);
  await f.reserve();
  await assert.rejects(f.service.dispatchQueued(thread, rid(1), { expectedRevision: 0 }), error => error.status === 409);
  assert.equal(f.service.sending.has(thread), false, 'A missing browser File must not hold a thread lock');
  await f.service.cancelQueued(thread, rid(1), { expectedRevision: 0 });
  assert.equal(f.service.getReceipt(thread, rid(1)).status, 'cancelled');
  await f.upload();
  await f.service.send(thread, { requestId: rid(2), text: 'Read the complete original', attachmentUploads: f.manifest(), enqueue: true });
  const held = f.holdPreparation(), pending = f.service.dispatchQueued(thread, rid(2), { expectedRevision: 0 });
  await held.entered.promise;
  assert.equal(f.service.sending.has(thread), true);
  assert.throws(() => f.service.models.start(thread, { requestId: rid(3), model: 'synthetic-model', effort: 'ultra', expectedRevision: 'f'.repeat(64) }), error => error.status === 409);
  assert.equal(f.service.models.pending(thread), false);
  held.waiting.resolve(); assert.equal((await pending).status, 'accepted');
  assert.equal(f.service.sending.has(thread), false); assert.equal(f.sends().length, 1);
});

for (const kind of ['archived', 'missing', 'lifecycle', 'model', 'compaction', 'stop']) {
  test(`queue verification rechecks ${kind} before claiming the immutable row`, async t => {
    const f = fixture(t); await f.upload(); await f.reserve();
    const held = f.holdPreparation(), pending = f.service.dispatchQueued(thread, rid(1), { expectedRevision: 0 });
    const rejected = assert.rejects(pending, error => error.status === 409);
    await held.entered.promise; f.block(kind); held.waiting.resolve(); await rejected;
    assert.equal(f.sends().length, 0);
    assert.equal(f.service.getReceipt(thread, rid(1)).status, 'queued');
    assert.equal(f.service.outbox(thread)[0].revision, 0); assert.equal(f.service.outbox(thread)[0].text, 'Read the complete original');
    assert.equal(f.service.sending.has(thread), false);
  });
}

for (const action of ['cancel', 'edit']) {
  test(`${action} during upload verification cannot resurrect or send the older revision`, async t => {
    const f = fixture(t); await f.upload(); await f.reserve();
    const held = f.holdPreparation(), pending = f.service.dispatchQueued(thread, rid(1), { expectedRevision: 0 });
    const rejected = assert.rejects(pending, error => [404, 409].includes(error.status));
    await held.entered.promise;
    if (action === 'cancel') f.service.cancelQueued(thread, rid(1), { expectedRevision: 0 });
    else f.service.pauseQueued(thread, rid(1), { expectedRevision: 0 });
    held.waiting.resolve(); await rejected;
    assert.equal(f.sends().length, 0); assert.equal(f.service.sending.has(thread), false);
    if (action === 'cancel') { assert.equal(f.service.getReceipt(thread, rid(1)).status, 'cancelled'); assert.equal(f.service.outbox(thread).length, 0); }
    else { assert.equal(f.service.outbox(thread)[0].status, 'editing'); assert.equal(f.service.outbox(thread)[0].revision, 1); }
  });
}

for (const mode of ['direct', 'queued']) {
  test(`${mode} prepares attachments without sending after a new stop, and retains a known unsent row`, async t => {
    const f = fixture(t), uploaded = await f.upload();
    if (mode === 'queued') await f.service.send(thread, { requestId: rid(1), text: 'Complete original', attachments: [uploaded.id], enqueue: true });
    const held = f.holdPreparation();
    const pending = mode === 'queued' ? f.service.dispatchQueued(thread, rid(1), { expectedRevision: 0 })
      : f.service.send(thread, { requestId: rid(1), text: 'Complete original', attachments: [uploaded.id] });
    await held.entered.promise;
    f.service.stops.pending = () => true;
    held.waiting.resolve(); const receipt = await pending;
    assert.equal(receipt.status, 'queued'); assert.equal(f.sends().length, 0);
    assert.equal(f.service.outbox(thread)[0].text, 'Complete original');
    assert.equal(f.service.sending.has(thread), false); assert.equal(f.service.queueReservations.has(thread), false);
  });
  test(`${mode} uses the confirmed history turn and clears a late failed RPC diagnostic`, async t => {
    const f = fixture(t), sending = f.defer(); f.setOnSend(() => sending.promise);
    if (mode === 'queued') await f.service.send(thread, { requestId: rid(1), text: 'Immutable query', enqueue: true });
    const pending = mode === 'queued' ? f.service.dispatchQueued(thread, rid(1), { expectedRevision: 0 })
      : f.service.send(thread, { requestId: rid(1), text: 'Immutable query' });
    await until(() => f.sends().length === 1);
    f.messages.push({ id: 'synthetic-echo', role: 'user', text: 'Immutable query', clientMessageId: rid(1), turnId: turn });
    await f.service.loadHistory(thread);
    sending.resolve({ ok: false, sent: null, code: 'dispatch_unknown', turnId: wrongTurn });
    const receipt = await pending;
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.turnId, turn); assert.equal(receipt.code, null);
    assert.deepEqual(f.notifications, [{ threadId: thread, turnId: turn }]);
    assert.equal(f.service.outbox(thread).length, 0); assert.equal(f.sends().length, 1);
  });
  test(`${mode} notification failures cannot change an accepted receipt or leave a queue row`, async t => {
    const f = fixture(t);
    f.service.onAccepted = () => { throw new Error('Synthetic notification failure'); };
    if (mode === 'queued') await f.service.send(thread, { requestId: rid(1), text: 'Immutable query', enqueue: true });
    const receipt = mode === 'queued' ? await f.service.dispatchQueued(thread, rid(1), { expectedRevision: 0 })
      : await f.service.send(thread, { requestId: rid(1), text: 'Immutable query' });
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.turnId, turn); assert.equal(receipt.code, null);
    assert.equal(f.service.outbox(thread).length, 0); assert.equal(f.service.sending.has(thread), false);
  });
  test(`${mode} preserves a turnless confirmed acceptance without borrowing a failed RPC diagnostic turn`, async t => {
    const f = fixture(t), sending = f.defer(); f.setOnSend(() => sending.promise);
    if (mode === 'queued') await f.service.send(thread, { requestId: rid(1), text: 'Immutable query', enqueue: true });
    const pending = mode === 'queued' ? f.service.dispatchQueued(thread, rid(1), { expectedRevision: 0 })
      : f.service.send(thread, { requestId: rid(1), text: 'Immutable query' });
    await until(() => f.sends().length === 1);
    f.messages.push({ id: 'synthetic-turnless-echo', role: 'user', text: 'Immutable query', clientMessageId: rid(1) });
    await f.service.loadHistory(thread);
    sending.resolve({ ok: false, sent: null, code: 'dispatch_unknown', turnId: wrongTurn });
    const receipt = await pending;
    assert.equal(receipt.status, 'accepted'); assert.equal(receipt.turnId, null); assert.equal(receipt.code, null);
    assert.deepEqual(f.notifications, [{ threadId: thread, turnId: null }]); assert.equal(f.sends().length, 1);
  });
}

for (const codedFailure of [false, true]) {
test(`a pending native outcome releases preparation ownership and stays unknown even with a ${codedFailure ? 'control-looking' : 'plain'} failure`, async t => {
  const f = fixture(t); f.setOnSend(async () => { throw Object.assign(new Error('Synthetic lost RPC result'), codedFailure ? { dispatchCode: 'queue_paused' } : {}); });
  const receipt = await f.service.send(thread, { requestId: rid(1), text: 'Immutable query' });
  assert.equal(receipt.status, 'unknown'); assert.equal(f.service.sending.has(thread), false); assert.equal(f.service.queueReservations.has(thread), false);
  f.service.readHistory = () => ({ source: 'rollout', messages: [{ id: 'saved-echo', role: 'user', text: 'Immutable query', clientMessageId: rid(1), turnId: turn }] });
  assert.equal(f.service.transcript(thread).messages.length, 1);
  assert.equal(f.service.getReceipt(thread, rid(1)).status, 'unknown', 'A saved display echo cannot confirm native acceptance');
  assert.equal((await f.service.send(thread, { requestId: rid(1), text: 'Immutable query' })).status, 'unknown');
  await f.service.processQueue(); assert.equal(f.sends().length, 1); assert.deepEqual(f.notifications, []);
});
}

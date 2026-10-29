import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeedbackService, feedbackRequestId } from '../packages/feedback-kit/server/index.mjs';
import { normalizeFeedbackInput, FeedbackError } from '../packages/feedback-kit/contracts.ts';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const markId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const image = (kind = 'original') => ({ kind, mime: 'image/png', width: 1, height: 1, base64: png });
const input = (extra = {}) => ({ schemaVersion: 1, id, appId: 'pocket', note: 'Please improve this control.', reason: 'position',
  context: { pageUrl: 'https://example.test/view?task=example&token=secret#access_token=hidden', pageTitle: 'Feedback fixture',
    frontendVersion: 'test-build', viewport: { width: 390, height: 844, dpr: 3 } }, annotations: [], images: [], autoDirect: false, ...extra });
const byCode = code => error => error instanceof FeedbackError && error.code === code;
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'feedback-kit-'));
  const db = new DatabaseSync(join(directory, 'feedback.sqlite'));
  let now = 100000, closed = false;
  const callbacks = { published: [], delivered: [], inspections: [], relayed: [] };
  const service = createFeedbackService({ db, directory, machineId: 'ged',
    resolveTarget: () => ({ machineId: 'ged', key: 'development' }),
    validateImage: async (_path, expected) => ({ width: expected.width, height: expected.height }),
    publish: async (...args) => { callbacks.published.push(args); },
    deliver: async (...args) => { callbacks.delivered.push(args); return { status: 'accepted', requestId: args[0].requestId }; },
    inspectDelivery: async (...args) => { callbacks.inspections.push(args); return { status: 'accepted', requestId: args[0].requestId }; },
    now: () => now, ...options, limits: { webhookWaitMs: 100, receiptPollMs: 10, retryBaseMs: 10, retryMaxMs: 40, ...options.limits },
  });
  t.after(() => { service.stop(); if (!closed) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, db, service, callbacks, advance: ms => { now += ms; },
    closeDb() { db.close(); closed = true; }, now: () => now };
}

test('authenticated canonical feedback waits for confirmation; one ID creates one durable enqueue', async t => {
  const f = fixture(t);
  const stored = await f.service.submit(input());
  assert.equal(stored.status, 'received'); assert.equal(f.callbacks.delivered.length, 0);
  await f.service.tick(); assert.equal(f.service.receipt(id).status, 'waiting_webhook');
  assert.equal(f.callbacks.published.length, 1);
  f.service.confirm({ id, digest: stored.digest }); await f.service.tick();
  assert.equal(f.service.receipt(id).status, 'delivered'); assert.equal(f.callbacks.delivered.length, 1);
  assert.equal(f.callbacks.delivered[0][0].target.key, 'development');
  assert.equal(f.callbacks.delivered[0][0].context.pageUrl, 'https://example.test/view?task=example');
  f.service.confirm({ id, digest: stored.digest }); await f.service.submit(input()); await f.service.tick();
  assert.equal(f.callbacks.delivered.length, 1);
});

test('confirmation during the asynchronous record read preserves its dispatch phase', async t => {
  const f = fixture(t); const stored = await f.service.submit(input());
  const publishing = f.service.tick();
  f.service.confirm({ id, digest: stored.digest });
  await publishing; await f.service.tick();
  assert.equal(f.callbacks.published.length, 0);
  assert.equal(f.callbacks.delivered.length, 1);
  assert.equal(f.service.receipt(id).status, 'delivered');
});

test('a repeated ID with changed text or annotation never overwrites an accepted report', async t => {
  const f = fixture(t); const first = await f.service.submit(input());
  await assert.rejects(f.service.submit(input({ note: 'Different request' })), byCode('feedback_conflict'));
  assert.equal(f.service.receipt(id).digest, first.digest);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM feedback_records_v1').get().n, 1);
});

test('unknown IDs and forged digests cannot become dispatchable', async t => {
  const f = fixture(t); const first = await f.service.submit(input());
  assert.throws(() => f.service.confirm({ id: secondId, digest: first.digest }), byCode('feedback_not_found'));
  assert.throws(() => f.service.confirm({ id, digest: '0'.repeat(64) }), byCode('feedback_digest_mismatch'));
  await f.service.tick(); assert.equal(f.callbacks.delivered.length, 0);
});

test('pending saves with the same immutable payload share one validation and result', async t => {
  let finish, entered, validations = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { validateImage: async () => { validations++; return new Promise(resolve => { finish = resolve; entered(); }); } });
  const a = f.service.submit(input({ images: [image()] }));
  const b = f.service.submit(input({ images: [image()] }));
  await flush();
  await assert.rejects(f.service.submit(input({ note: 'Other', images: [image()] })), byCode('feedback_conflict'));
  await ready;
  finish({ width: 1, height: 1 });
  assert.deepEqual(await a, await b); assert.equal(validations, 1);
});

test('image bytes stay in private files; public receipts have no base64, paths, or targets', async t => {
  const f = fixture(t); const response = await f.service.submit(input({ images: [image(), image('annotated')],
    annotations: [{ id: markId, x: .1, y: .1, width: .5, height: .5, note: 'smaller' }] }));
  const serialized = JSON.stringify(response);
  assert(!serialized.includes(png)); assert(!serialized.includes(f.directory)); assert(!('target' in response));
  const row = f.db.prepare('SELECT * FROM feedback_records_v1').get(); assert(!row.input_json.includes(png));
  const result = await f.service.readImage(id, 'original');
  assert.deepEqual(result.bytes, Buffer.from(png, 'base64')); assert.equal('path' in result, false);
  const original = join(f.directory, 'feedback-assets', 'ged', id, 'original.png');
  assert.equal(statSync(original).mode & 0o777, 0o600);
});

test('image declaration, geometry and actual decode must agree before persistence', async t => {
  const f = fixture(t, { validateImage: async () => ({ width: 2, height: 1 }) });
  await assert.rejects(f.service.submit(input({ images: [image()] })), byCode('invalid_feedback_image'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM feedback_records_v1').get().n, 0);
  await assert.rejects(f.service.submit(input({ images: [{ ...image(), mime: 'image/jpeg' }] })), byCode('invalid_feedback_image'));
  assert.deepEqual(readdirSync(join(f.directory, 'feedback-assets')).filter(name => name.startsWith('.pending-')), []);
});

test('modified or substituted image files are refused before enqueue', async t => {
  const f = fixture(t); const stored = await f.service.submit(input({ images: [image()] }));
  const path = join(f.directory, 'feedback-assets', 'ged', id, 'original.png');
  const bytes = readFileSync(path); const replacement = Buffer.from(bytes); replacement[20] ^= 1; writeFileSync(path, replacement);
  f.service.confirm({ id, digest: stored.digest }); await f.service.tick();
  assert.equal(f.service.receipt(id).status, 'needs_attention'); assert.equal(f.callbacks.delivered.length, 0);
  unlinkSync(path); symlinkSync('/etc/passwd', path);
  await assert.rejects(f.service.readImage(id, 'original'), byCode('feedback_image_changed'));
});

test('publication backoff is bounded, persisted and does not directly enqueue', async t => {
  let publishes = 0;
  const f = fixture(t, { publish: async () => { publishes++; throw new Error('network'); }, limits: { maxPublishAttempts: 2 } });
  await f.service.submit(input()); await f.service.tick(); await f.service.tick(); assert.equal(publishes, 1);
  f.advance(10); await f.service.tick(); assert.equal(publishes, 2);
  assert.equal(f.service.receipt(id).status, 'needs_attention'); assert.equal(f.callbacks.delivered.length, 0);
});

test('missing webhook requests can be retriggered without duplicating feedback or execution', async t => {
  const f = fixture(t); const stored = await f.service.submit(input());
  await f.service.tick(); f.advance(100); await f.service.tick();
  assert.equal(f.callbacks.published.length, 2);
  const [a, b] = f.callbacks.published;
  assert.equal(a[0].id, b[0].id); assert.equal(a[0].digest, b[0].digest); assert.notEqual(a[1].attemptId, b[1].attemptId);
  f.service.confirm({ id, digest: stored.digest }); await f.service.tick();
  f.advance(1000); f.service.confirm({ id, digest: stored.digest }); await f.service.tick();
  assert.equal(f.callbacks.delivered.length, 1);
});

test('a confirmed webhook arriving before the publication reply is not overwritten', async t => {
  let service;
  const f = fixture(t, { publish: async record => { service.confirm({ id: record.id, digest: record.digest }); throw new Error('response lost'); } });
  service = f.service; await service.submit(input()); await service.tick();
  assert.equal(service.receipt(id).status, 'sending'); await service.tick();
  assert.equal(service.receipt(id).status, 'delivered');
});

test('an unknown delivery is inspected, never blindly submitted a second time', async t => {
  let deliveries = 0, inspections = 0;
  const f = fixture(t, { deliver: async () => { deliveries++; throw new Error('lost response'); },
    inspectDelivery: async () => { inspections++; return { status: inspections > 1 ? 'accepted' : 'unknown' }; } });
  const stored = await f.service.submit(input()); f.service.confirm({ id, digest: stored.digest }); await f.service.tick();
  assert.equal(deliveries, 1); f.advance(10); await f.service.tick(); f.advance(20); await f.service.tick();
  assert.equal(deliveries, 1); assert.equal(inspections, 2); assert.equal(f.service.receipt(id).status, 'delivered');
});

test('queued responses remain queued until exact request lookup confirms accepted', async t => {
  const f = fixture(t, { deliver: async () => ({ status: 'queued' }) });
  const stored = await f.service.submit(input()); f.service.confirm({ id, digest: stored.digest }); await f.service.tick();
  assert.equal(f.service.receipt(id).status, 'queued');
  f.advance(10); await f.service.tick(); assert.equal(f.service.receipt(id).status, 'delivered');
});

test('authoritative absence retries the same idempotency key, while mismatched receipts cannot confirm delivery', async t => {
  const ids = []; let inspect = 0;
  const f = fixture(t, { deliver: async record => { ids.push(record.requestId); return { status: 'unknown' }; },
    inspectDelivery: async record => ++inspect === 1 ? { status: 'not_found' } : { status: 'accepted', requestId: secondId } });
  const stored = await f.service.submit(input()); f.service.confirm({ id, digest: stored.digest }); await f.service.tick();
  f.advance(10); await f.service.tick(); f.advance(10); await f.service.tick();
  assert.deepEqual(ids, [stored.requestId, stored.requestId]);
  f.advance(10); await f.service.tick(); assert.notEqual(f.service.receipt(id).status, 'delivered');
});

test('a rejected or cancelled execution is not turned into a new automatic request', async t => {
  for (const status of ['rejected', 'cancelled', 'editing']) {
    let deliveries = 0;
    const f = fixture(t, { deliver: async () => { deliveries++; return { status }; }, inspectDelivery: async () => ({ status }) });
    const stored = await f.service.submit(input()); f.service.confirm({ id, digest: stored.digest }); await f.service.tick();
    assert.equal(f.service.receipt(id).status, 'needs_attention');
    f.service.retry(id); await f.service.tick(); assert.equal(deliveries, 1);
  }
});

test('persisted state survives restart and inspects an already enqueued request', async t => {
  let deliveries = 0;
  const f = fixture(t, { deliver: async () => { deliveries++; return { status: 'queued' }; } });
  const stored = await f.service.submit(input()); f.service.confirm({ id, digest: stored.digest }); await f.service.tick();
  f.service.stop(); f.closeDb();
  const db = new DatabaseSync(join(f.directory, 'feedback.sqlite'));
  const restored = createFeedbackService({ db, directory: f.directory, machineId: 'ged', now: () => f.now() + 10000,
    resolveTarget: () => ({ machineId: 'ged', key: 'development' }), deliver: async () => { deliveries++; return { status: 'accepted' }; },
    inspectDelivery: async record => ({ status: 'accepted', requestId: record.requestId }) });
  try { await restored.tick(); assert.equal(restored.receipt(id).status, 'delivered'); assert.equal(deliveries, 1); }
  finally { restored.stop(); db.close(); }
});

test('a crash between durable intent and enqueue recovers through verified absence', async t => {
  const f = fixture(t); const stored = await f.service.submit(input()); f.service.confirm({ id, digest: stored.digest });
  f.db.prepare("UPDATE feedback_records_v1 SET phase='inspect',started_delivery=1 WHERE id=?").run(id);
  f.service.inspectDelivery = async () => ({ status: 'not_found' });
  await f.service.tick(); assert.equal(f.callbacks.delivered.length, 0);
  f.advance(10); await f.service.tick(); assert.equal(f.callbacks.delivered.length, 1);
  assert.equal(f.callbacks.delivered[0][0].requestId, stored.requestId);
});

test('relay only starts after local webhook confirmation and the receiver never republishes it', async t => {
  const receiver = fixture(t); let payload, relayCalls = 0;
  const source = fixture(t, { machineId: 'wandou', resolveTarget: () => ({ machineId: 'ged', key: 'development' }),
    relay: async value => { relayCalls++; payload = value; return receiver.service.receiveRelay(value, 'wandou'); },
    inspectRelay: async record => receiver.service.receipt(record.id, { sourceMachine: 'wandou' }) });
  const stored = await source.service.submit(input({ images: [image()] })); await source.service.tick();
  assert.equal(relayCalls, 0); source.service.confirm({ id, digest: stored.digest }); await source.service.tick();
  assert.equal(relayCalls, 1); assert.equal(payload.sourceMachine, 'wandou'); assert.equal(payload.input.images[0].base64, png);
  await receiver.service.tick(); assert.equal(receiver.callbacks.published.length, 0); assert.equal(receiver.callbacks.delivered.length, 1);
  source.advance(10); await source.service.tick(); assert.equal(source.service.receipt(id).status, 'delivered');
  await receiver.service.receiveRelay(payload, 'wandou'); await receiver.service.tick(); assert.equal(receiver.callbacks.delivered.length, 1);
});

test('relay source, target and digest are all bound; equal IDs on two machines stay separate', async t => {
  let payload;
  const source = fixture(t, { machineId: 'wandou', resolveTarget: () => ({ machineId: 'ged', key: 'development' }), relay: async value => { payload = value; return { status: 'received' }; } });
  const original = await source.service.submit(input()); source.service.confirm({ id, digest: original.digest }); await source.service.tick();
  const receiver = fixture(t); const local = await receiver.service.submit(input());
  await assert.rejects(receiver.service.receiveRelay(payload, 'someone-else'), byCode('invalid_feedback_relay'));
  await assert.rejects(receiver.service.receiveRelay({ ...payload, target: { machineId: 'ged', key: 'another' } }, 'wandou'), byCode('feedback_target_changed'));
  await assert.rejects(receiver.service.receiveRelay({ ...payload, input: { ...payload.input, note: 'changed' } }, 'wandou'), byCode('feedback_digest_mismatch'));
  const imported = await receiver.service.receiveRelay(payload, 'wandou');
  assert.notEqual(imported.requestId, local.requestId); assert.equal(receiver.service.receipt(id).sourceMachine, 'ged');
  assert.equal(receiver.service.receipt(id, { sourceMachine: 'wandou' }).sourceMachine, 'wandou');
});

test('configuration changes cannot silently retarget an existing feedback', async t => {
  let target = 'development';
  const f = fixture(t, { resolveTarget: () => ({ machineId: 'ged', key: target }) });
  const original = await f.service.submit(input()); f.service.confirm({ id, digest: original.digest }); target = 'other';
  await f.service.tick(); assert.equal(f.service.receipt(id).code, 'feedback_target_changed'); assert.equal(f.callbacks.delivered.length, 0);
});

test('concurrent tick calls share the same operation and do not enqueue twice', async t => {
  let finish, entered, calls = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { deliver: async () => { calls++; return new Promise(resolve => { finish = resolve; entered(); }); } });
  const original = await f.service.submit(input()); f.service.confirm({ id, digest: original.digest });
  const a = f.service.tick(), b = f.service.tick(); assert.equal(a, b);
  await ready;
  assert.equal(calls, 1); finish({ status: 'accepted' }); await a; assert.equal(f.service.receipt(id).status, 'delivered');
});

test('stop aborts adapters and ignores their late replies even if the host closes SQLite', async t => {
  let finish, signal, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { publish: async (_record, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; entered(); }); } });
  await f.service.submit(input()); const pending = f.service.tick();
  await ready;
  f.service.stop(); assert.equal(signal.aborted, true); f.closeDb(); finish(); await pending;
  assert.throws(() => f.service.receipt(id), byCode('feedback_closed'));
});

test('storage limits reject another feedback without removing the original', async t => {
  const f = fixture(t, { limits: { maxReports: 1 } }); const first = await f.service.submit(input());
  await assert.rejects(f.service.submit(input({ id: secondId })), byCode('feedback_storage_full'));
  assert.equal(f.service.receipt(id).digest, first.digest);
});

test('a complete orphan directory from the rename-before-SQL crash window can be adopted only by the same payload', async t => {
  const f = fixture(t); const saved = await f.service.submit(input({ images: [image()] }));
  f.db.prepare('DELETE FROM feedback_records_v1 WHERE id=?').run(id);
  await assert.rejects(f.service.submit(input({ note: 'different', images: [image()] })), byCode('feedback_files_conflict'));
  const recovered = await f.service.submit(input({ images: [image()] }));
  assert.equal(recovered.digest, saved.digest); assert.deepEqual((await f.service.readImage(id, 'original')).bytes, Buffer.from(png, 'base64'));
});

test('a save interrupted during image validation cannot write after the host closes its database', async t => {
  let finish, entered; const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { validateImage: async () => new Promise(resolve => { finish = resolve; entered(); }) });
  const pending = f.service.submit(input({ images: [image()] })); await ready;
  f.service.stop(); f.closeDb(); finish({ width: 1, height: 1 });
  await assert.rejects(pending, byCode('feedback_closed'));
  assert.deepEqual(readdirSync(join(f.directory, 'feedback-assets')).filter(name => name.startsWith('.pending-')), []);
});

test('a known queued request may remain queued beyond the unknown-result inspection budget', async t => {
  let calls = 0;
  const f = fixture(t, { limits: { maxInspectionAttempts: 2 }, deliver: async () => ({ status: 'queued' }),
    inspectDelivery: async () => { calls++; return { status: 'queued' }; } });
  const saved = await f.service.submit(input()); f.service.confirm({ id, digest: saved.digest }); await f.service.tick();
  for (let i = 0; i < 5; i++) { f.advance(10); await f.service.tick(); }
  assert.equal(calls, 5); assert.equal(f.service.receipt(id).status, 'queued');
});

test('lookup can confirm an accepted request without rereading screenshot bytes', async t => {
  const f = fixture(t, { deliver: async () => ({ status: 'queued' }) });
  const saved = await f.service.submit(input({ images: [image()] })); f.service.confirm({ id, digest: saved.digest }); await f.service.tick();
  unlinkSync(join(f.directory, 'feedback-assets', 'ged', id, 'original.png'));
  f.advance(10); await f.service.tick(); assert.equal(f.service.receipt(id).status, 'delivered');
  await assert.rejects(f.service.readImage(id, 'original'), byCode('feedback_image_changed'));
});

test('unknown outcomes eventually require attention; explicit retry still only inspects the original request', async t => {
  let deliveries = 0, inspections = 0;
  const f = fixture(t, { limits: { maxInspectionAttempts: 2 }, deliver: async () => { deliveries++; return { status: 'unknown' }; },
    inspectDelivery: async () => { inspections++; return { status: 'unknown' }; } });
  const saved = await f.service.submit(input()); f.service.confirm({ id, digest: saved.digest }); await f.service.tick();
  for (let i = 0; i < 3; i++) { f.advance(100); await f.service.tick(); }
  assert.equal(f.service.receipt(id).status, 'needs_attention'); assert.equal(inspections, 2);
  f.service.retry(id); await f.service.tick(); assert.equal(inspections, 3); assert.equal(deliveries, 1);
});

test('deadline aborts a stalled enqueue, and its late reply cannot fabricate a receipt', async t => {
  let finish, signal;
  const f = fixture(t, { limits: { operationTimeoutMs: 10 }, deliver: async (_record, options) => {
    signal = options.signal; return new Promise(resolve => { finish = resolve; });
  } });
  const saved = await f.service.submit(input()); f.service.confirm({ id, digest: saved.digest });
  const alive = setTimeout(() => {}, 1000);
  try { await f.service.tick(); } finally { clearTimeout(alive); }
  assert.equal(signal.aborted, true); assert.equal(f.service.receipt(id).status, 'sending');
  finish({ status: 'accepted' }); await flush(); assert.equal(f.service.receipt(id).status, 'sending');
  f.advance(10); await f.service.tick(); assert.equal(f.service.receipt(id).status, 'delivered');
});

test('core ignores no unknown authority fields and enforces small, normalized geometry and transport limits', () => {
  for (const change of [{ target: { key: 'evil' } }, { requestId: secondId }, { sourceMachine: 'other' },
    { note: 'x'.repeat(2001) }, { reason: 'force_execute' }, { annotations: [{ id: markId, x: .8, y: 0, width: .3, height: 1, note: '' }], images: [image()] },
    { images: [image('annotated')] }, { images: [{ ...image(), width: 5000 }] }, { context: { ...input().context, pageUrl: 'file:///private/file' } }])
    assert.throws(() => normalizeFeedbackInput({ ...input(), ...change }), FeedbackError);
  const normal = normalizeFeedbackInput(input()); assert.equal(normal.images.length, 0);
  assert.match(feedbackRequestId('ged', id), /^[a-f0-9-]{36}$/);
  assert.notEqual(feedbackRequestId('ged', id), feedbackRequestId('wandou', id));
});

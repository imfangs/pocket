import test from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { openDB, deleteDB } from 'idb';
import { createFeedbackDraftStore } from '../packages/feedback-kit/browser/drafts.ts';
import { createFeedbackPanelController } from '../packages/feedback-kit/react/controller.ts';

const id = () => crypto.randomUUID();
const context = { pageUrl: 'https://example.test/page', pageTitle: 'Synthetic page', frontendVersion: 'qa', viewport: { width: 390, height: 844, dpr: 1 } };
const initial = (overrides = {}) => ({ id: id(), appId: 'demo', context, note: '', reason: 'unspecified', annotations: [],
  autoDirect: true, touched: false, phase: 'editing', revision: 0, updatedAt: 1, ...overrides });
const input = draft => ({ schemaVersion: 1, id: draft.id, appId: draft.appId, note: draft.note, reason: draft.reason,
  context: draft.context, annotations: draft.annotations, images: [], autoDirect: draft.autoDirect });
const receipt = (draft, status = 'received', updatedAt = 2) => ({ schemaVersion: 1, id: draft.id, appId: draft.appId,
  sourceMachine: 'demo', digest: 'a'.repeat(64), status, createdAt: 1, updatedAt, requestId: id() });
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 5)); };
function store(t, options = {}) {
  const name = `feedback-panel-${id()}`, value = createFeedbackDraftStore({ name, ...options });
  t.after(async () => { await value.dispose(); await deleteDB(name); });
  return { value, name };
}

for (const clearing of ['clearScope', 'clearPrefix', 'clearAll']) {
  test(`another store's ${clearing} invalidates a pending image open before it can recreate a logged-out draft`, async t => {
    const name = `feedback-cross-store-${id()}`;
    const first = createFeedbackDraftStore({ name }), second = createFeedbackDraftStore({ name });
    t.after(async () => { await first.dispose(); await second.dispose(); await deleteDB(name); });
    const delayed = deferred(), started = deferred();
    const blob = new Blob(['old private capture'], { type: 'image/png' });
    Object.defineProperty(blob, 'arrayBuffer', { value: () => { started.resolve(); return delayed.promise; } });
    const scope = 'pocket:ged:login:thread';
    const pending = first.open(scope, initial({ image: { id: id(), blob, mime: 'image/png', width: 1, height: 1 } }));
    const rejected = assert.rejects(pending, /登录状态已变化/);
    await started.promise;
    if (clearing === 'clearAll') await second.clearAll();
    else await second[clearing](clearing === 'clearPrefix' ? 'pocket:ged:' : scope);
    const newer = await second.open(scope, initial({ note: 'new authenticated draft' }));
    delayed.resolve(new TextEncoder().encode('old private capture').buffer); await rejected;
    const restored = await second.open(scope, initial());
    assert.equal(restored.draft.id, newer.draft.id); assert.equal(restored.draft.note, 'new authenticated draft');
    const db = await openDB(name, 1); assert.equal(await db.count('images'), 0); assert.equal(await db.count('entries'), 1); db.close();
  });
}

test('draft storage preserves the image once, isolates scopes and ignores older revisions', async t => {
  const { value, name } = store(t);
  const image = { id: id(), blob: new Blob(['synthetic'], { type: 'image/png' }), mime: 'image/png', width: 20, height: 30 };
  const a = await value.open('scope:a', initial({ image }));
  const b = await value.open('scope:b', initial({ note: 'other' }));
  assert(await value.save(a.lease, { ...a.draft, note: 'latest', revision: 2 }));
  assert.equal(await value.save(a.lease, { ...a.draft, note: 'old', revision: 1 }), false);
  const reopened = await value.open('scope:a', initial());
  assert.equal(reopened.draft.note, 'latest'); assert.equal(await reopened.draft.image.blob.text(), 'synthetic');
  assert.equal((await value.open('scope:b', initial())).draft.id, b.draft.id);
  const db = await openDB(name, 1); assert.equal(await db.count('images'), 1); db.close();
});

test('offline metadata edits reuse saved image bytes even when every Blob read fails', async t => {
  const { value, name } = store(t);
  const image = { id: id(), blob: new Blob(['saved image'], { type: 'image/png' }), mime: 'image/png', width: 20, height: 30 };
  const saved = await value.open('scope', initial({ image }));
  const failing = t.mock.method(Blob.prototype, 'arrayBuffer', async () => { throw new DOMException('offline', 'NotReadableError'); });
  const edited = { ...structuredClone(saved.draft), note: 'OFFLINE DRAFT KEEP', revision: 1,
    annotations: [{ id: id(), x: 0.1, y: 0.2, width: 0.3, height: 0.2, note: 'mark survives' }] };
  assert(await value.save(saved.lease, edited));
  const restored = await value.open('scope', initial({ image: { ...image, id: id() } }));
  assert.equal(restored.draft.note, edited.note); assert.deepEqual(restored.draft.annotations, edited.annotations);
  assert.equal(restored.draft.image.id, image.id); assert.equal(failing.mock.callCount(), 0);
  const db = await openDB(name, 1); const [storedImage] = await db.getAll('images');
  assert.equal(new TextDecoder().decode(storedImage.bytes), 'saved image'); assert.equal(await db.count('images'), 1); db.close();
});

test('a replacement image read failure leaves the previous durable draft intact', async t => {
  const { value } = store(t);
  const image = { id: id(), blob: new Blob(['saved image'], { type: 'image/png' }), mime: 'image/png', width: 20, height: 30 };
  const saved = await value.open('scope', initial({ image, note: 'original' }));
  const blob = new Blob(['unreadable'], { type: 'image/png' });
  let offline = true;
  Object.defineProperty(blob, 'arrayBuffer', { value: async () => {
    if (offline) throw new DOMException('offline', 'NotReadableError');
    return new TextEncoder().encode('recovered').buffer;
  } });
  const replacement = { ...saved.draft, note: 'replacement', revision: 1, image: { ...image, id: id(), blob } };
  await assert.rejects(value.save(saved.lease, replacement), { name: 'NotReadableError' });
  const restored = await value.open('scope', initial());
  assert.equal(restored.draft.note, 'original'); assert.equal(restored.draft.image.id, image.id);
  offline = false; assert(await value.save(saved.lease, replacement));
  assert.equal((await value.open('scope', initial())).draft.image.id, replacement.image.id);
});

test('equal revisions accept identical retries but never overwrite a competing edit', async t => {
  const { value } = store(t); const saved = await value.open('scope', initial());
  const current = { ...saved.draft, note: 'current', revision: 1 };
  assert(await value.save(saved.lease, current)); assert(await value.save(saved.lease, structuredClone(current)));
  assert.equal(await value.save(saved.lease, { ...current, note: 'competing' }), false);
  assert.equal((await value.open('scope', initial())).draft.note, 'current');
});

test('a delayed image replacement rechecks the revision after another edit commits', async t => {
  const { value, name } = store(t); const delayed = deferred();
  const saved = await value.open('scope', initial());
  const blob = new Blob(['late'], { type: 'image/png' });
  Object.defineProperty(blob, 'arrayBuffer', { value: () => delayed.promise });
  const pending = value.save(saved.lease, { ...saved.draft, revision: 1,
    image: { id: id(), blob, mime: 'image/png', width: 1, height: 1 } });
  await settle();
  const latest = { ...saved.draft, note: 'newer', revision: 2,
    image: { id: id(), blob: new Blob(['newer'], { type: 'image/png' }), mime: 'image/png', width: 2, height: 2 } };
  assert(await value.save(saved.lease, latest)); delayed.resolve(new TextEncoder().encode('late').buffer);
  assert.equal(await pending, false);
  const restored = await value.open('scope', initial()); assert.equal(restored.draft.image.id, latest.image.id);
  const db = await openDB(name, 1); assert.equal(await db.count('images'), 1); db.close();
});

test('a delayed initial capture cannot overwrite a draft created by another opener', async t => {
  const { value, name } = store(t); const delayed = deferred();
  const blob = new Blob(['late'], { type: 'image/png' });
  Object.defineProperty(blob, 'arrayBuffer', { value: () => delayed.promise });
  const pending = value.open('scope', initial({ image: { id: id(), blob, mime: 'image/png', width: 1, height: 1 } }));
  await settle(); const first = await value.open('scope', initial({ note: 'first saved' }));
  delayed.resolve(new TextEncoder().encode('late').buffer);
  const second = await pending; assert.equal(second.draft.id, first.draft.id); assert.equal(second.draft.note, 'first saved');
  const db = await openDB(name, 1); assert.equal(await db.count('entries'), 1); assert.equal(await db.count('images'), 0); db.close();
});

test('completion and logout leases prevent late writes from resurrecting drafts or deleting a newer one', async t => {
  const { value } = store(t); const old = await value.open('scope', initial({ note: 'old' }));
  assert(await value.remove(old.lease));
  assert.equal(await value.save(old.lease, { ...old.draft, revision: 10 }), false);
  const fresh = await value.open('scope', initial({ note: 'fresh' }));
  assert.equal(await value.remove(old.lease), false);
  assert.equal((await value.open('scope', initial())).draft.note, 'fresh');
  await value.clearScope('scope');
  assert.equal(await value.save(fresh.lease, { ...fresh.draft, revision: 11 }), false);
  const newest = await value.open('scope', initial()); assert.notEqual(newest.lease.epoch, fresh.lease.epoch);
});

test('capacity rejection leaves existing feedback intact', async t => {
  const { value } = store(t, { maxScopes: 1 });
  const a = await value.open('a', initial({ note: 'keep' }));
  await assert.rejects(value.open('b', initial({ note: 'new' })), /空间/);
  assert.equal((await value.open('a', initial())).draft.id, a.draft.id);
});

test('machine-scoped logout clears only its prefix and invalidates its old leases', async t => {
  const { value } = store(t);
  const ged = await value.open('pocket:ged:actor:a', initial({ note: 'old ged' }));
  const wandou = await value.open('pocket:wandou:actor:a', initial({ note: 'keep wandou' }));
  await value.clearPrefix('pocket:ged:');
  assert.equal(await value.save(ged.lease, { ...ged.draft, revision: 100 }), false);
  assert.equal((await value.open('pocket:wandou:actor:a', initial())).draft.id, wandou.draft.id);
  assert.equal((await value.open('pocket:wandou:actor:a', initial())).draft.note, 'keep wandou');
  assert.notEqual((await value.open('pocket:ged:actor:a', initial())).draft.id, ged.draft.id);
});

test('logout while an image is being prepared prevents a late draft open from storing it', async t => {
  const { value, name } = store(t); const pending = deferred();
  const blob = new Blob(['later'], { type: 'image/png' });
  Object.defineProperty(blob, 'arrayBuffer', { value: () => pending.promise });
  const opening = value.open('pocket:ged:actor:a', initial({ image: { id: id(), blob, mime: 'image/png', width: 1, height: 1 } }));
  await settle(); await value.clearPrefix('pocket:ged:'); pending.resolve(new Uint8Array([1]).buffer);
  await assert.rejects(opening, /登录状态/);
  const db = await openDB(name, 1); assert.equal(await db.count('entries'), 0); assert.equal(await db.count('images'), 0); db.close();
});

test('the immutable journal exists before POST, and duplicate clicks share that POST', async t => {
  const { value } = store(t); let controller, calls = 0, posted; const delivery = deferred();
  controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value, prepare: async draft => input(draft),
    submit: async data => { calls++; posted = data; const saved = await value.open('scope', initial());
      assert.equal(saved.draft.phase, 'unknown'); assert.deepEqual(saved.draft.preparedInput, data); return delivery.promise; },
    status: async () => null });
  await controller.initialize(); controller.edit({ note: 'one explicit feedback' });
  const first = controller.submit(); assert.equal(controller.submit(), first); await settle();
  assert.equal(calls, 1); controller.edit({ note: 'must not change' });
  assert.equal(controller.getSnapshot().draft.note, posted.note);
  delivery.resolve(receipt(posted)); await first;
  assert.equal(controller.getSnapshot().draft.receipt.status, 'received');
  assert.notEqual((await value.open('scope', initial())).draft.id, posted.id);
  controller.dispose();
});

test('lost POST reply freezes content; lookup precedes an explicit same-ID retry', async t => {
  const { value } = store(t); const calls = []; let found = null;
  const controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value, prepare: async draft => input(draft),
    submit: async data => { calls.push(structuredClone(data)); if (calls.length === 1) throw new Error('lost'); return receipt(data); },
    status: async () => found });
  await controller.initialize(); controller.edit({ note: 'unchanged original' }); await controller.submit();
  assert.equal(controller.getSnapshot().draft.phase, 'unknown'); controller.edit({ note: 'different' });
  await controller.submit(); assert.equal(calls.length, 1);
  await controller.check(); assert.equal(controller.getSnapshot().notFound, true);
  await controller.submit(true); assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  found = receipt(calls[0], 'delivered', 4); await controller.check();
  assert.equal(controller.getSnapshot().draft.receipt.status, 'delivered');
  found = receipt(calls[0], 'queued', 3); await controller.check();
  assert.equal(controller.getSnapshot().draft.receipt.status, 'delivered');
  found = receipt(calls[0], 'queued', 4); await controller.check();
  assert.equal(controller.getSnapshot().draft.receipt.status, 'delivered');
  found = null; await controller.check(); assert.equal(controller.getSnapshot().notFound, false);
  controller.dispose();
});

test('closing before preparation finishes starts no POST and keeps the written draft', async t => {
  const { value } = store(t); const preparation = deferred(); let posts = 0;
  const controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value,
    prepare: async () => preparation.promise, submit: async data => { posts++; return receipt(data); }, status: async () => null });
  await controller.initialize(); controller.edit({ note: 'draft survives' });
  const pending = controller.submit(); await settle(); const draft = controller.getSnapshot().draft;
  controller.dispose(); preparation.resolve(input(draft)); await pending; await settle();
  assert.equal(posts, 0); const restored = await value.open('scope', initial()); assert.equal(restored.draft.note, 'draft survives');
  assert.equal(restored.draft.phase, 'editing');
});

test('a late successful POST after logout cannot erase a new login draft', async t => {
  const { value } = store(t); const delivery = deferred(); let posted;
  const controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value,
    prepare: async draft => input(draft), submit: async data => { posted = data; return delivery.promise; }, status: async () => null });
  await controller.initialize(); controller.edit({ note: 'old user' }); const pending = controller.submit(); await settle();
  controller.dispose(); await value.clearAll(); const next = await value.open('scope', initial({ note: 'new login' }));
  delivery.resolve(receipt(posted)); await pending;
  assert.equal((await value.open('scope', initial())).draft.id, next.draft.id);
  assert.equal((await value.open('scope', initial())).draft.note, 'new login');
});

test('a receipt for another feedback never confirms the current submission', async t => {
  const { value } = store(t);
  const controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value,
    prepare: async draft => input(draft), submit: async data => ({ ...receipt(data), id: id() }), status: async () => null });
  await controller.initialize(); controller.edit({ note: 'my feedback' }); await controller.submit();
  assert.equal(controller.getSnapshot().draft.phase, 'unknown'); assert.equal(controller.getSnapshot().draft.receipt, undefined);
  assert.match(controller.getSnapshot().error, /待确认/); controller.dispose();
});

test('an explicit validation rejection restores editing, while an uncertain retry remains frozen', async t => {
  const { value } = store(t); let mode = 'reject';
  const controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value,
    prepare: async draft => input(draft), submit: async () => { throw Object.assign(new Error('Too large'), mode === 'reject' ? { status: 413 } : {}); },
    status: async () => null });
  await controller.initialize(); controller.edit({ note: 'initial' }); await controller.submit();
  assert.equal(controller.getSnapshot().draft.phase, 'editing'); controller.edit({ note: 'fixed' });
  mode = 'unknown'; await controller.submit(); await controller.check();
  mode = 'reject'; await controller.submit(true);
  assert.equal(controller.getSnapshot().draft.phase, 'unknown'); assert.equal(controller.getSnapshot().draft.note, 'fixed'); controller.dispose();
});

test('delivery recovery keeps the same feedback ID and checks an uncertain retry before trying again', async t => {
  const { value } = store(t); let posted, retries = 0, checks = 0;
  const controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value,
    prepare: async draft => input(draft), submit: async data => { posted = data; return receipt(data, 'needs_attention'); },
    status: async observed => { checks++; assert.equal(observed, posted.id); return receipt(posted, 'needs_attention', 3); },
    retry: async observed => { retries++; assert.equal(observed, posted.id); if (retries === 1) throw Error('lost'); return receipt(posted, 'queued', 4); } });
  await controller.initialize(); controller.edit({ note: 'one feedback' }); await controller.submit();
  await controller.retryDelivery(); await controller.retryDelivery(); assert.equal(retries, 1);
  assert.equal(controller.getSnapshot().recoveryUnknown, true); await controller.check(); assert.equal(checks, 1);
  await controller.retryDelivery(); assert.equal(retries, 2); assert.equal(controller.getSnapshot().draft.receipt.status, 'queued'); controller.dispose();
});

test('a hung submit has a finite deadline, preserves its ID, and ignores a late reply until lookup', async t => {
  const { value } = store(t); const delivery = deferred(); let signal, posted;
  const controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value, timeoutMs: 10,
    prepare: async draft => input(draft), submit: async (data, requestSignal) => { posted = data; signal = requestSignal; return delivery.promise; },
    status: async () => receipt(posted) });
  await controller.initialize(); controller.edit({ note: 'finite wait' }); await controller.submit();
  assert.equal(controller.getSnapshot().busy, false); assert.equal(controller.getSnapshot().draft.phase, 'unknown'); assert.equal(signal.aborted, true);
  delivery.resolve(receipt(posted)); await settle(); assert.equal(controller.getSnapshot().draft.receipt, undefined);
  await controller.check(); assert.equal(controller.getSnapshot().draft.receipt.status, 'received'); controller.dispose();
});

test('restored drafts keep their captured context, while explicit start-new uses the current capture context', async t => {
  const { value } = store(t);
  await value.open('scope', initial({ note: 'old draft', touched: true, context: { ...context, frontendVersion: 'old-build' } }));
  const controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value,
    prepare: async draft => input(draft), submit: async data => receipt(data), status: async () => null });
  await controller.initialize(); const old = controller.getSnapshot().draft.id;
  assert.equal(controller.getSnapshot().restored, true); assert.equal(controller.getSnapshot().draft.context.frontendVersion, 'old-build');
  await controller.startNew(); assert.notEqual(controller.getSnapshot().draft.id, old);
  assert.equal(controller.getSnapshot().draft.note, ''); assert.equal(controller.getSnapshot().draft.context.frontendVersion, 'qa');
  assert.equal(controller.getSnapshot().restored, false); controller.dispose();
});

test('StrictMode-style abandoned setup does not open storage or publish into the live controller', async t => {
  const { value } = store(t); let opens = 0, posts = 0;
  const observed = { ...value, open: async (...args) => { opens++; return value.open(...args); } };
  const options = { appId: 'demo', scope: 'scope', context, store: observed,
    prepare: async draft => input(draft), submit: async data => { posts++; return receipt(data); }, status: async () => null };
  const abandoned = createFeedbackPanelController(options); const first = abandoned.initialize(); abandoned.dispose();
  const current = createFeedbackPanelController(options); await current.initialize(); await first;
  assert.equal(opens, 1); assert.equal(abandoned.getSnapshot().ready, false); assert.equal(current.getSnapshot().ready, true);
  await current.initialize(); assert.equal(opens, 1, 'setup does not reload an already initialized controller');
  assert.equal(posts, 0); current.dispose();
});

test('an old delayed initialization cannot publish over a new source scope', async t => {
  const { value } = store(t); const delay = deferred();
  const observed = { ...value, open: async (scope, draft) => {
    if (scope === 'old') await delay.promise;
    return value.open(scope, draft);
  } };
  const options = { appId: 'demo', context, store: observed, prepare: async draft => input(draft),
    submit: async data => receipt(data), status: async () => null };
  const old = createFeedbackPanelController({ ...options, scope: 'old' }); const pending = old.initialize(); await settle(); old.dispose();
  const current = createFeedbackPanelController({ ...options, scope: 'current', context: { ...context, pageTitle: 'New scope' } });
  await current.initialize(); current.edit({ note: 'new text' }); delay.resolve(); await pending;
  assert.equal(old.getSnapshot().ready, false); assert.equal(current.getSnapshot().draft.note, 'new text');
  assert.equal(current.getSnapshot().draft.context.pageTitle, 'New scope'); current.dispose();
});

test('controller disposal flushes the last edit before an owned store is closed', async t => {
  const { value, name } = store(t);
  const controller = createFeedbackPanelController({ appId: 'demo', scope: 'scope', context, store: value,
    prepare: async draft => input(draft), submit: async data => receipt(data), status: async () => null });
  await controller.initialize(); controller.edit({ note: 'last keystroke before close' });
  await controller.dispose(); await value.dispose();
  const db = await openDB(name, 1), draft = await db.get('entries', 'scope');
  assert.equal(draft.note, 'last keystroke before close'); db.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createAttachmentDraftController, attachmentPath } from '../src/attachments.ts';
import { createAttachmentUploadScheduler } from '../src/attachmentUploadScheduler.ts';
import { attachmentSubmissionManager, createAttachmentSubmissionManager } from '../src/attachmentSubmissionManager.ts';
import { createSubmittedQueryStore, visibleSubmittedQueries } from '../src/submittedQueries.ts';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', requestId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', hash = 'c'.repeat(64);
const ready = item => ({ id: item.id, name: item.name, size: item.size, mime: item.mime, kind: 'file',
  url: attachmentPath(id, item.id), sha256: hash, sourceSha256: hash, sourceSize: item.size });
async function until(check) { for (let n = 0; n < 80; n++) { if (check()) return; await setImmediate(); } assert.ok(check()); }
function fixture(t, overrides = {}) {
  const drafts = new Map(), store = createSubmittedQueryStore(), started = [], releases = new Map();
  let accepted = false, reservations = 0, sends = 0;
  const uploads = createAttachmentDraftController(drafts, {
    upload: async (_thread, item, owner) => { started.push({ item, owner }); await new Promise(done => releases.set(item.id, done)); return ready(item); },
    metadata: async (_thread, fileId) => ready(started.find(value => value.item.id === fileId).item), list: async () => ({ attachments: [] }), remove: async () => ({}),
  }, async () => hash, createAttachmentUploadScheduler());
  const manager = createAttachmentSubmissionManager(drafts, store, uploads, {
    reserve: async () => { reservations++; return { requestId, status: 'queued', queueRevision: 0, uploadProgress: { total: 16, uploaded: 0, status: 'uploading' } }; },
    receipt: async () => { if (accepted) sends++; return { requestId, status: accepted ? 'accepted' : 'queued', queueRevision: 0,
      uploadProgress: { total: 16, uploaded: accepted ? 16 : 0, status: accepted ? 'ready' : 'uploading' } }; },
    cancel: async () => ({}), ...overrides,
  }, { machine: () => 'ged', intervalMs: 100000 });
  t.after(() => { manager.dispose(); for (const finish of releases.values()) finish(); });
  return { drafts, store, uploads, manager, started, releases, setAccepted() { accepted = true; }, get reservations() { return reservations; }, get sends() { return sends; } };
}

test('sending an in-progress batch keeps one immutable request while uploads finish independently of its next draft', async t => {
  const f = fixture(t);
  f.drafts.set(id, { text: 'Captured query' });
  f.uploads.add(id, Array.from({ length: 16 }, (_, n) => new File(['bytes'], `file-${n}.txt`, { type: 'text/plain' })));
  await until(() => f.started.length === 16);
  await f.manager.submit({ threadId: id, requestId, text: 'Captured query', files: f.uploads.get(id), autoDirect: true, enqueue: true });
  f.drafts.set(id, { text: 'A newer independent draft' });
  assert.equal(f.uploads.get(id).length, 0);
  assert.equal(f.store.getThread(id).length, 1); assert.equal(f.store.getThread(id)[0].requestId, requestId);
  assert.equal(f.store.getThread(id)[0].status, 'uploading'); assert.equal(f.sends, 0);
  for (const finish of [...f.releases.values()]) finish();
  await until(() => f.store.getThread(id)[0].uploadProgress.uploaded === 16);
  assert.notEqual(f.store.getThread(id)[0].status, 'accepted', 'Uploaded bytes are not a native send receipt');
  f.setAccepted(); await f.manager.actions(id).check(requestId);
  assert.equal(f.store.getThread(id)[0].status, 'accepted'); assert.equal(f.reservations, 1);
  assert.equal(f.drafts.get(id).text, 'A newer independent draft');
  assert.equal(f.started.length, 16);
  assert.equal(new Set(f.started.map(value => value.item.id)).size, 16, 'Each original active PUT finishes once after ownership transfer');
  assert.ok(f.started.every(value => value.owner === undefined), 'Already active PUTs are captured without replaying them under the request ID');
});

test('an uncertain reservation response uses receipt reads and never repeats its original POST', async t => {
  const f = fixture(t, { reserve: async () => { throw new TypeError('Lost response'); } });
  f.uploads.add(id, [new File(['bytes'], 'file.txt', { type: 'text/plain' })]);
  const files = f.uploads.get(id);
  await assert.rejects(f.manager.submit({ threadId: id, requestId, text: 'Keep my query', files, autoDirect: true, enqueue: true }));
  assert.equal(f.store.getThread(id)[0].status, 'unknown');
  await f.manager.actions(id).check(requestId);
  assert.equal(f.store.getThread(id).length, 1); assert.equal(f.store.getThread(id)[0].text, 'Keep my query');
});

function lifecycleFixture(t, overrides = {}) {
  const drafts = new Map(), store = createSubmittedQueryStore(), calls = [], hashReleases = [];
  const selected = overrides.selectedFiles?.[0] ?? new File(['original bytes'], 'original.txt', { type: 'text/plain' });
  let receipt = { requestId, status: 'not_found' }, posts = 0, reads = 0;
  const uploads = createAttachmentDraftController(drafts, {
    upload: async (_thread, item, owner) => { calls.push(['PUT', item.id, owner]); return ready(item); },
    metadata: async (_thread, fileId) => ready({ id: fileId, name: selected.name, size: selected.size, mime: selected.type }),
    list: async () => ({ attachments: [] }), remove: async (_thread, fileId) => { calls.push(['file_DELETE', fileId]); },
    ...overrides.files,
  }, () => new Promise(resolve => hashReleases.push(() => resolve(hash))), createAttachmentUploadScheduler());
  const manager = createAttachmentSubmissionManager(drafts, store, uploads, {
    reserve: async intent => { posts++; calls.push(['POST', intent.requestId]); throw Object.assign(Error('Definite quota rejection'), { status: 400 }); },
    receipt: async (_thread, originalId) => { reads++; calls.push(['GET', originalId]); return receipt; },
    cancel: async (_thread, originalId, revision) => { calls.push(['message_DELETE', originalId, revision]); },
    ...overrides.messages,
  }, { machine: () => 'ged', intervalMs: 5 });
  t.after(() => { manager.dispose(); hashReleases.splice(0).forEach(finish => finish()); });
  uploads.add(id, overrides.selectedFiles ?? [selected]);
  const items = uploads.get(id), fileId = items[0].id;
  const submit = () => manager.submit({ threadId: id, requestId, text: 'Keep original query', files: items, autoDirect: true, enqueue: true });
  return { drafts, store, uploads, manager, selected, fileId, calls, submit, releaseHash() { hashReleases.splice(0).forEach(finish => finish()); },
    setReceipt(value) { receipt = value; }, get posts() { return posts; }, get reads() { return reads; } };
}

test('definite unreserved rejection can cancel after original-ID absence, release its File and preserve the next draft', async t => {
  const f = lifecycleFixture(t);
  await assert.rejects(f.submit(), /quota rejection/);
  f.drafts.set(id, { text: 'A newer independent draft' });
  const cancelled = f.manager.actions(id).cancel(requestId);
  await setImmediate();
  assert.equal(f.uploads.getSubmission(id, requestId)[0].file, f.selected, 'An active source hash must finish before its File owner retires');
  f.releaseHash(); await cancelled;
  assert.equal(f.store.getThread(id)[0].status, 'cancelled');
  assert.equal(f.manager.hasSubmission(id, requestId), false); assert.equal(f.uploads.hasSubmission(id, requestId), false);
  assert.equal(f.drafts.get(id).text, 'A newer independent draft');
  assert.equal(f.posts, 1); assert.deepEqual(f.calls.map(call => call[0]), ['POST', 'GET'], 'No native cancellation, duplicate POST or unused file DELETE');
});

test('dismissing a definite unreserved rejection finishes cleanup before hiding its row and stops background receipt polling', async t => {
  const f = lifecycleFixture(t);
  await assert.rejects(f.submit(), /quota rejection/);
  await delay(20); assert.equal(f.reads, 0, 'A terminal rejection needs no recurring request reads');
  const dismiss = f.manager.dismiss;
  const done = dismiss(id, requestId);
  await setImmediate(); assert.equal(visibleSubmittedQueries(f.store.getThread(id), [], []).length, 1);
  f.releaseHash(); await done;
  const reads = f.reads; await delay(20);
  assert.equal(f.reads, reads); assert.equal(visibleSubmittedQueries(f.store.getThread(id), [], []).length, 0);
  assert.equal(f.store.reloadBlocker(), null); assert.equal(f.manager.hasSubmission(id, requestId), false);
  assert.equal(f.uploads.hasSubmission(id, requestId), false); assert.equal(f.posts, 1);
});

test('not_found cannot cancel or restore while the original reservation POST is still pending', async t => {
  let finishPost;
  const f = lifecycleFixture(t, { messages: { reserve: () => new Promise(resolve => { finishPost = resolve; }) } });
  const pending = f.submit();
  await assert.rejects(f.manager.actions(id).cancel(requestId), /仍待核对/);
  await assert.rejects(f.manager.restore(id, requestId, 'Old query'), /先核对/);
  assert.equal(f.uploads.getSubmission(id, requestId)[0].file, f.selected);
  assert.deepEqual(f.calls.filter(call => call[0].endsWith('DELETE')), []);
  f.setReceipt({ requestId, status: 'queued', queueRevision: 0, uploadProgress: { total: 1, uploaded: 0, status: 'uploading' } });
  finishPost({ requestId, status: 'queued', queueRevision: 0, uploadProgress: { total: 1, uploaded: 0, status: 'uploading' } }); await pending;
  const cancelled = f.manager.actions(id).cancel(requestId); f.releaseHash(); await cancelled;
  assert.deepEqual(f.calls.filter(call => call[0] === 'message_DELETE'), [['message_DELETE', requestId, 0]]);
  assert.equal(f.manager.hasSubmission(id, requestId), false);
});

test('a lost reservation response followed by not_found preserves original Files and keeps read-only recovery', async t => {
  const f = lifecycleFixture(t, { messages: { reserve: async () => { throw new TypeError('Lost reservation response'); } } });
  await assert.rejects(f.submit(), /Lost reservation/);
  await assert.rejects(f.manager.actions(id).cancel(requestId), /仍待核对/);
  await assert.rejects(f.manager.restore(id, requestId, 'Old query'), /先核对/);
  await delay(20);
  assert.ok(f.reads > 1); assert.equal(f.manager.hasSubmission(id, requestId), true);
  assert.equal(f.uploads.getSubmission(id, requestId)[0].file, f.selected);
  assert.deepEqual(f.calls.filter(call => call[0] !== 'GET'), [], 'Uncertainty never issues PUT, DELETE or a second reservation POST');
});

test('known reservation evidence cannot be discarded by a later missing GET or fall through into generic re-edit', async t => {
  const f = lifecycleFixture(t);
  await assert.rejects(f.submit(), /quota rejection/);
  f.setReceipt({ requestId, status: 'queued', queueRevision: 0, uploadProgress: { total: 1, uploaded: 0, status: 'uploading' } });
  await f.manager.actions(id).check(requestId);
  f.setReceipt({ requestId, status: 'not_found' });
  await assert.rejects(f.manager.actions(id).cancel(requestId), /仍待核对/);
  await assert.rejects(f.manager.restore(id, requestId, 'Original query'), /先核对/);
  assert.equal(f.uploads.getSubmission(id, requestId)[0].file, f.selected);
  assert.deepEqual(f.calls.filter(call => call[0].endsWith('DELETE')), []);
});

test('a mismatched receipt cannot hide a rejected upload or release its original File', async t => {
  const f = lifecycleFixture(t);
  await assert.rejects(f.submit(), /quota rejection/);
  f.setReceipt({ requestId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', status: 'not_found' });
  await assert.rejects(f.manager.dismiss(id, requestId), /回执与当前消息不匹配/);
  assert.equal(visibleSubmittedQueries(f.store.getThread(id), [], []).length, 1);
  assert.equal(f.uploads.getSubmission(id, requestId)[0].file, f.selected);
  assert.equal(f.manager.hasSubmission(id, requestId), true);
});

test('a fresh accepted receipt wins over dismissing a rejected upload and retires its confirmed File owner', async t => {
  const f = lifecycleFixture(t);
  await assert.rejects(f.submit(), /quota rejection/);
  f.setReceipt({ requestId, status: 'accepted', uploadProgress: { total: 1, uploaded: 1, status: 'ready' },
    attachmentUploads: [{ id: f.fileId, name: f.selected.name, size: f.selected.size, mime: f.selected.type, status: 'uploaded',
      attachment: ready({ id: f.fileId, name: f.selected.name, size: f.selected.size, mime: f.selected.type }) }] });
  await assert.rejects(f.manager.dismiss(id, requestId), /已发送，无法取消/);
  assert.equal(f.store.getThread(id)[0].status, 'accepted'); assert.notEqual(f.store.getThread(id)[0].dismissed, true);
  assert.equal(f.uploads.hasSubmission(id, requestId), false); assert.equal(f.manager.hasSubmission(id, requestId), false);
  assert.deepEqual(f.calls.filter(call => call[0].endsWith('DELETE')), []);
});

test('failed cleanup during dismissal keeps the row and allows the same attachment ID cleanup without replaying the message', async t => {
  let completeUpload, deletes = 0;
  const f = lifecycleFixture(t, { files: {
    upload: async (_thread, item) => new Promise(resolve => { completeUpload = () => resolve(ready(item)); }),
    remove: async (_thread, fileId) => { deletes++; f.calls.push(['file_DELETE', fileId]); if (deletes === 1) throw new TypeError('Cleanup reply lost'); },
  } });
  f.releaseHash(); await until(() => completeUpload);
  await assert.rejects(f.submit(), /quota rejection/);
  const first = f.manager.dismiss(id, requestId);
  await setImmediate(); completeUpload();
  await assert.rejects(first, /清理结果待核对/);
  assert.equal(visibleSubmittedQueries(f.store.getThread(id), [], []).length, 1);
  assert.equal(f.store.getThread(id)[0].status, 'cancelled'); assert.equal(f.manager.hasSubmission(id, requestId), true);
  await f.manager.dismiss(id, requestId);
  assert.equal(visibleSubmittedQueries(f.store.getThread(id), [], []).length, 0);
  assert.equal(f.manager.hasSubmission(id, requestId), false); assert.equal(f.uploads.hasSubmission(id, requestId), false);
  assert.deepEqual(f.calls.filter(call => call[0] === 'file_DELETE'), [['file_DELETE', f.fileId], ['file_DELETE', f.fileId]]);
  assert.equal(f.posts, 1); assert.deepEqual(f.calls.filter(call => call[0] === 'message_DELETE'), []);
});

test('last App owner release stops polling immediately and drops local Files without cancelling the persisted request', async t => {
  const f = lifecycleFixture(t, { messages: { reserve: async () => { throw new TypeError('Original reservation result unknown'); } } });
  const release = f.manager.retainOwner();
  await assert.rejects(f.submit(), /result unknown/); await delay(20);
  assert.ok(f.reads > 0); const reads = f.reads, status = f.store.getThread(id)[0].status;
  release();
  await assert.rejects(f.manager.actions(id).check(requestId), /会话已关闭/);
  await delay(20);
  assert.equal(f.reads, reads); assert.equal(f.manager.hasSubmission(id, requestId), false);
  assert.equal(f.uploads.hasSubmission(id, requestId), false); assert.deepEqual(f.uploads.get(id), []);
  assert.equal(f.store.getThread(id)[0].status, status, 'Leaving authentication does not fabricate cancellation or a new receipt');
  assert.deepEqual(f.calls.filter(call => call[0].endsWith('DELETE')), []);
});

test('StrictMode effect release and synchronous reacquire preserve the same request and resume its read-only recovery', async t => {
  const f = lifecycleFixture(t, { messages: { reserve: async () => { throw new TypeError('Original reservation result unknown'); } } });
  const firstRelease = f.manager.retainOwner();
  await assert.rejects(f.submit(), /result unknown/);
  firstRelease(); const finalRelease = f.manager.retainOwner();
  await delay(20);
  assert.ok(f.reads > 0); assert.equal(f.manager.hasSubmission(id, requestId), true);
  assert.equal(f.uploads.getSubmission(id, requestId)[0].file, f.selected);
  assert.deepEqual(f.calls.filter(call => call[0] !== 'GET'), []);
  finalRelease(); await setImmediate(); assert.equal(f.manager.hasSubmission(id, requestId), false);
});

test('a remaining App owner keeps recovery alive and repeated release never disposes that owner', async t => {
  const f = lifecycleFixture(t, { messages: { reserve: async () => { throw new TypeError('Original reservation result unknown'); } } });
  const releaseA = f.manager.retainOwner(), releaseB = f.manager.retainOwner();
  await assert.rejects(f.submit(), /result unknown/);
  releaseA(); releaseA(); await delay(20);
  assert.ok(f.reads > 0); assert.equal(f.manager.hasSubmission(id, requestId), true);
  releaseB(); await setImmediate(); assert.equal(f.manager.hasSubmission(id, requestId), false);
});

test('disposing during reservation aborts the local transport and late accepted metadata cannot revive its owner', async t => {
  let finishPost, signal;
  const f = lifecycleFixture(t, { messages: { reserve: (_intent, requestSignal) => {
    signal = requestSignal; return new Promise(resolve => { finishPost = resolve; });
  } } });
  const pending = f.submit(), status = f.store.getThread(id)[0].status;
  f.manager.dispose();
  assert.equal(signal.aborted, true); assert.equal(f.manager.hasSubmission(id, requestId), false);
  finishPost({ requestId, status: 'accepted', uploadProgress: { total: 1, uploaded: 1, status: 'ready' } }); await pending;
  f.releaseHash(); await setImmediate();
  assert.equal(f.store.getThread(id)[0].status, status); assert.equal(f.uploads.hasSubmission(id, requestId), false);
  await assert.rejects(f.submit(), /会话已关闭/);
  assert.deepEqual(f.calls.filter(call => call[0].endsWith('DELETE')), []);
});

test('disposing an outstanding receipt aborts it and rejects new actions even if its old success arrives later', async t => {
  let finishRead, signal;
  const f = lifecycleFixture(t, { messages: {
    reserve: async () => { throw new TypeError('Unknown reservation'); },
    receipt: (_thread, _originalId, requestSignal) => { signal = requestSignal; return new Promise(resolve => { finishRead = resolve; }); },
  } });
  await assert.rejects(f.submit(), /Unknown reservation/);
  const read = f.manager.actions(id).check(requestId); await until(() => finishRead);
  f.manager.dispose(); assert.equal(signal.aborted, true);
  finishRead({ requestId, status: 'accepted' }); await read;
  assert.equal(f.store.getThread(id)[0].status, 'unknown'); assert.equal(f.manager.hasSubmission(id, requestId), false);
  await assert.rejects(f.manager.dismiss(id, requestId), /会话已关闭/);
  assert.deepEqual(f.calls.filter(call => call[0].endsWith('DELETE')), []);
});

test('the shared factory replaces a released App owner instead of returning a disposed manager or controller', async () => {
  const drafts = new Map(), store = createSubmittedQueryStore();
  const first = attachmentSubmissionManager(drafts, store), release = first.retainOwner();
  release(); await setImmediate();
  const second = attachmentSubmissionManager(drafts, store);
  try {
    assert.notEqual(second, first); assert.notEqual(second.uploads, first.uploads);
    const secondRelease = second.retainOwner(); first.dispose();
    assert.equal(attachmentSubmissionManager(drafts, store), second, 'An old teardown cannot invalidate a newer owner');
    secondRelease(); await setImmediate();
  } finally { second.dispose(); }
});

async function readyQueueFixture(t, count = 1) {
  let receipt, files = [], failRecovery = false, messageDeletes = 0, lists = 0;
  const selectedFiles = Array.from({ length: count }, (_, index) => new File(['original bytes'], `original-${index}.txt`, { type: 'text/plain' }));
  const f = lifecycleFixture(t, { selectedFiles, messages: {
    reserve: async () => ({ requestId, status: 'queued', queueRevision: 0, uploadProgress: { total: count, uploaded: 0, status: 'uploading' } }),
    receipt: async () => receipt,
    cancel: async (_thread, originalId, revision) => {
      assert.equal(originalId, requestId); assert.equal(revision, 0); messageDeletes++;
      receipt = { ...receipt, status: 'cancelled' };
    },
  }, files: { list: async () => { lists++; if (failRecovery) throw new TypeError('Recovery response lost'); return { attachments: files }; } } });
  await f.submit(); f.releaseHash();
  await until(() => f.uploads.getSubmission(id, requestId).every(item => item.status === 'uploaded'));
  files = f.uploads.getSubmission(id, requestId).map(item => item.attachment);
  receipt = { requestId, status: 'queued', queueRevision: 0, uploadProgress: { total: count, uploaded: count, status: 'ready' },
    attachmentUploads: files.map(item => ({ id: item.id, name: item.name, size: item.size, mime: item.mime, status: 'uploaded', attachment: item })) };
  return { ...f, get messageDeletes() { return messageDeletes; }, get lists() { return lists; }, get originalFiles() { return files; },
    failRecovery(value = true) { failRecovery = value; }, setReceipt(value) { receipt = value; } };
}

test('a manager still owns complete ready uploads and queued cancellation restores uploaded originals without file DELETE', async t => {
  const f = await readyQueueFixture(t, 2), actions = f.manager.actions(id);
  assert.equal(actions.owns(requestId), true); assert.equal(f.store.getThread(id)[0].uploadProgress.status, 'ready');
  f.drafts.set(id, { text: 'A newer independent draft' });
  assert.equal(await actions.cancel(requestId), 2);
  assert.equal(actions.owns(requestId), false); assert.equal(f.messageDeletes, 1);
  assert.deepEqual(f.calls.filter(call => call[0] === 'file_DELETE'), []);
  assert.equal(f.drafts.get(id).text, 'A newer independent draft');
  assert.deepEqual(f.uploads.get(id).map(item => item.id), f.originalFiles.map(item => item.id));
  assert.equal(f.store.getThread(id)[0].status, 'cancelled'); assert.equal(f.uploads.hasSubmission(id, requestId), false);
});

test('failed ready-file recovery retains a visible retry owner and checks the cancelled request without another DELETE', async t => {
  const f = await readyQueueFixture(t), actions = f.manager.actions(id);
  f.failRecovery();
  await assert.rejects(actions.cancel(requestId), error => error.code === 'attachment_recovery_pending');
  assert.equal(actions.owns(requestId), true); assert.equal(f.store.getThread(id)[0].status, 'cancelled');
  assert.equal(f.store.getThread(id)[0].uploadProgress.code, 'attachment_recovery_pending');
  assert.equal(visibleSubmittedQueries(f.store.getThread(id), [], []).length, 1); assert.equal(f.messageDeletes, 1);
  assert.equal(f.uploads.hasSubmission(id, requestId), false, 'Ready File bytes retire once while their server references await recovery');
  f.failRecovery(false); await actions.check(requestId);
  assert.equal(actions.owns(requestId), false); assert.equal(f.messageDeletes, 1);
  assert.equal(f.uploads.get(id)[0].id, f.originalFiles[0].id);
  assert.equal(f.store.getThread(id)[0].uploadProgress, undefined);
  assert.deepEqual(f.calls.filter(call => call[0] === 'file_DELETE'), []);
});

test('partial recovery remembers files delivered before capacity failure and never unclaims their newer submission', async t => {
  const f = await readyQueueFixture(t, 2), actions = f.manager.actions(id);
  const occupied = Array.from({ length: 15 }, (_, index) => {
    const fileId = `dddddddd-dddd-4ddd-8ddd-${String(index).padStart(12, '0')}`;
    return { id: fileId, name: `occupied-${index}.txt`, size: 5, mime: 'text/plain', kind: 'file', status: 'uploaded',
      attachment: { id: fileId, name: `occupied-${index}.txt`, size: 5, mime: 'text/plain', kind: 'file', sha256: hash, url: attachmentPath(id, fileId) } };
  });
  f.drafts.set(id, { text: 'A separate capacity-limited draft', attachments: occupied });
  await assert.rejects(actions.cancel(requestId), error => error.code === 'attachment_recovery_pending');
  const firstId = f.originalFiles[0].id, secondId = f.originalFiles[1].id;
  assert.equal(f.uploads.get(id).some(item => item.id === firstId), true);
  const newer = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const first = f.uploads.get(id).filter(item => item.id === firstId);
  f.uploads.takeSubmission(id, newer, first);
  // The newer accepted sender can retire its bundle, keeping its claim. This
  // catches an older recovery retry that blindly unclaims all original IDs.
  f.uploads.completeSubmission(id, newer);
  f.drafts.set(id, { text: 'Keep this new text' });
  assert.equal(await actions.cancel(requestId), 1);
  assert.equal(actions.owns(requestId), false); assert.equal(f.messageDeletes, 1);
  assert.deepEqual(f.uploads.get(id).map(item => item.id), [secondId]);
  assert.equal(f.drafts.get(id).text, 'Keep this new text');
  assert.deepEqual(f.calls.filter(call => call[0] === 'file_DELETE'), []);
});

test('ready cancellation yields to a fresh accepted receipt while ordinary rows report no manager ownership', async t => {
  const f = await readyQueueFixture(t), actions = f.manager.actions(id);
  assert.equal(actions.owns('ffffffff-ffff-4fff-8fff-ffffffffffff'), false);
  f.setReceipt({ requestId, status: 'accepted', uploadProgress: { total: 1, uploaded: 1, status: 'ready' },
    attachmentUploads: f.originalFiles.map(item => ({ id: item.id, name: item.name, size: item.size, mime: item.mime, status: 'uploaded', attachment: item })) });
  await assert.rejects(actions.cancel(requestId), /已发送，无法取消/);
  assert.equal(f.store.getThread(id)[0].status, 'accepted'); assert.equal(actions.owns(requestId), false);
  assert.equal(f.messageDeletes, 0); assert.equal(f.lists, 0); assert.deepEqual(f.calls.filter(call => call[0] === 'file_DELETE'), []);
});

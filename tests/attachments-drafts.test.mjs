import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createAttachmentDraftController, attachmentPath, attachmentRefs, canRemoveLocalAttachment, readyAttachments, validateAttachment, MAX_ATTACHMENT_BYTES } from '../src/attachments.ts';
import { createDraftMap, draftThreadIds } from '../src/draftIndicators.ts';
import { hasUpdateBlockingDraft } from '../src/updateDrafts.ts';

const thread = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', hash = 'b'.repeat(64);
const file = (name = 'small.txt') => new File(['hello'], name, { type: 'text/plain' });
const publicFile = (id, overrides = {}) => ({ id, name: 'small.txt', size: 5, mime: 'text/plain', kind: 'file', url: attachmentPath(thread, id), sha256: hash, sourceSha256: hash, sourceSize: 5, ...overrides });
const uuid = n => `cccccccc-cccc-7ccc-8ccc-${String(n).padStart(12, '0')}`;
const statusError = status => Object.assign(new Error(`HTTP ${status}`), { status });
async function until(check) { for (let n = 0; n < 30; n++) { if (check()) return; await setImmediate(); } assert.ok(check(), 'async draft operation should settle'); }
function fixture(overrides = {}, digest = async () => hash) {
  const calls = [], drafts = createDraftMap(() => {});
  const request = {
    upload: async (_thread, item) => { calls.push(['PUT', item.id, item.file]); return publicFile(item.id, { name: item.name }); },
    metadata: async (_thread, id) => { calls.push(['metadata', id]); return publicFile(id); },
    list: async () => ({ attachments: [] }),
    remove: async (_thread, id) => { calls.push(['DELETE', id]); return { deleted: true }; },
    ...overrides,
  };
  return { controller: createAttachmentDraftController(drafts, request, digest), drafts, calls, request };
}

test('an offline selection can be removed locally without networking or losing independent text', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } });
  try {
    const f = fixture();
    f.drafts.set(thread, { text: 'Keep editing offline' });
    const [id] = f.controller.add(thread, [file()]);
    assert.equal(f.controller.get(thread)[0].status, 'failed');
    assert.equal(canRemoveLocalAttachment(f.controller.get(thread)[0]), true);
    await f.controller.remove(thread, id);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.controller.get(thread), []);
    assert.equal(f.drafts.get(thread).text, 'Keep editing offline');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator;
  }
});

test('attachment-only selection is a protected draft and a late upload preserves the independently edited text', async () => {
  let uploaded;
  const f = fixture({ upload: (_thread, item) => new Promise(resolve => { uploaded = () => resolve(publicFile(item.id)); }) });
  const selected = file(), [id] = f.controller.add(thread, [selected]);
  await until(() => uploaded);
  assert.equal(f.controller.get(thread)[0].file, selected);
  assert.deepEqual(draftThreadIds(f.drafts), new Set([thread]));
  assert.equal(hasUpdateBlockingDraft(f.drafts, new Map()), true);
  assert.equal(readyAttachments(f.controller.get(thread)), false);
  f.drafts.set(thread, { ...f.drafts.get(thread), text: 'Newer text typed while uploading' });
  uploaded(); await until(() => f.controller.get(thread)[0].status === 'uploaded');
  assert.equal(f.drafts.get(thread).text, 'Newer text typed while uploading');
  assert.equal(attachmentRefs(f.controller.get(thread))[0].id, id);
  assert.equal(readyAttachments(f.controller.get(thread)), true);
});

test('upload ownership survives leaving one view and subscribing from another without resending', async () => {
  let uploaded, count = 0;
  const f = fixture({ upload: (_thread, item) => { count++; return new Promise(resolve => { uploaded = () => resolve(publicFile(item.id)); }); } });
  let oldUpdates = 0, newUpdates = 0;
  const leave = f.controller.subscribe(thread, () => oldUpdates++);
  f.controller.add(thread, [file()]); await until(() => uploaded); leave();
  const previous = oldUpdates;
  const release = f.controller.subscribe(thread, () => newUpdates++);
  uploaded(); await until(() => f.controller.get(thread)[0].status === 'uploaded');
  assert.equal(count, 1); assert.equal(oldUpdates, previous); assert.ok(newUpdates > 0); release();
});

test('a lost PUT reply is recovered by a metadata GET with the same upload ID, never another PUT', async () => {
  let puts = 0, reads = 0;
  const f = fixture({ upload: async () => { puts++; throw new Error('lost response'); }, metadata: async (_thread, id) => { reads++; return publicFile(id); } });
  const [id] = f.controller.add(thread, [file()]);
  await until(() => f.controller.get(thread)[0].status === 'uploaded');
  assert.equal(puts, 1); assert.equal(reads, 1); assert.equal(f.controller.get(thread)[0].attachment.id, id);
});

test('unknown 404 or still-uploading 409 preserve the File and only permit read-only checks, while explicit removal can finish', async () => {
  let puts = 0, reads = 0, deletes = 0;
  const f = fixture({ upload: async () => { puts++; throw new Error('lost response'); }, metadata: async () => { reads++; throw statusError(reads > 1 ? 409 : 404); }, remove: async () => { deletes++; return { deleted: true }; } });
  const selected = file(), [id] = f.controller.add(thread, [selected]);
  await until(() => reads === 1); await setImmediate();
  assert.equal(f.controller.get(thread)[0].status, 'unknown');
  f.controller.retry(thread, id); await f.controller.check(thread, id);
  assert.equal(puts, 1); assert.equal(reads, 2); assert.equal(f.controller.get(thread)[0].file, selected);
  await f.controller.remove(thread, id);
  assert.equal(deletes, 1); assert.equal(f.controller.get(thread).length, 0);
});

test('definite upload rejection can retry the original File and ID only after an explicit retry', async () => {
  const ids = []; let accept = false;
  const f = fixture({ upload: async (_thread, item) => { ids.push(item.id); if (!accept) throw statusError(413); return publicFile(item.id); } });
  const [id] = f.controller.add(thread, [file()]); await until(() => f.controller.get(thread)[0].status === 'failed');
  assert.deepEqual(ids, [id]); accept = true; f.controller.retry(thread, id);
  await until(() => f.controller.get(thread)[0].status === 'uploaded'); assert.deepEqual(ids, [id, id]);
});

test('selection count and size limits reject the new batch without replacing any previous draft', () => {
  const f = fixture(); f.drafts.set(thread, { text: 'Keep this text' });
  assert.throws(() => f.controller.add(thread, Array.from({ length: 7 }, () => file())), /6个/);
  assert.throws(() => f.controller.add(thread, [{ name: 'huge.bin', size: MAX_ATTACHMENT_BYTES + 1, type: '' }]), /20 MB/);
  assert.equal(f.controller.get(thread).length, 0); assert.equal(f.drafts.get(thread).text, 'Keep this text');
});

test('removing an in-flight file waits for that upload then deletes once without losing newer composer text', async () => {
  let uploaded, deletes = 0;
  const f = fixture({ upload: (_thread, item) => new Promise(resolve => { uploaded = () => resolve(publicFile(item.id)); }), remove: async () => { deletes++; } });
  const [id] = f.controller.add(thread, [file()]); await until(() => uploaded);
  const removing = f.controller.remove(thread, id); assert.equal(f.controller.get(thread)[0].status, 'removing'); assert.equal(deletes, 0);
  f.drafts.set(thread, { ...f.drafts.get(thread), text: 'Keep new text' }); uploaded(); await removing;
  assert.equal(deletes, 1); assert.equal(f.controller.get(thread).length, 0); assert.equal(f.drafts.get(thread).text, 'Keep new text');
});

test('late automatic upload verification cannot make an attachment sendable while its removal is in flight', async () => {
  let finishMetadata, finishDelete;
  const f = fixture({
    upload: async () => { throw new Error('lost upload reply'); },
    metadata: (_thread, id) => new Promise(resolve => { finishMetadata = () => resolve(publicFile(id)); }),
    remove: () => new Promise(resolve => { finishDelete = resolve; }),
  });
  const [id] = f.controller.add(thread, [file()]); await until(() => finishMetadata);
  const removing = f.controller.remove(thread, id);
  assert.equal(f.controller.get(thread)[0].status, 'removing');
  finishMetadata(); await until(() => finishDelete);
  assert.equal(f.controller.get(thread)[0].status, 'removing');
  assert.equal(readyAttachments(f.controller.get(thread)), false);
  assert.deepEqual(attachmentRefs(f.controller.get(thread)), []);
  finishDelete({ deleted: true }); await removing;
  assert.equal(f.controller.get(thread).length, 0);
});

test('a lost PUT result during removal keeps verification unavailable until DELETE settles', async () => {
  let failUpload, finishDelete, reads = 0;
  const f = fixture({
    upload: () => new Promise((_, reject) => { failUpload = reject; }),
    metadata: async (_thread, id) => { reads++; return publicFile(id); },
    remove: () => new Promise(resolve => { finishDelete = resolve; }),
  });
  const [id] = f.controller.add(thread, [file()]); await until(() => failUpload);
  const removing = f.controller.remove(thread, id); failUpload(new Error('lost upload reply'));
  await until(() => finishDelete);
  assert.equal(f.controller.get(thread)[0].status, 'removing');
  await f.controller.check(thread, id);
  assert.equal(reads, 0); assert.equal(readyAttachments(f.controller.get(thread)), false);
  finishDelete({ deleted: true }); await removing;
  assert.equal(f.controller.get(thread).length, 0);
});

test('an unknown DELETE does not leave a sendable uploaded entry and 404 verifies its explicit removal', async () => {
  const f = fixture({ remove: async () => { throw new Error('lost delete reply'); }, metadata: async () => { throw statusError(404); } });
  const [id] = f.controller.add(thread, [file()]); await until(() => f.controller.get(thread)[0].status === 'uploaded');
  await f.controller.remove(thread, id); assert.equal(f.controller.get(thread)[0].status, 'unknown'); assert.equal(readyAttachments(f.controller.get(thread)), false);
  await f.controller.check(thread, id); assert.equal(f.controller.get(thread).length, 0);
});

test('a late recovery read cannot put submitted attachments back into the new draft', async () => {
  let resolveList;
  const f = fixture({ list: () => new Promise(resolve => { resolveList = resolve; }) });
  const recovery = f.controller.recover(thread);
  const [id] = f.controller.add(thread, [file()]); await until(() => f.controller.get(thread)[0].status === 'uploaded');
  f.controller.claim(thread, [id]); f.drafts.set(thread, { text: 'The next draft' });
  resolveList({ attachments: [publicFile(id)] }); await recovery;
  assert.equal(f.drafts.get(thread).text, 'The next draft'); assert.equal(f.controller.get(thread).length, 0);
});

test('an aborted draft listing never removes an unknown upload or its independent text', async () => {
  const f = fixture({ list: async () => { throw new DOMException('Fetch is aborted', 'AbortError'); } });
  const selected = file(), id = uuid(61);
  f.drafts.set(thread, { text: 'Keep the current draft', attachments: [{ id, file: selected, name: selected.name,
    size: selected.size, mime: selected.type, kind: 'file', status: 'unknown', error: '上传结果待确认，请核对状态。' }] });
  await assert.rejects(f.controller.recover(thread), error => error.name === 'AbortError');
  assert.equal(f.controller.get(thread)[0].file, selected);
  assert.equal(f.controller.get(thread)[0].status, 'unknown');
  assert.equal(f.drafts.get(thread).text, 'Keep the current draft');
  assert.equal(readyAttachments(f.controller.get(thread)), false);
  assert.deepEqual(f.calls, []);
});

test('cancelling a queued attachment restores it after a pre-cancel list read and preserves the newer draft', async () => {
  const attachment = publicFile(uuid(30)); let finishOldRead, reads = 0;
  const f = fixture({ list: () => ++reads === 1 ? new Promise(resolve => { finishOldRead = resolve; }) : Promise.resolve({ attachments: [attachment] }) });
  f.controller.claim(thread, [attachment.id]); f.drafts.set(thread, { text: 'Keep the independent next query' });
  const earlierRead = f.controller.recover(thread);
  const restored = f.controller.releaseQueued(thread, [attachment.id]);
  finishOldRead({ attachments: [] }); await earlierRead; assert.equal(await restored, 1);
  assert.equal(reads, 2);
  assert.equal(f.drafts.get(thread).text, 'Keep the independent next query');
  assert.deepEqual(attachmentRefs(f.controller.get(thread)).map(item => item.id), [attachment.id]);
  assert.equal(readyAttachments(f.controller.get(thread)), true);
});

test('cancelled queue attachments respect draft capacity and remain available through the explicit recovery retry', async () => {
  const existing = Array.from({ length: 6 }, (_, n) => publicFile(uuid(40 + n)));
  const cancelled = publicFile(uuid(50));
  const f = fixture({ list: async () => ({ attachments: [cancelled] }) });
  f.drafts.set(thread, { text: 'Current text', attachments: existing.map(attachment => ({ ...attachment, status: 'uploaded', attachment })) });
  f.controller.claim(thread, [cancelled.id]);
  await assert.rejects(f.controller.releaseQueued(thread, [cancelled.id]), error => error.code === 'attachment_recovery_limit');
  assert.deepEqual(f.controller.get(thread).map(item => item.id), existing.map(item => item.id));
  await f.controller.remove(thread, existing[0].id); await f.controller.recover(thread);
  assert.equal(f.controller.get(thread).length, 6); assert.ok(f.controller.get(thread).some(item => item.id === cancelled.id));
  assert.equal(f.drafts.get(thread).text, 'Current text');
});

test('queue release does not undo a newer submission claim while waiting for an older list request', async () => {
  const attachment = publicFile(uuid(51)); let finishOldRead, reads = 0;
  const f = fixture({ list: () => ++reads === 1 ? new Promise(resolve => { finishOldRead = resolve; }) : Promise.resolve({ attachments: [attachment] }) });
  f.controller.claim(thread, [attachment.id]);
  const earlierRead = f.controller.recover(thread), restored = f.controller.releaseQueued(thread, [attachment.id]);
  f.controller.claim(thread, [attachment.id]);
  finishOldRead({ attachments: [] }); await earlierRead;
  assert.equal(await restored, 0); assert.equal(f.controller.get(thread).length, 0);
});

test('late server drafts fill only remaining slots and report overflow without discarding chosen Files', async () => {
  let resolveList;
  const f = fixture({ list: () => new Promise(resolve => { resolveList = resolve; }) }, () => new Promise(() => {}));
  const recovery = f.controller.recover(thread), rejection = assert.rejects(recovery, error => error.code === 'attachment_recovery_limit');
  const ids = f.controller.add(thread, Array.from({ length: 6 }, (_, n) => file(`chosen-${n}.txt`)));
  resolveList({ attachments: [publicFile(uuid(10)), publicFile(uuid(11))] }); await rejection;
  assert.deepEqual(f.controller.get(thread).map(item => item.id), ids); assert.equal(f.controller.get(thread).length, 6);
});

test('HEIC verification compares original source bytes while keeping converted image metadata', async () => {
  const f = fixture({ upload: async (_thread, item) => publicFile(item.id, { name: item.name, mime: 'image/jpeg', kind: 'image', sha256: 'c'.repeat(64), size: 7 }) });
  const [id] = f.controller.add(thread, [file('camera.heic')]); await until(() => f.controller.get(thread)[0].status === 'uploaded');
  assert.equal(f.controller.get(thread)[0].attachment.id, id); assert.equal(f.controller.get(thread)[0].attachment.mime, 'image/jpeg');
});

test('preview metadata accepts only the matching authenticated attachment preview path', () => {
  const value = publicFile(uuid(22));
  assert.equal(validateAttachment({ ...value, previewUrl: `${value.url}?preview=1` }, thread).previewUrl, `${value.url}?preview=1`);
  for (const previewUrl of [`${value.url}?preview=2`, attachmentPath(thread, uuid(23)) + '?preview=1', 'https://external.example/image']) {
    assert.throws(() => validateAttachment({ ...value, previewUrl }, thread), /回执不匹配/);
  }
});

test('re-edit restores unbound attachments and text, removes the claim, and refuses unknown or bound submissions', async () => {
  const attachment = publicFile(uuid(20)); let listed = [attachment];
  const f = fixture({ list: async () => ({ attachments: listed }) });
  f.controller.claim(thread, [attachment.id]);
  const restored = await f.controller.restoreDraft(thread, { status: 'rejected', text: 'Original query', attachments: [attachment] });
  assert.equal(restored.text, 'Original query'); assert.equal(restored.attachments[0].attachment.id, attachment.id);
  f.drafts.delete(thread); await f.controller.recover(thread); assert.equal(f.controller.get(thread).length, 1, 'restored IDs are no longer suppressed as already submitted');
  f.drafts.delete(thread);
  await assert.rejects(f.controller.restoreDraft(thread, { status: 'unknown', text: '', attachments: [attachment] }), /先核对/);
  listed = []; await assert.rejects(f.controller.restoreDraft(thread, { status: 'rejected', text: '', attachments: [attachment] }), /待发消息|不再可用/);
});

test('a late re-edit read cannot overwrite a new draft or resurrect content after leaving the view', async () => {
  const attachment = publicFile(uuid(21)); let finish;
  const f = fixture({ list: () => new Promise(resolve => { finish = resolve; }) });
  const restoring = f.controller.restoreDraft(thread, { status: 'not_found', text: 'Old text', attachments: [attachment] });
  const rejected = assert.rejects(restoring, /草稿或页面已变化/);
  f.drafts.set(thread, { text: 'New text' }); finish({ attachments: [attachment] }); await rejected;
  assert.equal(f.drafts.get(thread).text, 'New text'); assert.equal(f.controller.get(thread).length, 0);
  f.drafts.delete(thread);
  const leaving = f.controller.restoreDraft(thread, { status: 'rejected', text: '', attachments: [attachment] }, () => false);
  const left = assert.rejects(leaving, /页面已变化/); finish({ attachments: [attachment] }); await left; assert.equal(f.drafts.has(thread), false);
});

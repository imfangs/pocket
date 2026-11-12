import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createAttachmentDraftController, attachmentPath, attachmentRefs, canRemoveLocalAttachment, readyAttachments, validateAttachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '../src/attachments.ts';
import { createDraftMap, draftThreadIds } from '../src/draftIndicators.ts';
import { hasUpdateBlockingDraft } from '../src/updateDrafts.ts';
import { createAttachmentUploadScheduler } from '../src/attachmentUploadScheduler.ts';

const thread = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', hash = 'b'.repeat(64);
const file = (name = 'small.txt') => new File(['hello'], name, { type: 'text/plain' });
const publicFile = (id, overrides = {}) => ({ id, name: 'small.txt', size: 5, mime: 'text/plain', kind: 'file', url: attachmentPath(thread, id), sha256: hash, sourceSha256: hash, sourceSize: 5, ...overrides });
const uuid = n => `cccccccc-cccc-7ccc-8ccc-${String(n).padStart(12, '0')}`;
const statusError = status => Object.assign(new Error(`HTTP ${status}`), { status });
async function until(check) { for (let n = 0; n < 30; n++) { if (check()) return; await setImmediate(); } assert.ok(check(), 'async draft operation should settle'); }
function fixture(overrides = {}, digest = async () => hash, scheduler = createAttachmentUploadScheduler()) {
  const calls = [], drafts = createDraftMap(() => {});
  const request = {
    upload: async (_thread, item) => { calls.push(['PUT', item.id, item.file]); return publicFile(item.id, { name: item.name }); },
    metadata: async (_thread, id) => { calls.push(['metadata', id]); return publicFile(id); },
    list: async () => ({ attachments: [] }),
    remove: async (_thread, id) => { calls.push(['DELETE', id]); return { deleted: true }; },
    ...overrides,
  };
  return { controller: createAttachmentDraftController(drafts, request, digest, scheduler, createAttachmentUploadScheduler(2)), drafts, calls, request };
}

test('sixteen global upload slots are shared across controllers and threads, with fair refill and no duplicate upload', async () => {
  const scheduler = createAttachmentUploadScheduler(), other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const started = [], waiting = new Map(); let concurrent = 0, peak = 0;
  const upload = (threadId, item) => {
    started.push([threadId, item.id]); concurrent++; peak = Math.max(peak, concurrent);
    return new Promise(resolve => { waiting.set(item.id, () => { concurrent--; resolve(publicFile(item.id, { name: item.name, url: attachmentPath(threadId, item.id) })); }); });
  };
  const first = fixture({ upload }, undefined, scheduler), second = fixture({ upload }, undefined, scheduler);
  const firstIds = first.controller.add(thread, Array.from({ length: MAX_ATTACHMENTS }, (_, n) => file(`first-${n}.txt`)));
  const secondIds = second.controller.add(other, Array.from({ length: MAX_ATTACHMENTS }, (_, n) => file(`second-${n}.txt`)));
  await until(() => started.length === 16);
  assert.equal([...first.controller.get(thread), ...second.controller.get(other)].filter(item => item.status === 'uploading').length, 16);
  assert.equal([...first.controller.get(thread), ...second.controller.get(other)].filter(item => item.status === 'queued').length, 16);
  assert.ok(started.some(item => item[0] === thread)); assert.ok(started.some(item => item[0] === other));
  for (const id of firstIds.slice(0, 2)) { waiting.get(id)(); waiting.delete(id); }
  await until(() => started.length === 18);
  assert.deepEqual(new Set(started.slice(16, 18).map(item => item[0])), new Set([thread, other]));
  for (;;) {
    for (const [id, finish] of [...waiting]) { waiting.delete(id); finish(); }
    await setImmediate();
    if (readyAttachments(first.controller.get(thread)) && readyAttachments(second.controller.get(other))) break;
  }
  assert.equal(peak, 16);
  assert.deepEqual(new Set(started.map(item => item[1])), new Set([...firstIds, ...secondIds]));
  assert.equal(started.length, 32);
});

test('the production default shares one sixteen-slot scheduler across separately created controllers', async () => {
  const finish = []; let active = 0, peak = 0, puts = 0;
  const request = { upload: async (_thread, item) => {
    active++; puts++; peak = Math.max(peak, active);
    await new Promise(resolve => finish.push(() => { active--; resolve(); }));
    return publicFile(item.id);
  }, metadata: async () => { throw statusError(404); }, list: async () => ({ attachments: [] }), remove: async () => {} };
  const first = createAttachmentDraftController(new Map(), request, async () => hash);
  const second = createAttachmentDraftController(new Map(), request, async () => hash);
  first.add(thread, Array.from({ length: 10 }, () => file())); second.add(thread, Array.from({ length: 10 }, () => file()));
  await until(() => puts === 16); assert.equal(active, 16);
  for (let n = 0; n < 30 && (!readyAttachments(first.get(thread)) || !readyAttachments(second.get(thread))); n++) {
    finish.splice(0).forEach(release => release()); await setImmediate();
  }
  assert.equal(readyAttachments(first.get(thread)), true); assert.equal(readyAttachments(second.get(thread)), true);
  assert.equal(puts, 20); assert.equal(peak, 16);
});

test('production SHA preparation shares two slots without consuming the independent sixteen upload slots', async () => {
  const hashing = [], uploading = []; let liveHashes = 0, peakHashes = 0, liveUploads = 0, peakUploads = 0, puts = 0;
  const digest = () => { liveHashes++; peakHashes = Math.max(peakHashes, liveHashes); return new Promise(resolve => hashing.push(() => { liveHashes--; resolve(hash); })); };
  const request = { upload: async (_thread, item) => {
    liveUploads++; puts++; peakUploads = Math.max(peakUploads, liveUploads);
    await new Promise(resolve => uploading.push(() => { liveUploads--; resolve(); })); return publicFile(item.id);
  }, metadata: async () => { throw statusError(404); }, list: async () => ({ attachments: [] }), remove: async () => {} };
  const first = createAttachmentDraftController(new Map(), request, digest), secondDrafts = new Map();
  const second = createAttachmentDraftController(secondDrafts, request, digest);
  first.add(thread, Array.from({ length: 16 }, () => file()));
  secondDrafts.set(thread, { text: '', attachments: Array.from({ length: 16 }, (_, n) => ({ id: uuid(200 + n), name: 'cached.txt', size: 5,
    file: file(), mime: 'text/plain', kind: 'file', status: 'failed', sourceSha256: hash })) });
  for (const item of second.get(thread)) second.retry(thread, item.id);
  await until(() => liveHashes === 2 && puts === 16);
  assert.equal(peakHashes, 2); assert.equal(peakUploads, 16);
  assert.equal(first.get(thread).filter(item => item.status === 'queued').length, 16, 'hash preparation stays queued until a network slot starts its PUT');
  for (let n = 0; n < 40 && (!readyAttachments(first.get(thread)) || !readyAttachments(second.get(thread))); n++) {
    hashing.splice(0).forEach(finish => finish()); uploading.splice(0).forEach(finish => finish()); await setImmediate();
  }
  assert.equal(readyAttachments(first.get(thread)), true); assert.equal(readyAttachments(second.get(thread)), true);
  assert.equal(puts, 32); assert.equal(peakHashes, 2); assert.equal(peakUploads, 16);
});

test('explicit rejected-reservation restore keeps original Files, IDs and unknown status, including an old active PUT receipt', async () => {
  const requestId = uuid(110), selected = [file('active.txt'), file('queued.txt')], calls = [];
  let finishUpload, finishHash;
  const f = fixture({ upload: async (_thread, item, owner) => {
    calls.push([item.id, item.file, owner]);
    if (item.name === 'active.txt') return new Promise(resolve => { finishUpload = () => resolve(publicFile(item.id)); });
    return publicFile(item.id);
  } }, selected => selected.name === 'queued.txt' ? new Promise(resolve => { finishHash = () => resolve(hash); }) : Promise.resolve(hash));
  const ids = f.controller.add(thread, selected); await until(() => finishUpload && finishHash);
  const unknownId = uuid(111), unknownFile = file('unknown.txt');
  f.drafts.set(thread, { text: '', attachments: [...f.controller.get(thread), { id: unknownId, file: unknownFile, name: unknownFile.name,
    size: 5, mime: 'text/plain', kind: 'file', status: 'unknown', sourceSha256: hash, error: 'Upload result unknown' }] });
  f.controller.takeSubmission(thread, requestId, f.controller.get(thread)); assert.equal(f.controller.hasSubmission(thread, requestId), true);
  let oldBundleUpdates = 0; f.controller.subscribeSubmission(thread, requestId, () => oldBundleUpdates++);
  const restored = f.controller.restoreSubmission(thread, requestId, 'original rejected text');
  assert.equal(restored.text, 'original rejected text'); assert.equal(f.controller.hasSubmission(thread, requestId), false);
  assert.deepEqual(restored.attachments.map(item => item.id), [...ids, unknownId]);
  assert.equal(restored.attachments[0].file, selected[0]); assert.equal(restored.attachments[1].file, selected[1]);
  assert.equal(restored.attachments[2].file, unknownFile); assert.equal(restored.attachments[2].status, 'unknown');
  finishHash(); finishUpload();
  await until(() => f.controller.get(thread).slice(0, 2).every(item => item.status === 'uploaded'));
  assert.equal(f.drafts.get(thread).text, 'original rejected text'); assert.equal(oldBundleUpdates, 0);
  assert.equal(f.controller.get(thread)[2].status, 'unknown'); assert.equal(calls.some(call => call[0] === unknownId), false);
  assert.deepEqual(calls, [[ids[0], selected[0], undefined], [ids[1], selected[1], undefined]]);
});

test('rejected-reservation restore refuses a new draft, active reservation, or cancelled bundle and retains its Files', async () => {
  const f = fixture(), requestId = uuid(112), selected = file();
  f.controller.add(thread, [selected]); f.controller.takeSubmission(thread, requestId, f.controller.get(thread));
  f.drafts.set(thread, { text: 'new independent text' });
  assert.throws(() => f.controller.restoreSubmission(thread, requestId, 'old text'), /已有新草稿/);
  assert.equal(f.drafts.get(thread).text, 'new independent text'); assert.equal(f.controller.getSubmission(thread, requestId)[0].file, selected);
  assert.equal(f.controller.hasSubmission(thread, requestId), true); f.drafts.set(thread, { text: '', attachments: [{ id: uuid(113), status: 'unknown' }] });
  assert.throws(() => f.controller.restoreSubmission(thread, requestId, 'old text'), /已有新草稿/);
  f.drafts.delete(thread); f.controller.resumeSubmission(thread, requestId);
  assert.throws(() => f.controller.restoreSubmission(thread, requestId, 'old text'), /暂停附件/);
  await until(() => readyAttachments(f.controller.getSubmission(thread, requestId)));
  await f.controller.cancelSubmission(thread, requestId);
  assert.throws(() => f.controller.restoreSubmission(thread, requestId, 'old text'), /暂停附件/);
});

test('a synchronous uploading callback can transfer and hold the bundle before PUT, then resume its queued original ID', async () => {
  const requestId = uuid(114), calls = []; let taken = false;
  const f = fixture({ upload: async (_thread, item, owner) => { calls.push([item.id, owner]); return publicFile(item.id); } });
  f.controller.subscribe(thread, () => {
    if (!taken && f.controller.get(thread)[0]?.status === 'uploading') {
      taken = true; f.controller.takeSubmission(thread, requestId, f.controller.get(thread));
    }
  });
  const [id] = f.controller.add(thread, [file()]);
  await until(() => taken && f.controller.getSubmission(thread, requestId)[0].status === 'queued');
  assert.deepEqual(calls, []); f.drafts.set(thread, { text: 'next draft' });
  f.controller.resumeSubmission(thread, requestId);
  await until(() => readyAttachments(f.controller.getSubmission(thread, requestId)));
  assert.deepEqual(calls, [[id, requestId]]); assert.equal(f.drafts.get(thread).text, 'next draft');
});

test('removing a queued file frees it immediately without waiting for unrelated active uploads or issuing a PUT', async () => {
  const scheduler = createAttachmentUploadScheduler(), other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const started = [], finishes = [], unrelated = [];
  const occupied = fixture({ upload: (_thread, item) => new Promise(resolve => unrelated.push(() => resolve(publicFile(item.id, { url: attachmentPath(other, item.id) })))) }, undefined, scheduler);
  occupied.controller.add(other, Array.from({ length: 8 }, () => file()));
  await until(() => unrelated.length === 8);
  const f = fixture({ upload: (_thread, item) => { started.push(item.id); return new Promise(resolve => finishes.push(() => resolve(publicFile(item.id)))); } }, undefined, scheduler);
  const ids = f.controller.add(thread, Array.from({ length: MAX_ATTACHMENTS }, () => file()));
  await until(() => started.length === 8);
  assert.equal(started.length + unrelated.length, 16, 'unrelated Files occupy half of the real sixteen-slot scheduler');
  await f.controller.remove(thread, ids[8]);
  assert.equal(f.controller.get(thread).length, 15);
  assert.equal(started.includes(ids[8]), false);
  assert.deepEqual(f.calls, []);
  while (!readyAttachments(f.controller.get(thread))) { finishes.splice(0).forEach(finish => finish()); await setImmediate(); }
  assert.equal(started.length, 15);
  assert.equal(started.includes(ids[8]), false);
  unrelated.forEach(finish => finish()); await until(() => readyAttachments(occupied.controller.get(other)));
});

test('a request bundle keeps active PUT and hash ownership after the composer closes and a new draft begins', async () => {
  const requestId = uuid(100), selected = [file('put.txt'), file('hash.txt')];
  let finishHash, finishUpload, previousUpdates = 0, nextUpdates = 0;
  const calls = [];
  const f = fixture({ upload: async (_thread, item, owner) => {
    calls.push([item.name, item.id, owner, item.file]);
    if (item.name === 'put.txt') return new Promise(resolve => { finishUpload = () => resolve(publicFile(item.id)); });
    return publicFile(item.id, { name: item.name });
  } }, selected => selected.name === 'hash.txt' ? new Promise(resolve => { finishHash = () => resolve(hash); }) : Promise.resolve(hash));
  const leave = f.controller.subscribe(thread, () => previousUpdates++);
  f.drafts.set(thread, { text: 'original text' });
  const ids = f.controller.add(thread, selected); await until(() => finishUpload && finishHash);
  const expected = f.controller.get(thread), snapshot = f.controller.takeSubmission(thread, requestId, expected);
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(snapshot[0].file, selected[0]); assert.equal(snapshot[1].file, selected[1]);
  assert.equal(f.drafts.get(thread).text, 'original text'); assert.deepEqual(f.controller.get(thread), []);
  leave(); const previous = previousUpdates;
  let bundleUpdates = 0;
  const unsubscribe = f.controller.subscribeSubmission(thread, requestId, () => bundleUpdates++);
  f.drafts.set(thread, { text: 'independent new text' });
  const [newId] = f.controller.add(thread, [file('next.txt')]);
  finishHash(); finishUpload();
  await until(() => f.controller.getSubmission(thread, requestId)[0].status === 'uploaded' && f.controller.getSubmission(thread, requestId)[1].status === 'queued');
  await until(() => readyAttachments(f.controller.get(thread)));
  assert.equal(calls.some(call => call[0] === 'hash.txt'), false, 'held bundle waits for its durable reservation');
  assert.equal(previousUpdates, previous); assert.ok(bundleUpdates > 0);
  const nextLeave = f.controller.subscribe(thread, () => nextUpdates++);
  f.controller.resumeSubmission(thread, requestId);
  await until(() => readyAttachments(f.controller.getSubmission(thread, requestId)));
  assert.equal(f.drafts.get(thread).text, 'independent new text'); assert.deepEqual(f.controller.get(thread).map(item => item.id), [newId]);
  assert.equal(nextUpdates, 0, 'old upload callbacks never notify or edit the new draft');
  assert.deepEqual(calls.filter(call => ids.includes(call[1])).map(call => [call[0], call[2]]), [['put.txt', undefined], ['hash.txt', requestId]]);
  f.controller.completeSubmission(thread, requestId); assert.deepEqual(f.controller.getSubmission(thread, requestId), []);
  f.request.list = async () => ({ attachments: ids.map(id => publicFile(id)) });
  await f.controller.recover(thread); assert.deepEqual(f.controller.get(thread).map(item => item.id), [newId]);
  unsubscribe(); nextLeave();
});

test('takeSubmission moves only captured IDs and preserves attachments and text added since that snapshot', async () => {
  const f = fixture(), [id] = f.controller.add(thread, [file()]);
  await until(() => readyAttachments(f.controller.get(thread)));
  const expected = f.controller.get(thread);
  const [newId] = f.controller.add(thread, [file('next.txt')]);
  f.drafts.set(thread, { ...f.drafts.get(thread), text: 'newer independent text' });
  const snapshot = f.controller.takeSubmission(thread, uuid(101), expected);
  assert.deepEqual(snapshot.map(item => item.id), [id]); assert.deepEqual(f.controller.get(thread).map(item => item.id), [newId]);
  assert.equal(f.drafts.get(thread).text, 'newer independent text');
  await until(() => readyAttachments(f.controller.get(thread)));
  assert.throws(() => f.controller.takeSubmission(thread, uuid(102), expected), /已变化/);
  assert.deepEqual(f.controller.get(thread).map(item => item.id), [newId]);
});

test('unknown request uploads retain the original File and ID, with read-only checks and no upload retry', async () => {
  const requestId = uuid(103); let puts = 0, reads = 0, found = false;
  const f = fixture({ upload: async () => { puts++; throw new Error('lost PUT response'); },
    metadata: async (_thread, id) => { reads++; if (!found) throw statusError(404); return publicFile(id); } });
  const selected = file(), [id] = f.controller.add(thread, [selected]);
  f.controller.takeSubmission(thread, requestId, f.controller.get(thread)); f.drafts.set(thread, { text: 'next draft' });
  f.controller.resumeSubmission(thread, requestId);
  await until(() => f.controller.getSubmission(thread, requestId)[0].status === 'unknown' && reads === 1); await setImmediate();
  f.controller.retrySubmission(thread, requestId); await f.controller.checkSubmission(thread, requestId);
  assert.equal(puts, 1); assert.equal(reads, 2); assert.equal(f.controller.getSubmission(thread, requestId)[0].file, selected);
  found = true; await f.controller.checkSubmission(thread, requestId);
  assert.equal(f.controller.getSubmission(thread, requestId)[0].attachment.id, id); assert.equal(puts, 1); assert.equal(reads, 3);
  assert.equal(f.drafts.get(thread).text, 'next draft'); assert.equal(f.controller.get(thread).length, 0);
});

test('request bundle retries require an explicit action and keep the original File, upload ID, and request ID', async () => {
  const requestId = uuid(104), calls = []; let accept = false;
  const f = fixture({ upload: async (_thread, item, owner) => { calls.push([item.id, item.file, owner]); if (!accept) throw statusError(413); return publicFile(item.id); } });
  const selected = file(), [id] = f.controller.add(thread, [selected]);
  f.controller.takeSubmission(thread, requestId, f.controller.get(thread)); f.controller.resumeSubmission(thread, requestId);
  await until(() => f.controller.getSubmission(thread, requestId)[0].status === 'failed'); await setImmediate();
  assert.equal(calls.length, 1); accept = true; f.controller.retrySubmission(thread, requestId);
  await until(() => readyAttachments(f.controller.getSubmission(thread, requestId)));
  assert.deepEqual(calls, [[id, selected, requestId], [id, selected, requestId]]);
});

test('request cancellation withdraws queued work, waits for original active PUTs, and cannot restart through late callbacks', async () => {
  const requestId = uuid(105), started = [], finish = new Map(), deleted = [], unrelated = [];
  const scheduler = createAttachmentUploadScheduler(), other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const occupied = fixture({ upload: (_thread, item) => new Promise(resolve => unrelated.push(() => resolve(publicFile(item.id, { url: attachmentPath(other, item.id) })))) }, undefined, scheduler);
  occupied.controller.add(other, Array.from({ length: 8 }, () => file()));
  await until(() => unrelated.length === 8);
  const f = fixture({ upload: (_thread, item) => { started.push(item.id); return new Promise(resolve => finish.set(item.id, () => resolve(publicFile(item.id)))); },
    remove: async (_thread, id) => { deleted.push(id); } }, undefined, scheduler);
  const ids = f.controller.add(thread, Array.from({ length: 12 }, () => file()));
  await until(() => started.length === 8); f.controller.takeSubmission(thread, requestId, f.controller.get(thread));
  assert.equal(started.length + unrelated.length, 16, 'cancellation runs while the real shared scheduler is full');
  let updates = 0; f.controller.subscribeSubmission(thread, requestId, () => updates++);
  f.drafts.set(thread, { text: 'new independent input' });
  const cancellation = f.controller.cancelSubmission(thread, requestId);
  assert.equal(deleted.length, 0); assert.equal(started.length, 8);
  f.controller.resumeSubmission(thread, requestId); f.controller.retrySubmission(thread, requestId);
  for (const release of finish.values()) release();
  assert.equal(await cancellation, true); assert.equal(started.length, 8); assert.deepEqual(new Set(deleted), new Set(ids.slice(0, 8)));
  assert.ok(updates > 0); assert.deepEqual(f.controller.getSubmission(thread, requestId), []);
  assert.equal(f.drafts.get(thread).text, 'new independent input'); assert.equal(f.controller.get(thread).length, 0);
  f.controller.completeSubmission(thread, requestId);
  f.controller.resumeSubmission(thread, requestId); await setImmediate(); assert.equal(started.length, 8);
  unrelated.forEach(release => release()); await until(() => readyAttachments(occupied.controller.get(other)));
});

test('an uncertain request cancellation stays unsendable and read-only checks can finish DELETE without replaying PUT', async () => {
  const requestId = uuid(106); let failDelete = true, puts = 0, reads = 0, deletes = 0, gone = false;
  const f = fixture({ upload: async (_thread, item) => { puts++; return publicFile(item.id); },
    remove: async () => { deletes++; if (failDelete) throw new Error('lost DELETE response'); },
    metadata: async (_thread, id) => { reads++; if (gone) throw statusError(404); return publicFile(id); } });
  f.controller.add(thread, [file()]); await until(() => readyAttachments(f.controller.get(thread)));
  f.controller.takeSubmission(thread, requestId, f.controller.get(thread));
  assert.equal(await f.controller.cancelSubmission(thread, requestId), false);
  assert.equal(f.controller.getSubmission(thread, requestId)[0].status, 'unknown');
  await f.controller.checkSubmission(thread, requestId);
  assert.equal(f.controller.getSubmission(thread, requestId)[0].status, 'unknown');
  assert.equal(f.controller.getSubmission(thread, requestId)[0].deletePending, true);
  assert.equal(readyAttachments(f.controller.getSubmission(thread, requestId)), false);
  assert.throws(() => f.controller.completeSubmission(thread, requestId), /尚未确认/);
  f.controller.resumeSubmission(thread, requestId); f.controller.retrySubmission(thread, requestId); assert.equal(puts, 1);
  gone = true; await f.controller.checkSubmission(thread, requestId);
  assert.deepEqual(f.controller.getSubmission(thread, requestId), []); assert.equal(reads, 2); assert.equal(deletes, 1); assert.equal(puts, 1);
  f.controller.completeSubmission(thread, requestId);
});

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
  assert.throws(() => f.controller.add(thread, Array.from({ length: MAX_ATTACHMENTS + 1 }, () => file())), /16个/);
  assert.throws(() => f.controller.add(thread, [{ name: 'huge.bin', size: MAX_ATTACHMENT_BYTES + 1, type: '' }]), /20 MB/);
  assert.equal(f.controller.get(thread).length, 0); assert.equal(f.drafts.get(thread).text, 'Keep this text');
});

test('removing an in-flight file waits for that upload then deletes once without losing newer composer text', async () => {
  let uploaded, deletes = 0;
  const f = fixture({ upload: (_thread, item) => new Promise(resolve => { uploaded = () => resolve(publicFile(item.id)); }), remove: async () => { deletes++; } });
  const [id] = f.controller.add(thread, [file()]); await until(() => uploaded);
  const removing = f.controller.remove(thread, id); assert.equal(f.controller.get(thread)[0].status, 'removing'); assert.equal(deletes, 0);
  const captured = f.controller.get(thread);
  assert.throws(() => f.controller.takeSubmission(thread, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', captured), /附件正在移除/);
  assert.equal(f.controller.get(thread), captured, 'Rejected ownership transfer preserves the pending removal and its original File');
  assert.equal(f.controller.hasSubmission(thread, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), false);
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
  const existing = Array.from({ length: MAX_ATTACHMENTS }, (_, n) => publicFile(uuid(40 + n)));
  const cancelled = publicFile(uuid(70));
  const f = fixture({ list: async () => ({ attachments: [cancelled] }) });
  f.drafts.set(thread, { text: 'Current text', attachments: existing.map(attachment => ({ ...attachment, status: 'uploaded', attachment })) });
  f.controller.claim(thread, [cancelled.id]);
  await assert.rejects(f.controller.releaseQueued(thread, [cancelled.id]), error => error.code === 'attachment_recovery_limit');
  assert.deepEqual(f.controller.get(thread).map(item => item.id), existing.map(item => item.id));
  await f.controller.remove(thread, existing[0].id); await f.controller.recover(thread);
  assert.equal(f.controller.get(thread).length, MAX_ATTACHMENTS); assert.ok(f.controller.get(thread).some(item => item.id === cancelled.id));
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
  const ids = f.controller.add(thread, Array.from({ length: MAX_ATTACHMENTS }, (_, n) => file(`chosen-${n}.txt`)));
  resolveList({ attachments: [publicFile(uuid(10)), publicFile(uuid(11))] }); await rejection;
  assert.deepEqual(f.controller.get(thread).map(item => item.id), ids); assert.equal(f.controller.get(thread).length, MAX_ATTACHMENTS);
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

test('disposing one controller aborts its active PUT, releases shared capacity to another owner and never sends DELETE', async t => {
  const scheduler = createAttachmentUploadScheduler(1), started = [], signals = new Map(); let finishOther, metadata = 0, deletes = 0;
  const request = {
    upload: (_thread, item, _owner, signal) => new Promise((resolve, reject) => {
      started.push(item.id); signals.set(item.id, signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (item.name === 'other.txt') finishOther = () => resolve(publicFile(item.id, { name: item.name }));
    }),
    metadata: async () => { metadata++; throw statusError(404); }, list: async () => ({ attachments: [] }), remove: async () => { deletes++; },
  };
  const firstDrafts = new Map([[thread, { text: 'Preserved independent text' }]]), otherDrafts = new Map();
  const first = createAttachmentDraftController(firstDrafts, request, async () => hash, scheduler);
  const other = createAttachmentDraftController(otherDrafts, request, async () => hash, scheduler);
  t.after(() => { first.dispose(); other.dispose(); });
  const [firstId] = first.add(thread, [file('first.txt')]), [otherId] = other.add(thread, [file('other.txt')]);
  await until(() => started.length === 1);
  first.dispose(); await until(() => finishOther);
  assert.equal(signals.get(firstId).aborted, true); assert.equal(signals.get(otherId).aborted, false);
  assert.deepEqual(first.get(thread), []); assert.equal(firstDrafts.get(thread).text, 'Preserved independent text');
  assert.equal(firstDrafts.get(thread).attachments, undefined); assert.equal(deletes, 0); assert.equal(metadata, 0);
  finishOther(); await until(() => readyAttachments(other.get(thread)));
  assert.deepEqual(started, [firstId, otherId]); assert.equal(other.get(thread)[0].attachment.id, otherId);
});

test('disposing a held source hash drops its File and ignores its late result without consuming a network slot', async t => {
  let finishHash, puts = 0, deletes = 0, updates = 0;
  const drafts = new Map([[thread, { text: '', answerMode: 'custom', customText: 'An independent answer draft' }]]);
  const controller = createAttachmentDraftController(drafts, { upload: async (_thread, item) => { puts++; return publicFile(item.id); },
    metadata: async () => { throw statusError(404); }, list: async () => ({ attachments: [] }), remove: async () => { deletes++; } },
    () => new Promise(resolve => { finishHash = () => resolve(hash); }), createAttachmentUploadScheduler());
  t.after(() => { controller.dispose(); finishHash?.(); });
  controller.subscribe(thread, () => updates++);
  controller.add(thread, [file()]); await until(() => finishHash);
  controller.dispose(); const before = updates;
  finishHash(); await setImmediate(); await setImmediate();
  assert.equal(puts, 0); assert.equal(deletes, 0); assert.equal(updates, before); assert.deepEqual(controller.get(thread), []);
  assert.deepEqual(drafts.get(thread), { text: '', answerMode: 'custom', customText: 'An independent answer draft' });
  assert.throws(() => controller.add(thread, [file()]), /会话已关闭/);
});

test('a disposed owner cannot restore a late server draft or expose late metadata', async t => {
  let finishList, finishMetadata;
  const f = fixture({ list: (_thread, signal) => new Promise(resolve => { finishList = result => { assert.equal(signal.aborted, true); resolve(result); }; }),
    metadata: (_thread, fileId, signal) => new Promise(resolve => { finishMetadata = () => { assert.equal(signal.aborted, true); resolve(publicFile(fileId)); }; }) });
  t.after(() => f.controller.dispose());
  const recovered = f.controller.recover(thread), attachment = publicFile(uuid(301));
  f.drafts.set(thread, { text: 'Plain text retained', attachments: [{ ...attachment, status: 'unknown' }] });
  const checked = f.controller.check(thread, attachment.id); await until(() => finishMetadata);
  f.controller.dispose(); finishList({ attachments: [attachment] }); finishMetadata();
  await Promise.all([recovered, checked]);
  assert.deepEqual(f.controller.get(thread), []); assert.deepEqual(f.drafts.get(thread), { text: 'Plain text retained' });
  assert.deepEqual(f.calls, []);
});

test('disposing during a user-requested in-flight removal does not issue a new DELETE after the PUT aborts', async t => {
  let signal, deletes = 0;
  const f = fixture({ upload: (_thread, _item, _owner, current) => new Promise((_resolve, reject) => {
    signal = current; current.addEventListener('abort', () => reject(current.reason), { once: true });
  }), remove: async () => { deletes++; } });
  t.after(() => f.controller.dispose());
  const [id] = f.controller.add(thread, [file()]); await until(() => signal);
  const removal = f.controller.remove(thread, id);
  f.controller.dispose(); await removal; await setImmediate();
  assert.equal(signal.aborted, true); assert.equal(deletes, 0); assert.deepEqual(f.controller.get(thread), []);
});

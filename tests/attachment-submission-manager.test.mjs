import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createAttachmentDraftController, attachmentPath } from '../src/attachments.ts';
import { createAttachmentUploadScheduler } from '../src/attachmentUploadScheduler.ts';
import { createAttachmentSubmissionManager } from '../src/attachmentSubmissionManager.ts';
import { createSubmittedQueryStore } from '../src/submittedQueries.ts';

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

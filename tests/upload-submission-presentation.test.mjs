import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { completeSubmittedEcho, createSubmittedQueryStore, submittedOutbox, visibleSubmittedQueries, withSubmittedAttachments } from '../src/submittedQueries.ts';
import { queryTimeline } from '../src/queryTimeline.ts';
import { createSubmissionFeedbackTracker, queueFeedbackState, queueHeadState } from '../src/submissionFeedback.ts';

const files = Array.from({ length: 16 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  name: `A very long shared filename prefix with unique ending ${i + 1}.jpg`, size: 100, mime: 'image/jpeg', status: 'queued',
}));
const refs = files.map(file => ({ id: file.id, name: file.name, size: file.size, mime: file.mime, kind: 'image',
  url: `/api/tasks/thread/attachments/${file.id}`, sha256: 'a'.repeat(64) }));
const progress = uploaded => ({ total: 16, uploaded, status: uploaded === 16 ? 'ready' : 'uploading' });
const seed = { threadId: 'thread', requestId: 'request', text: 'Submitted caption', createdAt: 10, status: 'uploading', attachmentUploads: files, uploadProgress: progress(0) };
const queued = { id: 'request', text: seed.text, createdAt: 999, revision: 0, status: 'queued', uploadProgress: progress(0), attachmentUploads: files };
const echo = { id: 'native', role: 'user', clientMessageId: 'request', text: seed.text, attachments: refs };
function timeline(store, messages = [], queue = []) {
  const entries = store.getThread('thread'), outbox = submittedOutbox(entries, messages, queue);
  return queryTimeline(messages, entries, visibleSubmittedQueries(entries, messages, outbox), outbox);
}
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' },
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const { default: Cards } = await vite.ssrLoadModule('/src/SubmittedQueryCards.tsx');
const { default: Outbox } = await vite.ssrLoadModule('/src/Outbox.tsx');
after(() => vite.close());
const uploadActions = { retry() {}, cancel() {}, check() {} };
const renderCard = item => renderToStaticMarkup(createElement(Cards, { items: [item], connecting: false, paused: false, disabled: false, check: async () => {}, dismiss() {}, uploadActions }));
const renderQueue = item => renderToStaticMarkup(createElement(Outbox, { threadId: 'thread', items: [item], disabled: false, allowSend: true,
  refresh: async () => {}, drafts: new Map(), uploadActions }));

test('sixteen descriptors become one query immediately; partial upload changes no body, identity or creation order', () => {
  const store = createSubmittedQueryStore(); store.seed(seed);
  const first = timeline(store).tail[0];
  assert.equal(first.state, 'uploading'); assert.equal(first.message.attachments.length, 0);
  store.seed({ threadId: 'thread', requestId: 'second', text: 'A different submission', status: 'submitting', createdAt: 20 });
  store.updateUpload('thread', 'request', { progress: progress(4), descriptors: files.map((file, i) => ({ ...file, status: i < 4 ? 'uploaded' : 'uploading' })), attachments: refs.slice(0, 4) });
  store.observeQueue('thread', [queued]);
  const after = timeline(store, [], [queued]).tail;
  assert.deepEqual(after.map(row => row.requestId), ['request', 'second']);
  assert.equal(after[0].message.id, first.message.id); assert.equal(after[0].message.timestamp, first.message.timestamp);
  assert.equal(after[0].message.text, seed.text); assert.equal(after[0].state, 'uploading');
  assert.equal(store.getThread('thread')[0].uploadProgress.uploaded, 4);
  assert.equal(store.getThread('thread')[1].text, 'A different submission');
  assert.equal(renderCard(store.getThread('thread')[0]).split('data-submission-id="request"').length - 1, 1);
});

test('upload descriptors never carry Files, private paths or image preview capabilities into the submitted snapshot', () => {
  const store = createSubmittedQueryStore();
  store.seed({ ...seed, attachmentUploads: files.map(file => ({ ...file, file: { private: true }, path: '/private/source', url: '/private/image' })) });
  store.updateUpload('thread', 'request', { attachments: [{ ...refs[0], file: { private: true }, path: '/private/uploaded' }] });
  const entry = store.getThread('thread')[0];
  assert.equal(entry.attachmentUploads[0].file, undefined); assert.equal(entry.attachmentUploads[0].path, undefined);
  assert.equal(entry.attachments[0].path, undefined); assert.equal(entry.attachments[0].file, undefined);
  assert.throws(() => store.updateUpload('thread', 'request', { attachments: [{ ...refs[1], url: `/api/tasks/other/attachments/${refs[1].id}` }] }), /回执不匹配/);
  const html = renderCard({ ...seed, attachments: [] });
  assert.match(html, /上传中 0\/16/); assert.match(html, /unique ending 16.jpg/);
  assert.doesNotMatch(html, /<img|\/api\/tasks\/thread\/attachments\/|\/private\/|private.*true/);
});

test('all uploads becoming ready keeps queued feedback until an accepted receipt and ignores stale progress afterward', () => {
  const store = createSubmittedQueryStore(); store.seed(seed);
  store.updateUpload('thread', 'request', { progress: progress(16), attachments: refs });
  assert.equal(store.getThread('thread')[0].status, 'queued');
  assert.equal(queueFeedbackState({ ...queued, uploadProgress: progress(16) }).state, 'queued');
  store.receipt('thread', { requestId: 'request', status: 'accepted' });
  const accepted = store.getThread('thread')[0];
  store.updateUpload('thread', 'request', { progress: progress(4), descriptors: files, attachments: refs.slice(0, 4) });
  store.observeQueue('thread', [queued]);
  store.receipt('thread', { requestId: 'request', status: 'queued', uploadProgress: progress(4) });
  assert.equal(store.getThread('thread')[0].status, accepted.status);
  assert.equal(store.getThread('thread')[0].uploadProgress, accepted.uploadProgress);
  assert.equal(store.getThread('thread')[0].text, accepted.text);
  assert.equal(store.getThread('thread')[0].createdAt, accepted.createdAt);
  assert.equal(timeline(store, [], [queued]).tail[0].state, 'accepted');
  assert.equal(submittedOutbox(store.getThread('thread'), [], [queued])[0].attachments.length, 16);
});

test('a partial exact echo cannot retire accepted input or match a deferred identity candidate', () => {
  const store = createSubmittedQueryStore(); store.seed(seed);
  store.updateUpload('thread', 'request', { progress: progress(4), attachments: refs.slice(0, 4) });
  store.receipt('thread', { requestId: 'request', status: 'accepted' });
  const entry = store.getThread('thread')[0], partial = { ...echo, attachments: refs.slice(0, 4) };
  assert.equal(completeSubmittedEcho(entry, [partial]), false);
  assert.equal(submittedOutbox([], [partial], [{ ...queued, status: 'accepted', attachments: refs.slice(0, 4) }]).length, 1,
    'a restored server row also retains the expected attachment count before the store observes it');
  assert.equal(completeSubmittedEcho(entry, withSubmittedAttachments([{ ...echo, attachments: undefined }], [entry])), false);
  store.observeMessages('thread', [partial]); assert.equal(store.getThread('thread')[0].echoed, undefined);
  const candidate = { ...partial, id: 'candidate', clientMessageId: undefined };
  assert.equal(queryTimeline([candidate], [entry], [entry], [], new Set(['candidate'])).tail.length, 1);
  store.updateUpload('thread', 'request', { progress: progress(16), attachments: refs });
  assert.equal(store.getThread('thread')[0].status, 'accepted', 'late valid capabilities may fill the body without reopening transport');
  assert.equal(completeSubmittedEcho(store.getThread('thread')[0], [echo]), true);
  store.observeMessages('thread', [echo]); assert.equal(timeline(store, [echo]).tail.length, 0);
});

test('cancelled upload rows cannot be resurrected by late upload callbacks or queue snapshots', () => {
  const store = createSubmittedQueryStore(); store.seed(seed);
  store.receipt('thread', { requestId: 'request', status: 'cancelled' }); store.dismiss('thread', 'request');
  store.updateUpload('thread', 'request', { progress: progress(16), attachments: refs });
  store.observeQueue('thread', [queued]);
  assert.equal(timeline(store, [], [queued]).tail.length, 0); assert.equal(store.reloadBlocker(), null);
  assert.equal(store.getThread('thread')[0].status, 'cancelled');
});

test('a server missing snapshot cannot erase a known local failed or uncertain upload result', () => {
  for (const status of ['failed', 'unknown']) {
    const store = createSubmittedQueryStore();
    const descriptors = files.map((file, i) => ({ ...file, status: i === 0 ? status : 'queued' }));
    store.seed({ ...seed, attachmentUploads: descriptors, uploadProgress: { ...progress(0), status: 'failed' } });
    store.observeQueue('thread', [{ ...queued, attachmentUploads: files.map(file => ({ ...file, status: 'missing' })) }]);
    store.receipt('thread', { requestId: 'request', status: 'queued', uploadProgress: progress(0) });
    assert.equal(store.getThread('thread')[0].attachmentUploads[0].status, status);
    assert.match(renderCard(store.getThread('thread')[0]), status === 'unknown' ? /上传结果待核对/ : /重试失败附件/);
    store.updateUpload('thread', 'request', { descriptors: files, progress: progress(0) });
    assert.equal(store.getThread('thread')[0].status, 'uploading', 'an explicit retry/reset may clear a definite local failure');
  }
});

test('server queued progress shows uploading and disables partial direct-send and body editing', () => {
  const item = { ...queued, uploadProgress: progress(4), attachments: refs.slice(0, 4) };
  const html = renderQueue(item);
  assert.match(html, /上传中 4\/16/); assert.match(html, /unique ending 16.jpg/);
  assert.match(html, /<button[^>]*disabled[^>]*>直接发送<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>编辑<\/button>/);
  assert.match(html, /<button(?![^>]*disabled)[^>]*>取消发送<\/button>/);
  assert.doesNotMatch(html, /data-feedback-state="accepted"|已发送/);
  assert.equal(queueHeadState(item).blocked, true);
  assert.deepEqual(queueFeedbackState(item), { state: 'uploading', breathing: true });
  assert.equal(queueFeedbackState(item, { disabled: true }).breathing, false);
});

test('failed uploads offer explicit retry while unknown uploads and unknown sends offer verification only', () => {
  const failed = { ...seed, status: 'upload_failed', uploadProgress: { ...progress(4), status: 'failed' }, attachmentUploads: files.map((file, i) => ({ ...file, status: i ? 'uploaded' : 'failed' })) };
  assert.match(renderCard(failed), /重试失败附件/);
  const unknown = { ...failed, attachmentUploads: files.map((file, i) => ({ ...file, status: i ? 'uploaded' : 'unknown' })) };
  for (const item of [unknown, { ...failed, status: 'unknown' }]) {
    const html = renderCard(item); assert.match(html, /核对状态/); assert.doesNotMatch(html, /重试失败附件|data-feedback-state="accepted"/);
  }
  const queueHtml = renderQueue({ ...queued, uploadProgress: failed.uploadProgress, attachmentUploads: unknown.attachmentUploads });
  assert.match(queueHtml, /上传结果待核对/); assert.doesNotMatch(queueHtml, /重试失败附件/);
  assert.equal(queueFeedbackState({ ...queued, attachmentUploads: unknown.attachmentUploads }).breathing, false);
});

test('upload reservations never synthesize green from history; the actual accepted receipt is the only success', () => {
  const tracker = createSubmissionFeedbackTracker(() => 1000);
  tracker.trackQueued('request', { uploadProgress: progress(0) });
  for (const source of ['rollout', 'desktop']) {
    assert.deepEqual(tracker.observeHistory({ source, messages: [echo], outbox: [] }), []);
    assert.equal(tracker.hasAccepted('request'), false);
  }
  assert.equal(tracker.accept({ requestId: 'request', status: 'queued' }), null);
  assert.equal(tracker.accept({ requestId: 'request', status: 'accepted' }).requestId, 'request');
  assert.equal(tracker.accept({ requestId: 'request', status: 'accepted' }), null);
});

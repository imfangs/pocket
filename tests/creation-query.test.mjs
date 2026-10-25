import test from 'node:test';
import assert from 'node:assert/strict';
import { beginCreationClipboard, createCreationClipboardReader, prepareCreationDialog, editCreationQuery, applyCreationClipboard, creationQueryPayload } from '../src/creationQuery.ts';

const empty = () => ({ text: '', revision: 0 });

test('ordinary new-dialog clipboard reading starts synchronously inside the click before any awaited flush', async () => {
  const order = [];
  const clipboard = beginCreationClipboard(() => { order.push('clipboard'); return Promise.resolve('  Copied query\n'); });
  assert.deepEqual(order, ['clipboard']);
  await Promise.resolve().then(() => { order.push('flush'); });
  assert.deepEqual(await clipboard, { text: '  Copied query\n' });
  assert.deepEqual(order, ['clipboard', 'flush']);
});

test('resuming an existing creation never reads a new clipboard', () => {
  assert.equal(beginCreationClipboard(() => { assert.fail('recovery must preserve the original request'); }, true), undefined);
});

test('denied and unavailable clipboard access produce an editable empty fallback without rejection', async () => {
  for (const read of [() => { throw new Error('Unavailable'); }, async () => { throw new Error('NotAllowedError'); }]) {
    const result = await beginCreationClipboard(read);
    assert.equal(result.text, ''); assert.match(result.hint, /手动粘贴/);
    assert.equal(applyCreationClipboard(empty(), result).text, '');
  }
});

test('a late clipboard result fills an untouched Query but never replaces typing, even identical later text', async () => {
  let resolve;
  const clipboard = beginCreationClipboard(() => new Promise(done => { resolve = done; }));
  const typed = editCreationQuery(empty(), 'My new text');
  resolve('Clipboard text'); const result = await clipboard;
  assert.equal(applyCreationClipboard(empty(), result).text, 'Clipboard text');
  assert.equal(applyCreationClipboard(typed, result), typed);
  const typedThenErased = editCreationQuery(typed, '');
  assert.equal(applyCreationClipboard(typedThenErased, result), typedThenErased);
});

test('clearing an already empty Query claims it before the clipboard resolves', async () => {
  let resolve;
  const clipboard = beginCreationClipboard(() => new Promise(done => { resolve = done; }));
  let draft = empty();
  const filling = clipboard.then(result => { draft = applyCreationClipboard(draft, result); });
  draft = editCreationQuery(draft, '');
  resolve('This must not come back'); await filling;
  assert.equal(draft.text, ''); assert.equal(draft.revision, 1);
  assert.deepEqual(creationQueryPayload(draft.text), {});
});

test('submission freezes its current Query against a late clipboard and omits initialQuery for empty text', () => {
  const submitted = editCreationQuery(empty(), '');
  assert.equal(applyCreationClipboard(submitted, { text: 'Late clipboard' }), submitted);
  for (const query of ['', ' \n\t ']) assert.deepEqual(creationQueryPayload(query), {});
  assert.deepEqual(creationQueryPayload('  The first query\n'), { initialQuery: 'The first query' });
});

test('oversized clipboard text stays intact and cannot silently create a truncated first query', async () => {
  const text = '中'.repeat(16001), clipboard = await beginCreationClipboard(async () => text);
  assert.equal(clipboard.text, text);
  assert.throws(() => creationQueryPayload(applyCreationClipboard(empty(), clipboard).text), /16000/);
  assert.equal(creationQueryPayload('中'.repeat(16000)).initialQuery.length, 16000);
});

test('the actual opening helper reads inside the click and opens the dialog without waiting for clipboard permission', async () => {
  const order = []; let resolveClipboard;
  const opening = prepareCreationDialog({
    readText: () => { order.push('clipboard'); return new Promise(resolve => { resolveClipboard = resolve; }); },
    flush: async () => { order.push('flush'); },
    getLatest: () => undefined,
  });
  assert.deepEqual(order, ['clipboard', 'flush']);
  const prepared = await opening;
  assert.equal(prepared.kind, 'dialog');
  resolveClipboard('Late clipboard query');
  assert.deepEqual(await prepared.clipboardRead, { text: 'Late clipboard query' });
});

test('a resumed pending create that completes during flush opens its original result instead of another submit form', async () => {
  const existing = { requestId: 'original-create', operation: 'create', status: 'pending' };
  let latest = existing, releaseFlush;
  const opening = prepareCreationDialog({ existing,
    readText: async () => { assert.fail('must not replace a pending creation with clipboard input'); },
    getLatest: requestId => { assert.equal(requestId, existing.requestId); return latest; },
    flush: () => new Promise(resolve => { releaseFlush = resolve; }),
  });
  latest = { ...existing, status: 'succeeded', threadId: 'original-thread' };
  releaseFlush();
  const prepared = await opening;
  assert.equal(prepared.kind, 'open');
  assert.equal(prepared.threadId, 'original-thread');
  assert.equal(prepared.operation, latest);
  assert.equal(prepared.clipboardRead, undefined);
});

test('resuming an unresolved creation reads its latest receipt and keeps the clipboard untouched', async () => {
  const existing = { requestId: 'original-create', operation: 'create', status: 'pending' };
  const latest = { ...existing, status: 'unknown' };
  const prepared = await prepareCreationDialog({ existing, readText: async () => { assert.fail('no clipboard read during recovery'); },
    getLatest: () => latest, flush: async () => {},
  });
  assert.equal(prepared.kind, 'dialog'); assert.equal(prepared.operation, latest); assert.equal(prepared.clipboardRead, undefined);
});

test('explicit paste accepts only the revision claimed when that read started', () => {
  const retried = editCreationQuery(empty(), '');
  assert.equal(applyCreationClipboard(retried, { text: 'Pasted after clearing' }, retried.revision).text, 'Pasted after clearing');
  const typed = editCreationQuery(retried, 'New typing');
  assert.equal(applyCreationClipboard(typed, { text: 'Late paste' }, retried.revision), typed);
  const cleared = editCreationQuery(retried, '');
  assert.equal(applyCreationClipboard(cleared, { text: 'Late paste' }, retried.revision), cleared);
});

const pendingClipboard = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const settleClipboard = () => new Promise(resolve => setImmediate(resolve));

test('retrying a hung automatic read accepts the retry and discards the late original result', async () => {
  const automatic = pendingClipboard(), retry = pendingClipboard(), pending = [];
  let draft = empty();
  const reader = createCreationClipboardReader({ onPending: value => pending.push(value), onResult: (result, revision) => { draft = applyCreationClipboard(draft, result, revision); } });
  reader.watch(automatic.promise, 0);
  draft = editCreationQuery(draft, ''); reader.watch(retry.promise, draft.revision);
  automatic.resolve({ text: 'Old automatic content' }); await settleClipboard();
  assert.equal(draft.text, ''); assert.deepEqual(pending, [true, true]);
  retry.resolve({ text: 'Fresh retry content' }); await settleClipboard();
  assert.equal(draft.text, 'Fresh retry content'); assert.deepEqual(pending, [true, true, false]); reader.dispose();
});

test('a newer retry supersedes an earlier retry even when their revision is equal', async () => {
  const first = pendingClipboard(), second = pendingClipboard(), results = [];
  const reader = createCreationClipboardReader({ onPending: () => {}, onResult: value => results.push(value) });
  reader.watch(first.promise, 3); reader.watch(second.promise, 3);
  second.resolve({ text: 'Newest' }); await settleClipboard(); first.resolve({ text: 'Stale' }); await settleClipboard();
  assert.deepEqual(results, [{ text: 'Newest' }]); reader.dispose();
});

test('read failure settles feedback and a later successful retry replaces its error hint', async () => {
  const pending = []; let draft = empty();
  const reader = createCreationClipboardReader({ onPending: value => pending.push(value), onResult: (result, revision) => { draft = applyCreationClipboard(draft, result, revision); } });
  reader.watch(Promise.reject(new DOMException('Denied', 'NotAllowedError')), 0); await settleClipboard();
  assert.equal(draft.text, ''); assert.match(draft.hint, /手动粘贴/); assert.deepEqual(pending, [true, false]);
  draft = editCreationQuery(draft, ''); reader.watch(Promise.resolve({ text: 'New paste' }), draft.revision); await settleClipboard();
  assert.equal(draft.text, 'New paste'); assert.equal(draft.hint, undefined); reader.dispose();
});

test('editing, clearing, or submitting can cancel pending feedback without accepting its later result', async () => {
  for (const action of ['typing', 'clearing', 'submitting']) {
    const read = pendingClipboard(), pending = [], results = [];
    const reader = createCreationClipboardReader({ onPending: value => pending.push(value), onResult: value => results.push(value) });
    reader.watch(read.promise, 0); reader.cancel(); read.resolve({ text: action }); await settleClipboard();
    assert.deepEqual(pending, [true, false], action); assert.deepEqual(results, [], action); reader.dispose();
  }
});

test('disposed clipboard readers ignore late success, late failure and new reads', async () => {
  for (const rejected of [false, true]) {
    const read = pendingClipboard(), pending = [], results = [];
    const reader = createCreationClipboardReader({ onPending: value => pending.push(value), onResult: value => results.push(value) });
    reader.watch(read.promise, 0); reader.dispose();
    if (rejected) read.reject(new Error('Late rejection')); else read.resolve({ text: 'Late result' });
    reader.watch(Promise.resolve({ text: 'New result' }), 1); reader.cancel(); await settleClipboard();
    assert.deepEqual(pending, [true]); assert.deepEqual(results, []);
  }
});

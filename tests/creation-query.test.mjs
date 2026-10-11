import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCreationDialog, creationQueryPayload } from '../src/creationQuery.ts';

test('opening creation never reads the clipboard or waits for paste permission', async () => {
  const order = [];
  const prepared = await prepareCreationDialog({
    readText: () => { assert.fail('opening a form must not request clipboard access'); },
    flush: async () => { order.push('flush'); },
    getLatest: () => undefined,
  });
  assert.deepEqual(order, ['flush']);
  assert.deepEqual(prepared, { kind: 'dialog', operation: undefined });
});

test('failed pending edits stop creation without requesting clipboard access', async () => {
  await assert.rejects(prepareCreationDialog({
    readText: () => { assert.fail('no clipboard request on failure'); },
    flush: async () => { throw new Error('Save failed'); }, getLatest: () => undefined,
  }), /Save failed/);
});

test('empty Query is omitted and a manually entered or pasted Query is trimmed', () => {
  for (const query of ['', ' \n\t ']) assert.deepEqual(creationQueryPayload(query), {});
  assert.deepEqual(creationQueryPayload('  Pasted first query\n'), { initialQuery: 'Pasted first query' });
});

test('oversized initial Query is rejected instead of silently truncated', () => {
  assert.throws(() => creationQueryPayload('中'.repeat(16001)), /16000/);
  assert.equal(creationQueryPayload('中'.repeat(16000)).initialQuery.length, 16000);
});

test('a resumed pending create that completes during flush opens its original result', async () => {
  const existing = { requestId: 'original-create', operation: 'create', status: 'pending' };
  let latest = existing, releaseFlush;
  const opening = prepareCreationDialog({ existing,
    getLatest: requestId => { assert.equal(requestId, existing.requestId); return latest; },
    flush: () => new Promise(resolve => { releaseFlush = resolve; }),
  });
  latest = { ...existing, status: 'succeeded', threadId: 'original-thread' };
  releaseFlush();
  const prepared = await opening;
  assert.equal(prepared.kind, 'open');
  assert.equal(prepared.threadId, 'original-thread');
  assert.equal(prepared.operation, latest);
});

test('resuming an unresolved creation uses its latest receipt', async () => {
  const existing = { requestId: 'original-create', operation: 'create', status: 'pending' };
  const latest = { ...existing, status: 'unknown' };
  const prepared = await prepareCreationDialog({ existing, getLatest: () => latest, flush: async () => {} });
  assert.deepEqual(prepared, { kind: 'dialog', operation: latest });
});

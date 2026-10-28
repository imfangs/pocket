import test from 'node:test';
import assert from 'node:assert/strict';
import { readResponseVersion } from '../server/catalog-response.mjs';
import { hydrateReadResponse, readResponseKind, splitReadResponse, isReadVersion } from '../shared/read-response.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const scope = (kind = 'history', machineId = 'ged') => ({
  path: kind === 'catalog' || kind === 'sync' ? `/api/${kind}` : `/api/tasks/${id}/${kind}`,
  method: kind === 'sync' ? 'POST' : 'GET', machineId,
});
const version = (data, kind = 'history') => readResponseVersion(data, scope(kind)).etag;
const history = () => ({ source: 'desktop', checkedAt: 1000, runtime: 'idle', canSend: true,
  canAttemptSend: true, canStop: false, canCompact: true, queueReady: true, queuePaused: false,
  connection: { status: 'connected', checkedAt: 900 }, outbox: [], pendingRequests: [], asyncQuestions: [],
  contextUsage: { usedTokens: 100, contextWindow: 200 },
  turnTiming: { turnId: 'turn', status: 'completed', startedAt: 100, durationMs: 800, observedAt: 1000 },
  messages: [{ id: 'reply', role: 'assistant', text: 'Fixture', phase: 'final', timestamp: 800 }], hasMore: false });

test('conditional reading is explicitly limited to four method/path pairs', () => {
  for (const kind of ['catalog', 'sync', 'transcript', 'history']) {
    const request = scope(kind);
    assert.equal(readResponseKind(request.path, request.method), kind);
  }
  for (const [path, method] of [['/api/sync', 'GET'], ['/api/catalog', 'POST'],
    [`/api/tasks/${id}/messages/${id}`, 'GET'], [`/api/tasks/${id}/attachments`, 'GET'],
    [`/api/tasks/${id}/history/extra`, 'GET'], ['/api/catalog?scope=other', 'GET']]) {
    assert.equal(readResponseKind(path, method), null);
    assert.equal(readResponseVersion({}, { path, method, machineId: 'ged' }), null);
  }
});

test('only proven observation paths are excluded and are losslessly hydrated', () => {
  const before = history(), after = { ...before, checkedAt: 2200,
    turnTiming: { ...before.turnTiming, observedAt: 2100 } };
  assert.equal(version(before), version(after));
  const metadata = splitReadResponse('history', after);
  const restored = hydrateReadResponse('history', before, new Headers(metadata.headers));
  assert.deepEqual(restored, after);
  assert.equal(before.checkedAt, 1000);
  assert.equal(before.turnTiming.observedAt, 1000);
  assert.equal(restored.connection, before.connection, 'unmodified nested fields retain their values');
  assert.deepEqual(metadata.observationKeys, ['checkedAt', 'turnTiming.observedAt']);
  const catalog = { csrfToken: 'session', sourceInfo: { syncedAt: 1000, databaseMtime: 50 }, threads: [] };
  const fresh = { ...catalog, sourceInfo: { ...catalog.sourceInfo, syncedAt: 3000 } };
  assert.equal(version(catalog, 'catalog'), version(fresh, 'catalog'));
  assert.deepEqual(hydrateReadResponse('catalog', catalog, new Headers(splitReadResponse('catalog', fresh).headers)), fresh);
});

test('the whole dynamic response remains versioned, including permissions, receipts and timing', () => {
  const baseline = history(), expected = version(baseline);
  const updates = {
    message: value => { value.messages[0].text += ' streamed'; },
    messageIdentity: value => { value.messages[0].id = 'different'; },
    messageTimestamp: value => { value.messages[0].timestamp++; },
    runtime: value => { value.runtime = 'active'; },
    send: value => { value.canSend = false; },
    attemptSend: value => { value.canAttemptSend = false; },
    stop: value => { value.canStop = true; },
    compact: value => { value.canCompact = false; },
    ready: value => { value.queueReady = false; },
    paused: value => { value.queuePaused = true; },
    outbox: value => { value.outbox.push({ requestId: 'query', status: 'unknown', revision: 1 }); },
    approval: value => { value.pendingRequests.push({ key: 'approval', response: { status: 'unknown' } }); },
    question: value => { value.asyncQuestions.push({ key: 'question', title: 'Choose', options: ['A'] }); },
    context: value => { value.contextUsage.usedTokens++; },
    connectionTime: value => { value.connection.checkedAt++; },
    turnStart: value => { value.turnTiming.startedAt++; },
    turnDuration: value => { value.turnTiming.durationMs++; },
    turnStatus: value => { value.turnTiming.status = 'inProgress'; },
    more: value => { value.hasMore = true; },
    unknownField: value => { value.futureCapability = { checkedAt: 2 }; },
  };
  for (const [name, update] of Object.entries(updates)) {
    const changed = structuredClone(baseline); update(changed);
    assert.notEqual(version(changed), expected, `${name} must invalidate a saved read`);
  }
  const rollout = { ...baseline, source: 'rollout' };
  assert.notEqual(version(rollout), version({ ...rollout, turnTiming: { ...rollout.turnTiming, observedAt: 2000 } }));
  assert.notEqual(version(baseline, 'transcript'), version({ ...baseline, turnTiming: { ...baseline.turnTiming, observedAt: 2000 } }, 'transcript'));
});

test('observation presence, invalid values, scope and CSRF changes cannot alias a saved version', () => {
  const original = history();
  for (const value of [undefined, null, '1000', -1, NaN, Infinity, {}, 1000.5])
    assert.notEqual(version(original), version({ ...original, checkedAt: value }));
  assert.notEqual(version(original), readResponseVersion(original, scope('history', 'wandou')).etag);
  assert.notEqual(version(original), version(original, 'transcript'));
  const catalog = { csrfToken: 'session-a', sourceInfo: { syncedAt: 1000 }, threads: [] };
  assert.notEqual(version(catalog, 'catalog'), version({ ...catalog, csrfToken: 'session-b' }, 'catalog'));
  assert.notEqual(version(catalog, 'catalog'), version({ ...catalog, sourceError: 'unavailable' }, 'catalog'));
  const transcript = { source: 'rollout', messages: [], checkedAt: 1000, readObservation: { token: 'old-authority' } };
  assert.notEqual(version(transcript, 'transcript'), version({ ...transcript, readObservation: { token: 'new-authority' } }, 'transcript'));
  assert.ok(isReadVersion(version(original)));
  assert.equal(isReadVersion('W/"other"'), false);
});

test('missing or malformed observation headers require a full read, never stale freshness', () => {
  const data = history(), valid = splitReadResponse('history', data).headers;
  for (const value of [null, '', '1e3', '-1', 'NaN', '001', '8640000000000001']) {
    const headers = new Headers(valid);
    if (value === null) headers.delete('X-Pocket-Checked-At');
    else headers.set('X-Pocket-Checked-At', value);
    assert.equal(hydrateReadResponse('history', data, headers), null);
  }
  const noTiming = new Headers(valid); noTiming.delete('X-Pocket-Turn-Observed-At');
  assert.equal(hydrateReadResponse('history', data, noTiming), null);
});

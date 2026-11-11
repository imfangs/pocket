import test from 'node:test';
import assert from 'node:assert/strict';
import { turnFailures, displayedTurnFailures, turnFailurePlacement, turnFailureSummary, turnFailureDetails, failureTailTurnId } from '../src/turnFailures.ts';
import { conversationReadModel } from '../src/conversationReadModel.ts';
import { createListActivityCache } from '../src/listActivityCache.ts';
import { threadListPresentation } from '../src/listPresentation.ts';
import { taskStatusMap } from '../src/taskStatuses.ts';
import { createReadingCache } from '../src/readingCache.ts';

const busy = 'We’re currently experiencing high demand, which may cause temporary errors.';
const row = (id, turnId, role = 'assistant') => ({ id, turnId, role, text: id, ...(role === 'assistant' ? { phase: 'commentary' } : {}) });
const history = extra => ({ source: 'desktop', resumeState: 'resumed', runtime: 'idle', canSend: true, messages: [], checkedAt: 101,
  latestTurnId: 'failed-turn', latestTurnStatus: 'failed', ...extra });
const response = (status, latestTurnId, statusSource = 'desktop', checkedAt = 100) => ({ available: true, checkedAt,
  states: [{ threadId: 'thread', status, latestTurnId, statusSource, checkedAt }] });
const view = (runtimeStates = new Map(), unavailable = false) => ({ runtimeStates, runtimeUnavailable: unavailable, runtimeLoading: false });
function cache() { const c = createListActivityCache('ged', 'scope', () => 110); c.update([{ id: 'thread' }]); return c; }

test('failure metadata is bounded, plaintext and independent of capabilities or raw messages', () => {
  const input = Array.from({ length: 40 }, (_, i) => ({ turnId: `turn-${i}`, message: 'x'.repeat(2100), additionalDetails: 'd'.repeat(4100), code: 'internal_server_error',
    canSend: true, files: { secret: '/tmp/private' }, requestId: 'not-a-receipt' }));
  const before = JSON.stringify(input), values = turnFailures(input);
  assert.equal(values.length, 30); assert.equal(values[0].turnId, 'turn-10');
  assert.equal(values[0].message.length, 2000); assert.equal(values[0].additionalDetails.length, 4000);
  for (const key of ['canSend', 'files', 'requestId']) assert.equal(values[0][key], undefined);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(turnFailures([{ turnId: 'x', status: 'completed', message: 'not failed' }, { turnId: '', message: 'invalid' }]), []);
});

test('a fresh new running turn clears same-turn stale failure while keeping a previous failed turn readable', () => {
  const old = { turnId: 'old', message: busy }, same = { turnId: 'new', message: 'stale' };
  const live = history({ runtime: 'active', latestTurnId: 'new', latestTurnStatus: 'inProgress', activeTurnId: 'new', turnFailures: [old, same] });
  assert.deepEqual(displayedTurnFailures(live, null).map(x => x.turnId), ['old']);
  const completed = history({ latestTurnId: 'new', latestTurnStatus: 'completed', turnFailures: [same] });
  assert.deepEqual(displayedTurnFailures(completed, null), []);
});

test('native authority does not revive an obsolete saved failure for its completed latest turn', () => {
  const saved = { source: 'rollout', messages: [], checkedAt: 1, turnFailures: [{ turnId: 'same', message: busy }] };
  assert.deepEqual(displayedTurnFailures(history({ latestTurnId: 'same', latestTurnStatus: 'completed', turnFailures: [] }), saved), []);
  assert.equal(displayedTurnFailures(null, saved)[0].message, busy);
});

test('exact recorded historical failure enriches native missing details, but a known native completed old turn defeats it', () => {
  const saved = { source: 'rollout', checkedAt: 1, messages: [], turnFailures: [{ turnId: 'old', message: busy, code: 'internal_server_error' }] };
  const live = history({ latestTurnId: 'new', latestTurnStatus: 'inProgress', activeTurnId: 'new', runtime: 'active',
    recentTurns: [{ id: 'old', status: 'failed' }, { id: 'new', status: 'inProgress' }], turnFailures: [{ turnId: 'old' }] });
  assert.equal(displayedTurnFailures(live, saved)[0].message, busy);
  assert.equal(displayedTurnFailures(live, saved)[0].code, 'internal_server_error');
  live.recentTurns[0].status = 'completed'; assert.deepEqual(displayedTurnFailures(live, saved), []);
});

test('known failed status without an error object still gets an honest no-reason display fact', () => {
  const failure = displayedTurnFailures(history(), null)[0];
  assert.equal(failure.turnId, 'failed-turn'); assert.equal(turnFailureSummary(failure), '未收到具体错误原因。');
  assert.deepEqual(displayedTurnFailures(history({ latestTurnStatus: 'interrupted', turnFailures: [] }), null), []);
  assert.deepEqual(displayedTurnFailures(history({ runtime: 'systemError', latestTurnStatus: undefined, latestTurnId: null, turnFailures: [] }), null), []);
});

test('inline placement preserves failed-turn chronology and never moves an unanchored historical error below a new reply', () => {
  const messages = [row('old-user', 'old', 'user'), row('old-progress', 'old'), row('new-user', 'new', 'user'), row('new-progress', 'new')];
  const entries = messages.map(message => ({ type: 'message', message }));
  const result = turnFailurePlacement(entries, [{ turnId: 'old', message: busy }, { turnId: 'outside', message: 'not visible' }], 'new');
  assert.equal(result.after.get(1)[0].turnId, 'old'); assert.equal(result.after.size, 1); assert.deepEqual(result.tail, []);
  assert.equal(turnFailurePlacement(entries, [{ turnId: 'latest', message: 'no message yet' }], 'latest').tail[0].turnId, 'latest');
  assert.deepEqual(messages.map(x => x.id), ['old-user', 'old-progress', 'new-user', 'new-progress']);
});

test('failure read projection preserves raw receipt inputs and exact source objects', () => {
  const messages = [row('query', 'old', 'user'), row('progress', 'old')], raw = history({ messages, turnFailures: [{ turnId: 'old', message: busy }] });
  const input = { scope: 'ged:scope:thread', readingScope: 'scope', history: raw, transcript: null, submitted: [], cachedPreview: null, previewAllowed: true };
  const before = JSON.stringify(raw), model = conversationReadModel(input);
  assert.equal(model.turnFailures[0].message, busy); assert.deepEqual(model.liveDisplay.messages, messages); assert.equal(model.liveDisplay.messages[0], messages[0]);
  assert.equal(JSON.stringify(raw), before); assert.equal(model.canSend, undefined); assert.equal(model.turnFailures[0].clientMessageId, undefined);
});

test('friendly high-demand summary keeps original error details, unknown messages remain verbatim', () => {
  const failure = { turnId: 'x', message: busy, code: 'internal_server_error' };
  assert.equal(turnFailureSummary(failure), '服务繁忙，本轮未能完成。'); assert.equal(turnFailureDetails(failure), busy + '\n\ninternal_server_error');
  assert.equal(turnFailureSummary({ turnId: 'y', message: 'Tool output is data <script>alert(1)</script>' }), 'Tool output is data <script>alert(1)</script>');
});

test('latest failed list fact has a primary label and can be cached without becoming working or unread evidence', () => {
  const r = response('failed', 'f'); assert.equal(taskStatusMap(r).get('thread'), 'failed');
  assert.equal(taskStatusMap(response('failed', undefined)), null);
  assert.equal(taskStatusMap(response('idle', ' ')), null); assert.equal(taskStatusMap(response('idle', 'new', 'invented')), null);
  const c = cache(); c.observe(r); const projection = c.project(view(new Map(), true));
  assert.equal(projection.listRuntimeStates.get('thread'), 'failed'); assert.equal(projection.listRuntimeCached, true);
  assert.equal(threadListPresentation({ id: 'thread', pocketUnread: false }, false, 'failed').primaryState.key, 'failed');
});

test('weak recorded end cannot erase same/no-ID cached failure; native idle and a newer turn do', () => {
  for (const id of ['f', undefined]) {
    const c = cache(); c.observe(response('failed', 'f'));
    c.observe(response('idle', id, 'rollout', 105));
    assert.equal(c.project(view(taskStatusMap(response('idle', id, 'rollout', 105)))).listRuntimeStates.get('thread'), 'failed');
    c.observe(response('idle', 'f', 'desktop', 106)); assert.equal(c.project(view(new Map())).listRuntimeStates.get('thread'), 'idle');
  }
  const c = cache(); c.observe(response('failed', 'f')); c.observe(response('running', 'new', 'desktop', 106));
  assert.equal(c.project(view(new Map())).listRuntimeStates.get('thread'), 'running');
});

test('native latest failure enters the same list cache and explicit newer native history removes it', () => {
  const c = cache(); assert.equal(c.observeNativeHistory('thread', history(), 105), true);
  assert.equal(c.project(view(new Map(), true)).listRuntimeStates.get('thread'), 'failed');
  assert.equal(c.observeNativeHistory('thread', history({ runtime: 'active', latestTurnId: 'new', activeTurnId: 'new', latestTurnStatus: 'inProgress', checkedAt: 106 }), 105), true);
  assert.equal(c.project(view(new Map(), true)).listRuntimeStates.get('thread'), 'running');
});

test('current native questions or owner waiting override the previous failed list fact', () => {
  for (const extra of [{ pendingRequests: [{ kind: 'questions' }] }, { canSend: false, hint: '任务正在等待审批或输入，请在 Mac 的 Codex 中处理。' }]) {
    const c = cache(); c.observe(response('failed', 'failed-turn'));
    assert.equal(c.observeNativeHistory('thread', history({ runtime: 'active', activeTurnId: null, checkedAt: 106, ...extra }), 105), true);
    assert.equal(c.project(view(new Map())).listRuntimeStates.get('thread'), 'waiting_input');
  }
});

test('real read projection cannot put an unanchored old native error after a newer recorded retry', () => {
  const old = history({ turnFailures: [{ turnId: 'failed-turn', message: busy }], turnTiming: { turnId: 'failed-turn', status: 'failed', startedAt: 10 } });
  const saved = { source: 'rollout', messages: [row('new-query', 'new-turn', 'user')], turnTiming: { turnId: 'new-turn', status: 'inProgress', startedAt: 20 } };
  const model = conversationReadModel({ scope: 'ged:scope:thread', readingScope: 'scope', history: old, transcript: saved, submitted: [], cachedPreview: null, previewAllowed: true });
  assert.equal(model.shownMessages.at(-1).turnId, 'new-turn'); assert.equal(model.failureTailTurnId, 'new-turn');
  const placement = turnFailurePlacement(model.shownMessages.map(message => ({ type: 'message', message })), model.turnFailures, model.failureTailTurnId);
  assert.deepEqual(placement.tail, []); assert.equal(placement.after.size, 0);
});

test('an actually latest failed turn without body keeps its fallback after older native/recorded messages', () => {
  const oldBody = [row('old-answer', 'old-turn')];
  const current = history({ messages: oldBody, turnTiming: { turnId: 'failed-turn', status: 'failed', startedAt: 20 },
    recentTurns: [{ id: 'old-turn', status: 'completed' }, { id: 'failed-turn', status: 'failed' }] });
  const saved = { source: 'rollout', messages: oldBody, turnTiming: { turnId: 'old-turn', status: 'completed', startedAt: 10 } };
  assert.equal(failureTailTurnId(current, saved, oldBody), 'failed-turn');
  assert.equal(failureTailTurnId(history(), null, []), 'failed-turn');
});

test('the reading cache keeps bounded failure text without restoring runtime, receipts or read watermarks', async () => {
  const c = createReadingCache({ storage: null, now: () => 1000 });
  try {
    assert.equal(c.rememberTranscript('ged', 'scope', 'thread', { source: 'rollout', checkedAt: 1000, messages: [row('query', 'old', 'user')],
      turnFailures: [{ turnId: 'old', message: busy, code: 'internal_server_error', canSend: true, requestId: 'not-receipt' }],
      canSend: true, runtime: 'active', pendingRequests: ['unsafe'] }), true);
    const saved = (await c.loadTranscript('ged', 'scope', 'thread')).value;
    assert.equal(saved.turnFailures[0].message, busy); assert.equal(saved.turnFailures[0].requestId, undefined);
    assert.equal(saved.canSend, undefined); assert.equal(saved.runtime, undefined); assert.equal(saved.pendingRequests, undefined); assert.equal(saved.pocketContent, undefined);
  } finally { c.dispose(); }
});

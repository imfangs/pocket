import test from 'node:test';
import assert from 'node:assert/strict';
import { observeConversationRuntime, conversationRuntimeFeedback, conversationRuntimeIsCurrent } from '../src/conversationRuntimeActivity.ts';

const mac = 1790000000000, mono = 1000, scope = 'machine/source/thread';
const active = { source: 'desktop', resumeState: 'resumed', runtime: 'active', latestTurnStatus: 'inProgress',
  activeTurnId: 'current', latestTurnId: 'current', messages: [], checkedAt: mac, canSend: true, hint: '',
  turnTiming: { turnId: 'current', status: 'inProgress', startedAt: mac - 20 * 60000, observedAt: mac, durationMs: null },
  runtimeActivity: { turnId: 'current', lastMessageAt: mac - 14 * 60000, lastEventAt: mac - 4 * 1000, activeOperation: null } };
const capture = (history = active, previous = null, receivedAt = mono) => observeConversationRuntime(history, { scope, receivedAt, previous });
const feedback = (observation = capture(), extra = {}) => conversationRuntimeFeedback({ scope, history: active, observation, working: true, now: mono, ...extra });

test('explicit disclosure can inspect a short run without inventing a new event or renewing authority', () => {
  const short = { ...active, turnTiming: { ...active.turnTiming, startedAt: mac - 30000 },
    runtimeActivity: { ...active.runtimeActivity, lastMessageAt: mac - 20000, lastEventAt: mac - 4000 } };
  const observation = capture(short);
  assert.equal(feedback(observation, { history: short }), null);
  const expanded = feedback(observation, { history: short, includeRecent: true });
  assert.equal(expanded.ageMs, 4000);
  assert.equal(expanded.state, 'working');
  const stale = feedback(observation, { history: short, includeRecent: true, now: mono + 61000 });
  assert.equal(stale.state, 'unconfirmed');
  assert.equal(stale.confirmedAgeMs, 61000);
});

test('text silence and real tool events have separate clocks, independent of the phone wall clock', () => {
  const result = feedback();
  assert.deepEqual(result, { state: 'working', turnId: 'current', operation: null, detail: 'activity', ageMs: 4000, confirmedAgeMs: 0 });
  assert.equal(feedback(capture(), { now: mono + 5000 }).ageMs, 9000);
  const operation = capture({ ...active, runtimeActivity: { ...active.runtimeActivity, activeOperation: { kind: 'command', startedAt: mac - 8 * 60000 } } });
  assert.equal(feedback(operation).operation, 'command');
  assert.equal(feedback(operation).detail, 'operation');
  assert.equal(feedback(operation).ageMs, 8 * 60000);
});

test('a repeated successful read does not manufacture an activity or reset a long command duration', () => {
  const original = capture({ ...active, runtimeActivity: { ...active.runtimeActivity, lastEventAt: mac - 8 * 60000 } });
  const newer = capture({ ...active, checkedAt: mac + 30000,
    turnTiming: { ...active.turnTiming, observedAt: mac + 30000 },
    runtimeActivity: { ...active.runtimeActivity, lastEventAt: mac - 8 * 60000 } }, original, mono + 30000);
  assert.equal(feedback(newer, { now: mono + 30000 }).ageMs, 8 * 60000 + 30000);
  const cached = capture({ ...active, turnTiming: { ...active.turnTiming, observedAt: mac + 30000 } }, newer, mono + 40000);
  assert.equal(cached.receivedAt, newer.receivedAt, 'The same native sample cannot renew its observation lease');
  assert.equal(feedback(cached, { now: mono + 95000 }).state, 'unconfirmed');
});

test('new visible streaming text renews text freshness, but merely polling the same text does not', () => {
  const text = { id: 'body', role: 'assistant', phase: 'commentary', turnId: 'current', timestamp: mac - 14 * 60000, text: 'First' };
  const original = capture({ ...active, messages: [text] });
  assert.ok(feedback(original));
  const updated = capture({ ...active, messages: [{ ...text, text: 'First and more visible text' }],
    turnTiming: { ...active.turnTiming, observedAt: mac + 2000 } }, original, mono + 2000);
  assert.equal(feedback(updated, { now: mono + 2000 }), null);
  const polled = capture({ ...active, messages: [{ ...text, text: 'First and more visible text' }],
    turnTiming: { ...active.turnTiming, observedAt: mac + 10000 } }, updated, mono + 10000);
  assert.equal(polled.visibleChangedAt, updated.visibleChangedAt);
  assert.equal(feedback(polled, { now: mono + 123000 }).state, 'unconfirmed');
});

test('a proven new visible tail message counts as progress even when a legacy timestamp falls back to turn start', () => {
  const first = { id: 'm1', role: 'assistant', phase: 'commentary', turnId: 'current', timestamp: mac - 20 * 60000, text: 'Earlier visible progress' };
  const second = { ...first, id: 'm2', text: 'A newly appended visible update' };
  const original = capture({ ...active, runtimeActivity: undefined, messages: [first] });
  const appendedHistory = { ...active, runtimeActivity: undefined, messages: [first, second],
    turnTiming: { ...active.turnTiming, observedAt: mac + 2000 } };
  const appended = capture(appendedHistory, original, mono + 2000);
  assert.equal(appended.visibleChangedAt, mono + 2000);
  assert.equal(feedback(appended, { history: appendedHistory, now: mono + 2000 }), null,
    'A just-arrived complete message must not remain labelled as activity from the turn start');
  const polled = capture({ ...appendedHistory, turnTiming: { ...active.turnTiming, observedAt: mac + 10000 } }, appended, mono + 10000);
  assert.equal(polled.visibleChangedAt, mono + 2000, 'Reading the same new tail again does not manufacture more progress');
});

test('first-read history, old samples and an unproven changed message window cannot fabricate appended progress', () => {
  const first = { id: 'baseline', role: 'assistant', phase: 'commentary', turnId: 'current', timestamp: mac - 20 * 60000, text: 'Baseline' };
  const second = { ...first, id: 'later', text: 'Later visible update' };
  const original = capture({ ...active, runtimeActivity: undefined, messages: [first] });
  const fresh = { ...active, runtimeActivity: undefined, messages: [first, second],
    turnTiming: { ...active.turnTiming, observedAt: mac + 2000 } };
  assert.equal(capture(fresh).visibleChangedAt, null, 'An initial reading is not a new emitted message');
  const old = capture({ ...fresh, turnTiming: { ...active.turnTiming, observedAt: mac - 1000 } }, original, mono + 2000);
  assert.equal(old, original, 'An older sample never renews progress or authority');
  for (const messages of [[second], [second, first], [first, { ...second, truncated: true }], [first, first, second], [first, second, second]]) {
    assert.equal(capture({ ...fresh, messages }, original, mono + 2000).visibleChangedAt, null,
      'A complete unique append must retain the exact prior visible tail in order');
  }
  assert.equal(capture({ ...fresh, turnTiming: active.turnTiming }, original, mono + 2000).visibleChangedAt, null,
    'The same cached sample is insufficient evidence for a new native tail');
  const differentScope = observeConversationRuntime(fresh, { scope: 'another/source/thread', receivedAt: mono + 2000, previous: original });
  assert.equal(differentScope.visibleChangedAt, null);
  const differentTurn = capture({ ...fresh, activeTurnId: 'next', latestTurnId: 'next',
    turnTiming: { ...fresh.turnTiming, turnId: 'next' }, messages: [first, { ...second, turnId: 'next' }] }, original, mono + 2000);
  assert.equal(differentTurn.visibleChangedAt, null);
});

test('short work stays quiet and old APIs use only exact current-turn visible message timestamps', () => {
  assert.equal(feedback(capture({ ...active, runtimeActivity: { ...active.runtimeActivity, lastMessageAt: mac - 60000 } })), null);
  const legacy = { ...active, runtimeActivity: undefined, messages: [
    { id: 'old', role: 'assistant', turnId: 'previous', timestamp: mac, text: 'Old turn cannot lend freshness' },
    { id: 'hidden', role: 'assistant', turnId: 'current', phase: 'analysis', timestamp: mac, text: 'Hidden text never becomes progress' },
    { id: 'current-body', role: 'assistant', turnId: 'current', timestamp: mac - 10 * 60000, text: 'Visible progress' },
  ] };
  assert.equal(feedback(capture(legacy)).ageMs, 10 * 60000);
  assert.equal(capture({ ...legacy, messages: [] }).lastMessageAt, null);
});

test('a frozen short native sample stops claiming current work before the long-wait caption threshold', () => {
  const recent = { ...active, turnTiming: { ...active.turnTiming, startedAt: mac },
    runtimeActivity: { ...active.runtimeActivity, lastMessageAt: mac, lastEventAt: mac } };
  const observation = capture(recent, null, 0);
  const input = { scope, history: recent, observation, working: true, now: 61000 };
  assert.equal(conversationRuntimeIsCurrent(input), false);
  assert.equal(conversationRuntimeFeedback(input), null, 'A quiet caption never proves fresh authority');
});

test('cached startup, changed scope/turn and untrusted DTOs cannot borrow a native running claim', () => {
  assert.equal(observeConversationRuntime({ ...active, source: 'rollout' }, { scope, receivedAt: mono }), null);
  assert.equal(feedback(capture(), { scope: 'another-machine/source/thread' }), null);
  assert.equal(feedback(capture(), { history: { ...active, activeTurnId: 'new' } }), null);
  const mismatched = capture({ ...active, runtimeActivity: { ...active.runtimeActivity, turnId: 'previous',
    activeOperation: { kind: 'tool', startedAt: mac } } });
  assert.equal(mismatched.activeOperation, null);
  const malformed = capture({ ...active, runtimeActivity: { ...active.runtimeActivity, lastEventAt: mac + 10000,
    activeOperation: { kind: ['command'], startedAt: true } } });
  assert.equal(malformed.activeOperation, null);
  assert.notEqual(malformed.lastEventAt, mac + 10000);
  const hostile = capture({ ...active, runtimeActivity: { ...active.runtimeActivity,
    activeOperation: { kind: { toString: false }, startedAt: mac } } });
  assert.equal(hostile.activeOperation, null, 'Optional metadata cannot throw while projecting readable messages');
});

test('lost current authority is neutral and requires explicit parent permission to show an unconfirmed read', () => {
  const observation = capture();
  assert.equal(feedback(observation, { working: false }), null);
  assert.equal(feedback(observation, { working: false, allowUnconfirmed: true }).state, 'unconfirmed');
  assert.equal(feedback(observation, { now: mono + 61000 }).state, 'unconfirmed');
  assert.equal(feedback(observation, { now: mono - 1 }).state, 'unconfirmed');
  assert.equal(feedback(observation, { available: false }), null);
});

test('known stops, waiting, compaction and terminal states do not become a generic stale-read hint', () => {
  for (const history of [{ ...active, pendingRequests: [{ key: 'approval' }] }, { ...active, compaction: { active: true } },
    { ...active, canSend: false, hint: '任务正在等待审批或输入，请在 Mac 的 Codex 中处理。' },
    { ...active, latestTurnStatus: 'completed', runtime: 'idle' }, { ...active, latestTurnStatus: 'failed' },
    { ...active, stopRequest: { targetTurnId: 'current', status: 'unknown' } }]) {
    assert.equal(feedback(capture(), { working: false, allowUnconfirmed: true, history }), null);
  }
  assert.equal(feedback(capture(), { working: false, allowUnconfirmed: true, history: { ...active, source: 'rollout' } }).state, 'unconfirmed');
});

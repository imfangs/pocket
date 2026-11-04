import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationIsWorking } from '../src/conversationWorking.ts';

const active = { source: 'desktop', resumeState: 'resumed', runtime: 'active', latestTurnStatus: 'inProgress',
  activeTurnId: 'turn-current', messages: [], checkedAt: 1, canSend: true, hint: '', pendingRequests: [] };
const observed = { observed: true };

test('working feedback requires an observed original-owner active turn, not a cache or delivery receipt', () => {
  assert.equal(conversationIsWorking(active, observed), true);
  assert.equal(conversationIsWorking(active), false);
  for (const history of [null, { ...active, source: 'rollout' }, { ...active, source: 'unavailable' },
    { ...active, resumeState: 'notResumed' }, { ...active, runtime: 'idle' }, { ...active, activeTurnId: null },
    { ...active, latestTurnStatus: undefined }, { ...active, latestTurnStatus: 'completed', outbox: [{ status: 'accepted' }] },
    { ...active, runtime: 'idle', outbox: [{ status: 'queued' }] }]) {
    assert.equal(conversationIsWorking(history, observed), false);
  }
});

test('reading, connectivity and blocking work retain their own state rather than a running animation', () => {
  for (const option of [{ online: false }, { available: false }, { connectionPending: true }, { readFailed: true }])
    assert.equal(conversationIsWorking(active, { ...observed, ...option }), false);
  for (const history of [{ ...active, compaction: { active: true } }, { ...active, pendingRequests: [{ key: 'approval' }] },
    { ...active, pendingRequests: [{ key: 'question', kind: 'questions' }] }, { ...active, runtime: 'systemError' },
    { ...active, latestTurnStatus: 'failed' }, { ...active, latestTurnStatus: 'interrupted' }])
    assert.equal(conversationIsWorking(history, observed), false);
  assert.equal(conversationIsWorking({ ...active, asyncQuestions: [{ turnId: 'turn-current' }] }, observed), true,
    'An optional async question does not claim the original owner stopped working');
});

test('same-turn stop and recorded completion suppress only that exact turn', () => {
  for (const status of ['pending', 'accepted', 'unknown', 'stopped', 'ended']) {
    assert.equal(conversationIsWorking({ ...active, stopRequest: { targetTurnId: 'turn-current', status } }, observed), false);
    assert.equal(conversationIsWorking({ ...active, stopRequest: { targetTurnId: 'turn-before', status } }, observed), true);
  }
  for (const status of ['completed', 'failed', 'interrupted']) {
    assert.equal(conversationIsWorking(active, { ...observed, recordedTiming: { turnId: 'turn-current', status } }), false);
    assert.equal(conversationIsWorking(active, { ...observed, recordedTiming: { turnId: 'turn-before', status } }), true);
  }
  assert.equal(conversationIsWorking(active, { ...observed, recordedTiming: { turnId: 'turn-current', status: 'inProgress' } }), true);
  assert.equal(conversationIsWorking({ ...active, stopRequest: { targetTurnId: 'turn-current', status: 'rejected' } }, observed), true);
});

test('native user-wait flags remain blocked even without a projected request card', () => {
  const hint = '任务正在等待审批或输入，请在 Mac 的 Codex 中处理。';
  assert.equal(conversationIsWorking({ ...active, canSend: false, hint }, observed), false);
  assert.equal(conversationIsWorking({ ...active, canSend: false, hint: '思考强度尚待核对，请打开会话信息。' }, observed), true);
  assert.equal(conversationIsWorking({ ...active, canSend: true, hint }, observed), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistory } from '../server/history.mjs';
import { normalizeTurnFailures, turnFailureFromError } from '../shared/turn-failure.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';

const highDemand = 'We’re currently experiencing high demand, which may cause temporary errors.';
const event = (type, turnId, more = {}, at = '2026-11-11T10:59:05.869Z') => JSON.stringify({
  type: 'event_msg', timestamp: at, payload: { type, turn_id: turnId, ...more },
});
const message = (id, turnId) => JSON.stringify({ type: 'response_item', timestamp: '2026-11-11T10:55:00Z',
  payload: { id, type: 'message', role: 'assistant', phase: 'commentary',
    internal_chat_message_metadata_passthrough: { turn_id: turnId }, content: [{ type: 'output_text', text: 'Original process text' }] } });

test('real task_complete error envelope is a failed turn without inventing an assistant reply', () => {
  const error = { message: highDemand, codex_error_info: 'internal_server_error' };
  const data = parseHistory([event('task_started', 'failed'), message('process', 'failed'),
    event('task_complete', 'failed', { error, duration_ms: 280959 })].join('\n'));
  assert.equal(data.turnTiming.status, 'failed'); assert.equal(data.turnTiming.turnId, 'failed');
  assert.deepEqual(data.turnFailures, [{ turnId: 'failed', status: 'failed', message: highDemand,
    code: 'internal_server_error', timestamp: Date.parse('2026-11-11T10:59:05.869Z') }]);
  assert.equal(data.messages.length, 1); assert.equal(data.messages[0].text, 'Original process text');
  assert.equal(data.messages[0].id, 'process');
});

test('a distinct new turn retains historical failure while its timing is running or completed', () => {
  const prefix = [event('task_started', 'previous'), event('task_complete', 'previous', { error: { message: highDemand } })];
  for (const completed of [false, true]) {
    const data = parseHistory([...prefix, event('task_started', 'current', {}, '2026-11-11T11:00:00Z'),
      ...(completed ? [event('task_complete', 'current', { error: null }, '2026-11-11T11:01:00Z')] : [])].join('\n'));
    assert.equal(data.turnTiming.turnId, 'current'); assert.equal(data.turnTiming.status, completed ? 'completed' : 'inProgress');
    assert.equal(data.turnFailures[0].turnId, 'previous');
  }
});

test('the same restarted turn and explicit interruption cannot keep an old failure diagnosis', () => {
  for (const terminal of ['task_started', 'turn_aborted']) {
    const data = parseHistory([event('task_started', 'same'), event('task_complete', 'same', { error: { message: highDemand } }),
      event(terminal, 'same', {}, '2026-11-11T11:00:00Z')].join('\n'));
    assert.deepEqual(data.turnFailures, []); assert.equal(data.turnTiming.status, terminal === 'task_started' ? 'inProgress' : 'interrupted');
  }
});

test('ordinary failed tool output and prose do not produce a failed run', () => {
  const tool = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'Error: command exited 1' } });
  const data = parseHistory([event('task_started', 'good'), tool, event('task_complete', 'good', { error: null })].join('\n'));
  assert.deepEqual(data.turnFailures, []); assert.equal(data.turnTiming.status, 'completed');
});

test('failure projection is allowlisted and bounded, rejecting another terminal status', () => {
  const input = { message: 'x'.repeat(2200), additionalDetails: 'y'.repeat(4200), code: 'internal_server_error',
    permission: { canSend: true }, apiKey: 'not-a-real-secret', nested: { message: 'not displayed' } };
  const value = turnFailureFromError('turn', input, 20);
  assert.equal(value.message.length, 2000); assert.equal(value.additionalDetails.length, 4000);
  assert.deepEqual(Object.keys(value).sort(), ['additionalDetails', 'code', 'message', 'status', 'timestamp', 'turnId']);
  assert.deepEqual(normalizeTurnFailures([{ ...value, status: 'completed' }]), []);
  assert.equal(normalizeTurnFailures(Array.from({ length: 60 }, (_, i) => ({ ...value, turnId: 't' + i }))).length, 30);
  assert.equal(turnFailureFromError('turn', { message: '\u0000Original\nline', code: '../arbitrary/path' }).message, 'Original\nline');
  assert.equal(turnFailureFromError('turn', { message: 'reason', code: '../arbitrary/path' }).code, undefined);
});

test('the existing fast saved transcript forwards diagnostics while omitting all control authority', t => {
  const folder = mkdtempSync(join(tmpdir(), 'pocket-failure-')), id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  const store = new NavigatorStore(folder);
  const source = { threads: [{ id, title: 'Synthetic failed chat', cwd: folder }], projects: [], sourceInfo: {} };
  store.sync(source);
  const saved = parseHistory([event('task_started', 'failed'), message('source', 'failed'), event('task_complete', 'failed', { error: { message: highDemand } })].join('\n'));
  const desktop = new DesktopService(store, folder, async () => { throw new Error('Fast saved read must not request an owner'); },
    () => ({ ...saved, canSend: true, pendingRequests: [{ key: 'must-not-leak' }] }));
  t.after(() => { desktop.stopQueue(); desktop.models.stop(); store.close(); rmSync(folder, { recursive: true, force: true }); });
  const result = desktop.transcript(id);
  assert.deepEqual(result.turnFailures, saved.turnFailures);
  assert.equal(result.canSend, undefined); assert.equal(result.pendingRequests, undefined); assert.equal(result.source, 'rollout');
});

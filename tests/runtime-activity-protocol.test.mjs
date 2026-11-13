import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readBridgeConfig } from '../server/bridge-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile), python = readBridgeConfig().python;
const prefix = `import importlib.util,json,sys\nsys.path.insert(0,${JSON.stringify(root + 'bin')})\n` +
  `spec=importlib.util.spec_from_file_location('bridge',${JSON.stringify(root + 'bin/desktop-bridge.py')})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n` +
  `m.time.time=lambda:10.0\ndata=json.loads(sys.argv[1])\n`;
const run = async (state, program = 'print(json.dumps(m.history(data)))') => JSON.parse((await exec(python,
  ['-B', '-c', prefix + program, JSON.stringify(state)], { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout);
const current = (extra = {}) => ({ turnId: 'current-turn', status: 'inProgress', turnStartedAtMs: 1000,
  items: [{ type: 'agentMessage', id: 'visible', phase: 'commentary', text: 'Visible progress', startedAtMs: 4000, completedAtMs: 4500 },
    { type: 'reasoning', id: 'neutral-event', startedAtMs: 8000, completedAtMs: 8200, content: ['PRIVATE_REASONING'] },
    { type: 'mcpToolCall', id: 'active-tool', status: 'inProgress', startedAtMs: 9000, completedAtMs: null,
      arguments: { credential: 'PRIVATE_ARGUMENTS' }, result: { private: 'PRIVATE_RESULT' } }], ...extra });
const state = (turns = [current()], extra = {}) => ({ id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', hostId: 'local',
  resumeState: 'resumed', threadRuntimeStatus: { type: 'active', activeFlags: [] }, requests: [],
  latestModel: 'fixture', latestReasoningEffort: 'ultra', turns, ...extra });

test('real native tool events remain visible as bounded activity while no new message is produced', async () => {
  const result = await run(state());
  assert.deepEqual(result.runtimeActivity, { turnId: 'current-turn', lastEventAt: 9000, lastMessageAt: 4500,
    activeOperation: { kind: 'tool', startedAt: 9000 } });
  assert.equal(result.runtime, 'active'); assert.equal(result.latestTurnStatus, 'inProgress'); assert.equal(result.canSend, true);
  assert.deepEqual(result.messages.map(message => message.text), ['Visible progress']);
  assert.equal(JSON.stringify(result.runtimeActivity).includes('PRIVATE'), false);
});

test('activity belongs to the exact latest canonical turn, not an older run or provisional items', async () => {
  const old = { turnId: 'old-turn', status: 'inProgress', turnStartedAtMs: 500, items: [
    { type: 'commandExecution', id: 'old-command', status: 'inProgress', startedAtMs: 9999 } ] };
  const latest = current({ items: [] });
  const canonical = { kind: 'canonical', history: { entitiesByKey: { old, latest },
    islands: [{ entries: [{ value: 'old' }, { value: 'latest' }], newerBoundary: { status: 'exhausted' } }] } };
  const result = await run(state([old], { turnHistory: canonical }));
  assert.deepEqual(result.runtimeActivity, { turnId: 'current-turn', lastEventAt: 1000, lastMessageAt: null, activeOperation: null });
});

test('a returned tool or a terminal turn never becomes a claim that business work is still executing', async () => {
  const items = [
    { type: 'commandExecution', id: 'returned', status: 'completed', startedAtMs: 5000, completedAtMs: 5100, exitCode: 1 },
    { type: 'mcpToolCall', id: 'closed', status: 'inProgress', startedAtMs: 6000, completedAtMs: 6200 },
    { type: 'fileChange', id: 'recorded-closed', status: 'inProgress', startedAtMs: 7000, completedAtMs: null },
  ];
  const result = await run(state([current({ items, completedItemIds: ['recorded-closed'] })]));
  assert.deepEqual(result.runtimeActivity, { turnId: 'current-turn', lastEventAt: 7000, lastMessageAt: null, activeOperation: null });
  for (const status of ['completed', 'failed', 'interrupted']) {
    const ended = await run(state([current({ status })], { threadRuntimeStatus: { type: 'idle', activeFlags: [] } }));
    assert.equal(ended.runtimeActivity.activeOperation, null); assert.equal(ended.latestTurnStatus, status);
  }
});

test('unknown items, unsafe timestamps and navigation recency cannot invent activity', async () => {
  const items = [
    { type: 'futureOperation', id: 'unknown', startedAtMs: 9999, completedAtMs: 9999 },
    { type: 'commandExecution', id: 'invalid-string', status: 'inProgress', startedAtMs: '9000' },
    { type: 'commandExecution', id: 'invalid-boolean', status: 'inProgress', startedAtMs: true },
    { type: 'commandExecution', id: 'future', status: 'inProgress', startedAtMs: 11000 },
    { type: 'commandExecution', id: 'before-turn', status: 'inProgress', startedAtMs: 500 },
    { type: 'userMessage', id: 'steering', startedAtMs: 9500, content: [{ type: 'text', text: 'Follow-up' }] },
  ];
  const result = await run(state([current({ items })], { updatedAt: 9999, recencyAt: 9999 }));
  assert.deepEqual(result.runtimeActivity, { turnId: 'current-turn', lastEventAt: 1000, lastMessageAt: null, activeOperation: null });
});

test('matched native timestamp maps are real activity; analysis and foreign IDs do not become visible messages', async () => {
  const turn = current({ items: [
    { type: 'agentMessage', id: 'visible', phase: 'commentary', text: 'Visible progress' },
    { type: 'agentMessage', id: 'hidden', phase: 'analysis', text: 'PRIVATE_ANALYSIS', startedAtMs: 7000 },
    { type: 'commandExecution', id: 'active-command', status: 'inProgress' },
  ], aeonAssistantMessageStartedAtMsById: { visible: 3000, 'foreign-id': 9999 },
  agentMessageCompletedAtMsById: { visible: 3500, 'foreign-id': 9999 },
  commandExecutionStartedAtMsById: { 'active-command': 8000, 'foreign-id': 9999 } });
  const result = await run(state([turn]));
  assert.deepEqual(result.runtimeActivity, { turnId: 'current-turn', lastEventAt: 8000, lastMessageAt: 3500,
    activeOperation: { kind: 'command', startedAt: 8000 } });
  assert.deepEqual(result.messages.map(message => message.text), ['Visible progress']);
});

test('operation kinds are allowlisted and polling alone never changes activity metadata', async () => {
  const items = [
    { type: 'commandExecution', id: 'command', status: 'inProgress', startedAtMs: 2000 },
    { type: 'fileChange', id: 'file', status: 'inProgress', startedAtMs: 3000 },
    { type: 'collabAgentToolCall', id: 'child', status: 'inProgress', startedAtMs: 4000 },
  ];
  const result = await run(state([current({ items })]));
  assert.equal(result.runtimeActivity.activeOperation.kind, 'delegation');
  const later = await run(state([current({ items })]), 'm.time.time=lambda:100.0\nprint(json.dumps(m.history(data)))');
  assert.deepEqual(later.runtimeActivity, result.runtimeActivity);
  assert.notEqual(later.turnTiming.observedAt, result.turnTiming.observedAt);
});

test('malformed optional metadata cannot break otherwise readable history', async () => {
  const items = [null, [], { type: ['mcpToolCall'], startedAtMs: 9999 }, { type: { private: 'commandExecution' }, startedAtMs: 9999 }];
  // Exercise only the optional projection: a corrupt native item may also be
  // rejected by the independent message contracts before the projector runs.
  const result = await run(current({ items, completedItemIds: [[], {}, false] }),
    'from runtime_activity import runtime_activity\nprint(json.dumps(runtime_activity(data,10000)))');
  assert.deepEqual(result, { turnId: 'current-turn', lastEventAt: 1000, lastMessageAt: null, activeOperation: null });
});

test('an oversized optional item timestamp cannot break visible native history', async () => {
  const result = await run(state(), 'data["turns"][0]["items"][-1]["startedAtMs"]=10**1000\nprint(json.dumps(m.history(data)))');
  assert.ok(result.messages.some(message => message.text === 'Visible progress'));
  assert.equal(result.runtimeActivity.lastEventAt, 8200);
  assert.equal(result.runtimeActivity.activeOperation, null);
  assert.equal(result.runtime, 'active');
});

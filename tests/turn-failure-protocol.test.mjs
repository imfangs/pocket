import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readBridgeConfig } from '../server/bridge-config.mjs';
import { TaskStatusService } from '../server/task-statuses.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = readBridgeConfig().python;
const exec = promisify(execFile);
const prefix = `import importlib.util,json,sys\nsys.path.insert(0,${JSON.stringify(root + 'bin')})\n` +
  `spec=importlib.util.spec_from_file_location('status',${JSON.stringify(root + 'bin/task-statuses.py')})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n` +
  `import turn_failure as f\ndata=json.loads(sys.argv[1])\n`;
const run = async (program, input) => JSON.parse((await exec(python, ['-B', '-c', prefix + program, JSON.stringify(input)], { cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 })).stdout);
const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const turn = (turnId = 'failed-turn', extra = {}) => ({ turnId, status: 'failed', turnStartedAtMs: 1000, durationMs: 50,
  error: { message: 'We’re currently experiencing high demand, which may cause temporary errors.', additionalDetails: null }, ...extra });
const state = (runtime = 'idle', turns = [turn()], extra = {}) => ({ id, hostId: 'local', resumeState: 'resumed',
  threadRuntimeStatus: { type: runtime, activeFlags: [] }, turns, requests: [], latestModel: 'fixture', latestReasoningEffort: 'ultra', ...extra });
const row = (type, fields = {}) => JSON.stringify({ type: type === 'turn_context' ? type : 'event_msg', payload: { type, ...fields } });

test('native history retains an earlier failed turn and its real reason while a new turn runs', async () => {
  const native = state('active', [turn(), { turnId: 'retry-turn', status: 'inProgress', turnStartedAtMs: 2000, items: [] }]);
  const result = await run(`print(json.dumps(m._bridge.history(data)))`, native);
  assert.equal(result.latestTurnStatus, 'inProgress'); assert.equal(result.latestTurnId, 'retry-turn');
  assert.deepEqual(result.turnFailures, [{ turnId: 'failed-turn', message: turn().error.message, additionalDetails: null, timestamp: 1050 }]);
  assert.equal(result.activeTurnId, 'retry-turn');
});

test('failed status comes only from known failed latest turns; current running/waiting wins', async () => {
  const values = [state(), state('systemError'), state('systemError', [turn('old', { status: 'completed' })]),
    state('active', [turn()]), state('active', [turn(), { turnId: 'retry', status: 'inProgress', items: [] }]),
    state('active', [turn()], { threadRuntimeStatus: { type: 'active', activeFlags: ['waitingOnApproval'] } }),
    state('idle', [{ turnId: 'retry', status: 'completed', error: { message: 'tool stderr is not a failed turn' } }])];
  const result = await run(`print(json.dumps([m.native_observation(s) for s in data]))`, values);
  assert.deepEqual(result.map(value => value.status), ['failed', 'failed', 'unknown', 'failed', 'running', 'waiting_approval', 'idle']);
  assert.ok(result.every(value => value.statusSource === 'desktop'));
  assert.equal(result[0].latestTurnId, 'failed-turn');
});

test('a stale earlier in-progress turn cannot hide a failed latest turn, but a provisional current retry can', async () => {
  const canonical = { kind: 'canonical', history: { entitiesByKey: { failed: turn() },
    islands: [{ entries: [{ value: 'failed' }], newerBoundary: { status: 'exhausted' } }] } };
  const values = [state('active', [{ turnId: 'older', status: 'inProgress' }, turn()]),
    state('active', [{ turnId: 'retry', status: 'inProgress' }], { turnHistory: canonical }),
    state('active', [{ turnId: 'older', status: 'inProgress' }, turn('current', { status: 'completed' })], { turnHistory: canonical })];
  assert.deepEqual(await run(`print(json.dumps([m.native_status(s) for s in data]))`, values), ['failed', 'running', 'failed']);
});

test('native failure DTO is bounded, allowlisted and never copies tools/settings/raw error structures', async () => {
  const input = [turn('one', { error: { message: 'x'.repeat(3000) + '\u0000', additionalDetails: 'y'.repeat(5000), codexErrorInfo: 'internal_server_error',
    model: 'PRIVATE_SETTINGS', token: 'PRIVATE_TOKEN', details: { arbitrary: 'DO_NOT_COPY' } } }),
    turn('two', { error: { message: 42, code: { private: 'DO_NOT_COPY' }, additionalDetails: { private: 'DO_NOT_COPY' } } }),
    turn('completed', { status: 'completed' }), turn('stopped', { status: 'interrupted' }), null];
  const result = await run(`print(json.dumps(f.turn_failures(data)))`, input);
  assert.equal(result.length, 2); assert.equal(result[0].message.length, 2000); assert.equal(result[0].additionalDetails.length, 4000);
  assert.equal(result[0].code, 'internal_server_error'); assert.equal(result[1].message, undefined); assert.equal(result[1].code, undefined);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false); assert.equal(JSON.stringify(result).includes('DO_NOT_COPY'), false);
});

test('failure history admits at most thirty known records in source order, with exact identities', async () => {
  const input = Array.from({ length: 50 }, (_, index) => turn('turn-' + index));
  const result = await run(`print(json.dumps(f.turn_failures(data)))`, input);
  assert.equal(result.length, 30); assert.equal(result[0].turnId, 'turn-20'); assert.equal(result.at(-1).turnId, 'turn-49');
});

test('recorded task_complete error is failed, and later retry/new input supersedes only the current state', async () => {
  const failed = [row('turn_context', { turn_id: 'original' }), row('task_started', { turn_id: 'original' }),
    row('task_complete', { turn_id: 'original', error: { message: 'High demand', codex_error_info: 'internal_server_error' } })];
  const values = [failed.join('\n'), [...failed, row('task_started', { turn_id: 'retry' })].join('\n'),
    [...failed, row('user_message'), row('task_complete', { turn_id: 'original' })].join('\n'),
    [row('task_started', { turn_id: 'normal' }), row('task_complete', { turn_id: 'normal' })].join('\n'),
    [row('task_started', { turn_id: 'running' }), JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'Error: tool exit1' } })].join('\n')];
  const result = await run(`print(json.dumps([m.recorded_observation(s) for s in data]))`, values);
  assert.deepEqual(result.map(value => value.state), ['failed', 'unconfirmed', 'unknown', 'ended', 'unconfirmed']);
  assert.equal(result[0].latestTurnId, 'original'); assert.equal(result[1].latestTurnId, 'retry');
});

test('public status responses preserve only fresh known failed identity/provenance, not leaked reasons', async () => {
  const now = 2000;
  const service = new TaskStatusService({ codexHome: '/fixture', threads: () => [{ id, archived: false }], now: () => now,
    read: async () => ({ available: true, checkedAt: now, states: [{ threadId: id, status: 'failed', checkedAt: now,
      latestTurnId: 'failed-turn', statusSource: 'rollout', error: { private: 'DO_NOT_LEAK' } }] }) });
  const result = await service.snapshot();
  assert.deepEqual(result.states, [{ threadId: id, status: 'failed', checkedAt: now, latestTurnId: 'failed-turn', statusSource: 'rollout' }]);
  service.stop();
  const missing = new TaskStatusService({ codexHome: '/fixture', threads: () => [{ id, archived: false }], now: () => now,
    read: async () => ({ available: true, checkedAt: now, states: [{ threadId: id, status: 'failed', checkedAt: now }] }) });
  assert.equal((await missing.snapshot()).states[0].status, 'unknown'); missing.stop();
});

test('failed recorded evidence survives an unavailable refinement and never copies private error bodies into the batch', async () => {
  const result = await run(`
import tempfile,pathlib
with tempfile.TemporaryDirectory() as folder:
 home=pathlib.Path(folder);(home/'sessions').mkdir()
 path=home/'sessions'/'fixture.jsonl'
 path.write_text('\\n'.join([json.dumps({'type':'session_meta','payload':{'id':data['id']}}),
  json.dumps({'type':'event_msg','payload':{'type':'task_started','turn_id':'failed-turn'}}),
  json.dumps({'type':'event_msg','payload':{'type':'task_complete','turn_id':'failed-turn','error':{'message':'PRIVATE_REASON'}}})]))
 class Reader:
  def __init__(self,*_):pass
  def __enter__(self):return self
  def __exit__(self,*_):pass
  def status(self,*_):return {'status':'unknown','statusSource':'desktop'}
 result=m.execute({'codexHome':folder,'threadIds':[data['id']]},verify=lambda:{},
  discover=lambda *_:{'available':True,'candidates':[{'threadId':data['id'],'path':str(path)}]},client_factory=Reader)
 print(json.dumps(result))
`, { id });
  assert.equal(result.states[0].status, 'failed'); assert.equal(result.states[0].latestTurnId, 'failed-turn');
  assert.equal(result.states[0].statusSource, 'rollout'); assert.equal(result.checkedCandidates, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_REASON'), false);
});

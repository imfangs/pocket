import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledCli } from './helpers/bundled-cli.mjs';

const config = JSON.parse(readFileSync(new URL('../config/desktop-bridge.json', import.meta.url), 'utf8'));
const script = fileURLToPath(new URL('../bin/create-thread.py', import.meta.url));
const exec = promisify(execFile);

function fixture(t, { model = 'gpt-6-astra', effort = 'ultra' } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-create-protocol-')));
  const home = join(base, 'home'), cwd = join(base, 'workspace'), receiptPath = join(base, 'receipts', 'create.json');
  mkdirSync(home); mkdirSync(cwd);
  // No real auth, models, user history, or desktop socket. No turn is started.
  const setDefaults = (nextModel, nextEffort) => writeFileSync(join(home, 'config.toml'),
    `model=${JSON.stringify(nextModel)}\n${nextEffort === null ? '' : `model_reasoning_effort=${JSON.stringify(nextEffort)}\n`}`
    + 'model_provider="probe"\napproval_policy="never"\nsandbox_mode="read-only"\n[model_providers.probe]\nname="No-model fixture"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n');
  setDefaults(model, effort);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const input = { requestId: randomUUID(), codexHome: home, cwd, receiptPath };
  return { base, home, cwd, input, setDefaults };
}

function run(input, { loseSettingsReply = false, failSettingsBeforeApply = false } = {}) {
  return new Promise((resolve, reject) => {
    // Fault injection wraps the official RPC. It never edits Codex storage or
    // substitutes a fake persistence result for the actual App Server response.
    const faultWrapper = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('create_thread',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\noriginal=module.StdioServer.call\ndef call(self,method,params):\n if method=='thread/settings/update' and ${failSettingsBeforeApply ? 'True' : 'False'}: raise module.CreateError('rpc_timeout')\n result=original(self,method,params)\n if method=='thread/settings/update': raise module.CreateError('rpc_timeout')\n return result\nmodule.StdioServer.call=call\nprint(json.dumps(module.main()))`;
    const args = loseSettingsReply || failSettingsBeforeApply ? ['-c', faultWrapper, script] : [script];
    const child = spawn(config.python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      try { assert.equal(code, 0, stderr); resolve({ ...JSON.parse(stdout), stderr }); }
      catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function rows(home) {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT * FROM threads').all(); }
  finally { db.close(); }
}

function storedRecords(row) {
  return readFileSync(row.rollout_path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

function assertEmptyWithSettings(row, expected) {
  assert.equal(row.model, expected.model); assert.equal(row.reasoning_effort, expected.effort);
  assert.equal(row.model_provider, 'probe');
  assert.equal(row.has_user_event, 0); assert.equal(row.tokens_used, 0);
  const records = storedRecords(row);
  assert.deepEqual(records.map(record => record.type), ['session_meta', 'event_msg']);
  assert.equal(records[0].payload.id, row.id);
  assert.equal(records[0].payload.model_provider, 'probe');
  const applied = records[1].payload;
  assert.equal(applied.type, 'thread_settings_applied'); assert.equal(applied.thread_id, row.id);
  assert.equal(applied.thread_settings.model, expected.model);
  assert.equal(applied.thread_settings.model_provider_id, 'probe');
  assert.equal(applied.thread_settings.collaboration_mode.settings.reasoning_effort, expected.effort);
  assert.equal(applied.thread_settings.cwd, row.cwd);
  assert.equal(applied.thread_settings.approval_policy, 'never');
  assert.equal(applied.thread_settings.permission_profile.network, 'restricted');
}

async function resumeReadback({ home, cwd }, threadId) {
  // A fresh official process must retain the saved settings after the fixture's
  // global defaults change. No turn/start, turn/steer, tools, or model work.
  const source = `import importlib.util,json,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('create_thread',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\nmodule.ALLOWED_METHODS.update({'thread/resume','thread/turns/list'})\nserver=module.StdioServer(module.binary_for(Path(sys.argv[2])),Path(sys.argv[2]),Path(sys.argv[3]))\nwith server:\n resumed=server.call('thread/resume',{'threadId':sys.argv[4],'excludeTurns':True})\n turns=server.call('thread/turns/list',{'threadId':sys.argv[4],'limit':10})\nprint(json.dumps({'model':resumed['model'],'effort':resumed['reasoningEffort'],'collaborationMode':resumed.get('collaborationMode'),'turns':turns['data'],'processStopped':server.stopped}))`;
  const result = await exec(config.python, ['-c', source, script, home, cwd, threadId], { timeout: 20000 });
  return JSON.parse(result.stdout);
}

test('an unnamed empty thread persists Ultra without model work and a retry keeps its original defaults', async t => {
  const state = fixture(t), { home, cwd, input, setDefaults } = state;
  const result = await run(input);
  assert.equal(result.status, 'created', JSON.stringify(result));
  assert.equal(result.verified, true); assert.equal(result.processStopped, true);
  assert.equal(result.name, null); assert.equal(result.turnCount, 0); assert.equal(result.cwd, cwd);
  const [row] = rows(home);
  assert.equal(row.id, result.threadId); assert.equal(row.name, null);
  assertEmptyWithSettings(row, { model: 'gpt-6-astra', effort: 'ultra' });
  const receipt = JSON.parse(readFileSync(input.receiptPath, 'utf8'));
  assert.deepEqual(receipt.expectedSettings, { model: 'gpt-6-astra', effort: 'ultra' });
  assert.deepEqual(receipt.rpcMethods, ['initialize', 'thread/start', 'thread/read', 'thread/settings/update', 'initialize', 'thread/read']);
  assert.throws(() => process.kill(receipt.creatorPid, 0), { code: 'ESRCH' });
  const beforeRetry = readFileSync(row.rollout_path, 'utf8');
  setDefaults('gpt-5', 'high');
  const duplicate = await run(input, { failSettingsBeforeApply: true });
  assert.equal(duplicate.status, 'created'); assert.equal(duplicate.threadId, result.threadId);
  assert.equal(rows(home).length, 1);
  assert.doesNotMatch(duplicate.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
  assert.equal(readFileSync(row.rollout_path, 'utf8'), beforeRetry);
  const resumed = await resumeReadback(state, result.threadId);
  assert.equal(resumed.model, 'gpt-6-astra'); assert.equal(resumed.effort, 'ultra');
  assert.equal(resumed.collaborationMode.settings.reasoning_effort, 'ultra');
  assert.deepEqual(resumed.turns, []); assert.equal(resumed.processStopped, true);
  assert.equal(rows(home)[0].tokens_used, 0); assert.equal(rows(home)[0].has_user_event, 0);
});

test('configured high, none, and absent reasoning effort are preserved without guessing a default', async t => {
  for (const effort of ['high', 'none', null]) {
    await t.test(`effort ${effort ?? 'absent'}`, async t => {
      const state = fixture(t, { effort });
      const result = await run(state.input);
      assert.equal(result.status, 'created', JSON.stringify(result));
      assertEmptyWithSettings(rows(state.home)[0], { model: 'gpt-6-astra', effort });
      assert.deepEqual(JSON.parse(readFileSync(state.input.receiptPath, 'utf8')).expectedSettings,
        { model: 'gpt-6-astra', effort });
      state.setDefaults('gpt-5', 'ultra');
      const resumed = await resumeReadback(state, result.threadId);
      assert.equal(resumed.model, 'gpt-6-astra'); assert.equal(resumed.effort, effort);
      assert.deepEqual(resumed.turns, []); assert.equal(resumed.processStopped, true);
      assert.equal(rows(state.home)[0].tokens_used, 0); assert.equal(rows(state.home)[0].has_user_event, 0);
    });
  }
});

test('an explicitly named empty thread uses the original title setter and persists that exact name', async t => {
  const { home, input } = fixture(t, { effort: 'high' });
  const result = await run({ ...input, name: 'Pocket 独立空会话' });
  assert.equal(result.status, 'created', JSON.stringify(result));
  assert.equal(result.name, 'Pocket 独立空会话');
  assert.equal(rows(home)[0].name, result.name);
  assertEmptyWithSettings(rows(home)[0], { model: 'gpt-6-astra', effort: 'high' });
  assert.ok(JSON.parse(readFileSync(input.receiptPath, 'utf8')).rpcMethods.includes('thread/name/set'));
});

test('an empty thread preserves the explicitly selected original project and cwd', async t => {
  const { home, cwd, input } = fixture(t);
  // Initialize the official empty schema before the existing FBT metadata CLI
  // performs its deliberate one-database preflight.
  await exec(config.python, ['-c', `import importlib.util,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('create_thread',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)\nwith module.StdioServer(module.binary_for(Path(sys.argv[2])),Path(sys.argv[2]),Path(sys.argv[3])): pass`, script, home, cwd], { timeout: 15000 });
  const metadata = '/Users/fangs/workspace/fbt/experimental/codex-threads/scripts/metadata_cli.py';
  const created = await exec(config.python, [metadata, 'project-create', '--codex-home', home,
    '--codex-bin', bundledCli, '--name', 'Fixture project',
    '--project-root', cwd, '--idempotency-key', randomUUID(), '--json'], { timeout: 20000 });
  const project = JSON.parse(created.stdout);
  assert.equal(project.ok, true);
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  let projectId;
  try { projectId = db.prepare('SELECT id FROM projects').get().id; }
  finally { db.close(); }
  const result = await run({ ...input, projectId });
  assert.equal(result.status, 'created', JSON.stringify(result));
  assert.equal(result.projectId, projectId); assert.equal(result.cwd, cwd);
  assert.equal(rows(home)[0].project_id, projectId);
  assertEmptyWithSettings(rows(home)[0], { model: 'gpt-6-astra', effort: 'ultra' });
});

test('a recorded unknown without a thread ID is never retried as another creation', async t => {
  const { home, input } = fixture(t);
  const result = await run(input);
  assert.equal(result.status, 'created');
  const receipt = JSON.parse(readFileSync(input.receiptPath, 'utf8'));
  delete receipt.threadId;
  Object.assign(receipt, { status: 'unknown', verified: false, phase: 'starting' });
  writeFileSync(input.receiptPath, JSON.stringify(receipt));
  const unknown = await run(input);
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.threadId, undefined);
  assert.equal(rows(home).length, 1);
  assert.doesNotMatch(unknown.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
});

test('a recorded known-ID unknown is resolved by independent readback without creating again', async t => {
  const { home, input } = fixture(t);
  const first = await run(input);
  const receipt = JSON.parse(readFileSync(input.receiptPath, 'utf8'));
  Object.assign(receipt, { status: 'unknown', verified: false, phase: 'materialized' });
  writeFileSync(input.receiptPath, JSON.stringify(receipt));
  const result = await run(input);
  assert.equal(result.status, 'created'); assert.equal(result.threadId, first.threadId);
  assert.equal(rows(home).length, 1);
  assert.doesNotMatch(result.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
});

test('a lost settings reply is reconciled from the original saved settings without replaying the write', async t => {
  const { home, input, setDefaults } = fixture(t);
  const unknown = await run(input, { loseSettingsReply: true });
  assert.equal(unknown.status, 'unknown', JSON.stringify(unknown));
  assert.equal(unknown.verified, false);
  const receipt = JSON.parse(readFileSync(input.receiptPath, 'utf8'));
  assert.deepEqual(receipt.expectedSettings, { model: 'gpt-6-astra', effort: 'ultra' });
  const [row] = rows(home);
  assert.equal(row.id, unknown.threadId);
  assertEmptyWithSettings(row, receipt.expectedSettings);
  const beforeReadback = readFileSync(row.rollout_path, 'utf8');
  setDefaults('gpt-5', 'high');
  const recovered = await run(input, { failSettingsBeforeApply: true });
  assert.equal(recovered.status, 'created', JSON.stringify(recovered));
  assert.equal(recovered.threadId, unknown.threadId); assert.equal(recovered.verified, true);
  assert.equal(rows(home).length, 1);
  assert.equal(readFileSync(row.rollout_path, 'utf8'), beforeReadback);
  assert.doesNotMatch(recovered.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
});

test('a settings request that never applied remains unknown and is not replaced on retry', async t => {
  const { home, input, setDefaults } = fixture(t);
  const unknown = await run(input, { failSettingsBeforeApply: true });
  assert.equal(unknown.status, 'unknown', JSON.stringify(unknown));
  assert.equal(unknown.verified, false);
  const receipt = JSON.parse(readFileSync(input.receiptPath, 'utf8'));
  assert.ok(receipt.threadId); assert.deepEqual(receipt.expectedSettings, { model: 'gpt-6-astra', effort: 'ultra' });
  setDefaults('gpt-5', 'high');
  const checked = await run(input);
  assert.equal(checked.status, 'unknown', JSON.stringify(checked));
  assert.equal(checked.verified, false); assert.equal(checked.threadId, unknown.threadId);
  assert.match(checked.code, /settings/);
  assert.equal(rows(home).length, 1);
  const [row] = rows(home);
  assert.equal(row.model, null); assert.equal(row.reasoning_effort, null);
  assert.deepEqual(storedRecords(row).map(record => record.type), ['session_meta']);
  assert.equal(row.tokens_used, 0); assert.equal(row.has_user_event, 0);
  assert.doesNotMatch(checked.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
});

test('a saved model or effort mismatch cannot be marked as created by a later readback', async t => {
  const { home, input } = fixture(t);
  const first = await run(input);
  assert.equal(first.status, 'created', JSON.stringify(first));
  const original = JSON.parse(readFileSync(input.receiptPath, 'utf8'));
  const [row] = rows(home), beforeReadback = readFileSync(row.rollout_path, 'utf8');
  for (const expectedSettings of [
    { model: 'gpt-5', effort: 'ultra' },
    { model: 'gpt-6-astra', effort: 'high' },
    { model: 'gpt-6-astra', effort: null },
  ]) {
    // Only the fixture's private expectation changes. Original Codex rows and
    // rollout are read-only, including during these negative cases.
    writeFileSync(input.receiptPath, JSON.stringify({ ...original, expectedSettings,
      status: 'unknown', verified: false, phase: 'materialized' }));
    const checked = await run(input);
    assert.equal(checked.status, 'unknown', JSON.stringify(checked));
    assert.equal(checked.verified, false);
    assert.ok(['created_model_settings_mismatch', 'created_thread_not_empty'].includes(checked.code), checked.code);
    assert.equal(checked.threadId, first.threadId); assert.equal(rows(home).length, 1);
    assert.equal(readFileSync(row.rollout_path, 'utf8'), beforeReadback);
    assert.doesNotMatch(checked.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
  }
});

test('a new receipt interrupted before its expected settings checkpoint stays unknown', async t => {
  const { home, input } = fixture(t);
  const first = await run(input);
  assert.equal(first.status, 'created', JSON.stringify(first));
  const receipt = JSON.parse(readFileSync(input.receiptPath, 'utf8'));
  assert.equal(receipt.schemaVersion, 2);
  delete receipt.expectedSettings;
  Object.assign(receipt, { status: 'unknown', verified: false, phase: 'created_in_process' });
  writeFileSync(input.receiptPath, JSON.stringify(receipt));
  const [row] = rows(home), beforeReadback = readFileSync(row.rollout_path, 'utf8');
  const checked = await run(input);
  assert.equal(checked.status, 'unknown', JSON.stringify(checked));
  assert.equal(checked.verified, false); assert.match(checked.code, /settings/);
  assert.equal(checked.threadId, first.threadId); assert.equal(rows(home).length, 1);
  assert.equal(readFileSync(row.rollout_path, 'utf8'), beforeReadback);
  assert.doesNotMatch(checked.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
});

test('receipt identity conflicts and paths inside original Codex storage are rejected without another thread', async t => {
  const { home, input } = fixture(t);
  const first = await run(input);
  assert.equal(first.status, 'created');
  const conflict = await run({ ...input, name: 'Different request intent' });
  assert.equal(conflict.status, 'rejected'); assert.equal(conflict.code, 'create_request_conflict');
  const invalid = await run({ ...input, receiptPath: join(home, 'unsafe-receipt.json') });
  assert.equal(invalid.status, 'rejected'); assert.equal(invalid.code, 'receipt_path_in_codex_home');
  assert.equal(rows(home).length, 1);
});

test('concurrent identical submissions share the private receipt lock and create at most one thread', async t => {
  const { home, input } = fixture(t);
  const results = await Promise.all([run(input), run(input)]);
  assert.ok(results.some(result => result.status === 'created'), JSON.stringify(results));
  assert.ok(results.every(result => result.status === 'created' || result.code === 'create_in_progress'));
  assert.equal(rows(home).length, 1);
  const recovered = await run(input);
  assert.equal(recovered.status, 'created'); assert.equal(recovered.threadId, rows(home)[0].id);
});

test('creation never accepts model, permission, or raw-history overrides', async t => {
  const { input } = fixture(t);
  for (const extra of [{ model: 'override' }, { effort: 'ultra' }, { reasoningEffort: 'ultra' },
    { config: { model_reasoning_effort: 'ultra' } }, { approvalPolicy: 'never' }, { permissions: 'danger-full-access' }, { history: [] }]) {
    const result = await run({ ...input, ...extra });
    assert.equal(result.status, 'rejected'); assert.equal(result.code, 'invalid_create_request');
    assert.doesNotMatch(result.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
  }
});

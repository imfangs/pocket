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

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-create-protocol-')));
  const home = join(base, 'home'), cwd = join(base, 'workspace'), receiptPath = join(base, 'receipts', 'create.json');
  mkdirSync(home); mkdirSync(cwd);
  // No real auth, models, user history, or desktop socket. No turn is started.
  writeFileSync(join(home, 'config.toml'), 'model="gpt-5"\nmodel_provider="probe"\napproval_policy="never"\nsandbox_mode="read-only"\n[model_providers.probe]\nname="No-model fixture"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const input = { requestId: randomUUID(), codexHome: home, cwd, receiptPath };
  return { base, home, cwd, input };
}

function run(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
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

test('an unnamed empty thread persists without model work and an identical retry never creates another thread', async t => {
  const { home, cwd, input } = fixture(t);
  const result = await run(input);
  assert.equal(result.status, 'created', JSON.stringify(result));
  assert.equal(result.verified, true); assert.equal(result.processStopped, true);
  assert.equal(result.name, null); assert.equal(result.turnCount, 0); assert.equal(result.cwd, cwd);
  const [row] = rows(home);
  assert.equal(row.id, result.threadId); assert.equal(row.name, null);
  assert.equal(row.has_user_event, 0); assert.equal(row.tokens_used, 0);
  const records = readFileSync(row.rollout_path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.type), ['session_meta']);
  assert.equal(records[0].payload.id, result.threadId);
  const receipt = JSON.parse(readFileSync(input.receiptPath, 'utf8'));
  assert.deepEqual(receipt.rpcMethods, ['initialize', 'thread/start', 'thread/read', 'initialize', 'thread/read']);
  assert.throws(() => process.kill(receipt.creatorPid, 0), { code: 'ESRCH' });
  const duplicate = await run(input);
  assert.equal(duplicate.status, 'created'); assert.equal(duplicate.threadId, result.threadId);
  assert.equal(rows(home).length, 1);
  assert.doesNotMatch(duplicate.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
});

test('an explicitly named empty thread uses the original title setter and persists that exact name', async t => {
  const { home, input } = fixture(t);
  const result = await run({ ...input, name: 'Pocket 独立空会话' });
  assert.equal(result.status, 'created', JSON.stringify(result));
  assert.equal(result.name, 'Pocket 独立空会话');
  assert.equal(rows(home)[0].name, result.name);
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
  for (const extra of [{ model: 'override' }, { approvalPolicy: 'never' }, { history: [] }]) {
    const result = await run({ ...input, ...extra });
    assert.equal(result.status, 'rejected'); assert.equal(result.code, 'invalid_create_request');
    assert.doesNotMatch(result.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readBridgeConfig } from '../server/bridge-config.mjs';

const config = readBridgeConfig();
const createScript = fileURLToPath(new URL('../bin/create-thread.py', import.meta.url));
const archiveScript = fileURLToPath(new URL('../bin/archive-thread.py', import.meta.url));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function command(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { assert.equal(code, 0, stderr); resolve({ result: JSON.parse(stdout), stderr }); }
      catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

async function fixture(t, effort = 'ultra') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-archive-settings-')));
  const home = join(base, 'home'), cwd = join(base, 'workspace');
  mkdirSync(home); mkdirSync(cwd);
  // No real auth, user history, desktop socket, or model endpoint. The official
  // CLI writes only this isolated fixture; no model turn is ever started.
  writeFileSync(join(home, 'config.toml'), 'model="gpt-6-astra"\n'
    + (effort === null ? '' : `model_reasoning_effort=${JSON.stringify(effort)}\n`)
    + 'model_provider="probe"\napproval_policy="never"\nsandbox_mode="read-only"\n'
    + '[model_providers.probe]\nname="No-model fixture"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const created = (await command([createScript], JSON.stringify({ requestId: randomUUID(), codexHome: home, cwd,
    receiptPath: join(base, 'receipts', 'create.json') }))).result;
  assert.equal(created.status, 'created', JSON.stringify(created));
  const id = created.threadId;
  const state = () => {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT * FROM threads WHERE id=?').get(id); }
    finally { db.close(); }
  };
  const run = (operation, expectedFingerprint) => command([archiveScript], JSON.stringify({
    operation, threadId: id, codexHome: home, ...(expectedFingerprint ? { expectedFingerprint } : {}),
  }));
  const snapshot = async () => (await command(['-c',
    `import importlib.util,json,sys\ns=importlib.util.spec_from_file_location('archive_thread',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(json.dumps(m.ArchiveStore(sys.argv[2]).snapshot(sys.argv[3])))`,
    archiveScript, home, id])).result;
  const records = () => readFileSync(state().rollout_path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { home, cwd, id, effort, state, run, snapshot, records };
}

function assertUnchangedModel(state, effort) {
  assert.equal(state.model, 'gpt-6-astra'); assert.equal(state.reasoning_effort, effort);
  assert.equal(state.model_provider, 'probe');
  assert.equal(state.tokens_used, 0); assert.equal(state.has_user_event, 0);
}

async function resume(state, { hold = false, settingsChanges = [] } = {}) {
  const source = `import importlib.util,json,sys\nfrom pathlib import Path\ns=importlib.util.spec_from_file_location('create_thread',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nm.ALLOWED_METHODS.update({'thread/resume','thread/turns/list'})\nwith m.StdioServer(m.binary_for(Path(sys.argv[2])),Path(sys.argv[2]),Path(sys.argv[3])) as server:\n r=server.call('thread/resume',{'threadId':sys.argv[4],'excludeTurns':True})\n for settings in json.loads(sys.argv[5]):server.call('thread/settings/update',{'threadId':sys.argv[4],**settings})\n turns=server.call('thread/turns/list',{'threadId':sys.argv[4],'limit':10})\n print(json.dumps({'model':r['model'],'effort':r['reasoningEffort'],'turns':turns['data']}),flush=True)\n ${hold ? 'sys.stdin.read()' : 'pass'}`;
  const args = ['-u', '-c', source, createScript, state.home, state.cwd, state.id, JSON.stringify(settingsChanges)];
  if (!hold) return (await command(args)).result;
  const child = spawn(config.python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const finished = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`writer startup timeout: ${stderr}`)); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); reject(new Error(`writer exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(text.trim())); } catch (error) { reject(error); }
    });
  });
  let closed = false;
  return { ready, async close() { if (!closed) { closed = true; child.stdin.end(); } await finished; } };
}

test('a newly created settings-only thread archives and restores through the official CLI without changing content', async t => {
  const state = await fixture(t), original = state.state(), beforeSha = sha(original.rollout_path);
  assertUnchangedModel(original, 'ultra');
  assert.deepEqual(state.records().map(record => record.type), ['session_meta', 'event_msg']);
  assert.equal(state.records()[1].payload.type, 'thread_settings_applied');
  assert.equal((await state.snapshot()).lifecycle, 'empty');
  const inspected = await state.run('inspect');
  assert.equal(inspected.result.status, 'ready', JSON.stringify(inspected.result));
  assert.doesNotMatch(inspected.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
  const archived = await state.run('archive', inspected.result.fingerprint);
  assert.equal(archived.result.status, 'archived', JSON.stringify(archived.result));
  assert.equal(archived.result.verified, true); assert.equal(state.state().archived, 1);
  assert.equal(sha(state.state().rollout_path), beforeSha); assertUnchangedModel(state.state(), 'ultra');
  const restored = await state.run('restore');
  assert.equal(restored.result.status, 'restored', JSON.stringify(restored.result));
  assert.equal(restored.result.verified, true); assert.equal(state.state().archived, 0);
  assert.equal(sha(state.state().rollout_path), beforeSha); assertUnchangedModel(state.state(), 'ultra');
});

test('multiple native settings metadata events and absent effort still describe an empty thread', async t => {
  const state = await fixture(t, null), originalCount = state.records().length;
  // A no-op resume need not append settings (0.166 no longer does). Change
  // metadata twice through the official RPC; effort:null cannot clear an
  // existing value, so model changes preserve the absent-effort coverage.
  const changed = await resume(state, { settingsChanges: [{ model: 'gpt-6-sol' }, { model: 'gpt-6-astra' }] });
  assert.deepEqual(changed.turns, []);
  const resumed = await resume(state);
  assert.deepEqual(resumed.turns, []); assert.equal(resumed.model, 'gpt-6-astra'); assert.equal(resumed.effort, null);
  assertUnchangedModel(state.state(), null);
  const records = state.records();
  assert.ok(records.length >= originalCount + 2);
  assert.ok(records.slice(1).every(record => record.type === 'event_msg'
    && record.payload.type === 'thread_settings_applied' && record.payload.thread_id === state.id));
  const applied = records.slice(originalCount).map(record => record.payload.thread_settings);
  assert.ok(applied.some(settings => settings.model === 'gpt-6-sol'));
  assert.equal(applied.at(-1).model, 'gpt-6-astra');
  assert.ok(applied.every(settings => settings.reasoning_effort == null));
  assert.equal((await state.snapshot()).lifecycle, 'empty');
  const before = (await state.run('inspect')).result, beforeSha = sha(state.state().rollout_path);
  assert.equal(before.status, 'ready');
  assert.equal((await state.run('archive', before.fingerprint)).result.status, 'archived');
  assert.equal((await state.run('restore')).result.status, 'restored');
  assert.equal(sha(state.state().rollout_path), beforeSha); assertUnchangedModel(state.state(), null);
});

test('a settings-only thread with a live official writer waits until that writer exits', async t => {
  const state = await fixture(t), writer = await resume(state, { hold: true });
  try {
    assert.deepEqual(writer.ready.turns, []); assert.equal(writer.ready.effort, 'ultra');
    const waiting = await state.run('inspect'), beforeSha = sha(state.state().rollout_path);
    assert.equal(waiting.result.status, 'waiting', JSON.stringify(waiting.result));
    assert.equal(waiting.result.code, 'writer_busy');
    const attempted = await state.run('archive', waiting.result.fingerprint);
    assert.equal(attempted.result.status, 'waiting'); assert.equal(attempted.result.code, 'writer_busy');
    assert.doesNotMatch(attempted.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
    assert.equal(state.state().archived, 0); assert.equal(sha(state.state().rollout_path), beforeSha);
    await writer.close();
    const ready = (await state.run('inspect')).result;
    assert.equal(ready.status, 'ready'); assert.equal(ready.fingerprint, waiting.result.fingerprint);
    assert.equal((await state.run('archive', ready.fingerprint)).result.status, 'archived');
    assert.equal(sha(state.state().rollout_path), beforeSha); assertUnchangedModel(state.state(), 'ultra');
  } finally { await writer.close(); }
});

test('zero token and user-event counters do not make other or invalid history empty', async t => {
  const state = await fixture(t), path = state.state().rollout_path, original = readFileSync(path, 'utf8');
  const metadata = (patch = {}) => ({ type: 'event_msg', payload: { type: 'thread_settings_applied', thread_id: state.id,
    thread_settings: { model: 'gpt-6-astra', cwd: state.cwd }, ...patch } });
  const settings = patch => metadata({ thread_settings: { model: 'gpt-6-astra', cwd: state.cwd, ...patch } });
  const cases = new Map([
    ['turn context', { type: 'turn_context', payload: { turn_id: randomUUID() } }],
    ['started turn', { type: 'event_msg', payload: { type: 'task_started', turn_id: randomUUID() } }],
    ['response item', { type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }],
    ['user message', { type: 'event_msg', payload: { type: 'user_message', message: 'synthetic fixture' } }],
    ['wrong thread', metadata({ thread_id: randomUUID() })],
    ['missing thread', metadata({ thread_id: undefined })],
    ['null settings', metadata({ thread_settings: null })],
    ['array settings', metadata({ thread_settings: [] })],
    ['missing model', settings({ model: undefined })],
    ['empty model', settings({ model: '' })],
    ['invalid model', settings({ model: 'not a model' })],
    ['non-text model', settings({ model: 6 })],
    ['relative cwd', settings({ cwd: 'relative' })],
    ['NUL cwd', settings({ cwd: `${state.cwd}\0suffix` })],
    ['missing cwd', settings({ cwd: undefined })],
    ['non-text cwd', settings({ cwd: 1 })],
    ['unexpected event', { type: 'event_msg', payload: { type: 'other_metadata' } }],
    ['malformed JSON', '{"type":"event_msg","payload":'],
  ]);
  for (const [name, record] of cases) {
    await t.test(name, async () => {
      writeFileSync(path, original + (typeof record === 'string' ? record : JSON.stringify(record)) + '\n');
      assertUnchangedModel(state.state(), 'ultra');
      assert.notEqual((await state.snapshot()).lifecycle, 'empty');
      const blocked = await state.run('inspect');
      assert.equal(blocked.result.status, 'blocked', `${name}: ${JSON.stringify(blocked.result)}`);
      assert.equal(blocked.result.code, 'active_or_unknown_thread');
      const attempted = await state.run('archive', blocked.result.fingerprint);
      assert.equal(attempted.result.status, 'blocked');
      assert.doesNotMatch(attempted.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
      assert.equal(state.state().archived, 0);
    });
  }
  writeFileSync(path, original);
});

test('a long metadata tail cannot hide earlier non-metadata history from the empty check', async t => {
  const state = await fixture(t), path = state.state().rollout_path;
  const original = readFileSync(path, 'utf8'), metadata = JSON.stringify(state.records()[1]) + '\n';
  const hiddenInput = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'synthetic fixture' } }) + '\n';
  writeFileSync(path, original + hiddenInput + metadata.repeat(Math.ceil(2 * 1024 * 1024 / Buffer.byteLength(metadata)) + 2));
  assertUnchangedModel(state.state(), 'ultra');
  assert.notEqual((await state.snapshot()).lifecycle, 'empty');
  const blocked = await state.run('inspect');
  assert.equal(blocked.result.status, 'blocked'); assert.equal(blocked.result.code, 'active_or_unknown_thread');
  assert.doesNotMatch(blocked.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
});

test('adding native settings after inspection invalidates the old archive fingerprint', async t => {
  const state = await fixture(t), before = (await state.run('inspect')).result;
  assert.equal(before.status, 'ready');
  const originalSha = sha(state.state().rollout_path), originalCount = state.records().length;
  const changedSettings = await resume(state, { settingsChanges: [{ effort: 'high' }, { effort: 'ultra' }] });
  assert.deepEqual(changedSettings.turns, []);
  const applied = state.records().slice(originalCount).map(record => record.payload.thread_settings);
  assert.ok(applied.some(settings => settings.reasoning_effort === 'high'));
  assert.equal(applied.at(-1).reasoning_effort, 'ultra');
  const resumed = await resume(state);
  assert.deepEqual(resumed.turns, []); assert.equal(resumed.effort, 'ultra');
  assert.notEqual(sha(state.state().rollout_path), originalSha);
  const fresh = (await state.run('inspect')).result;
  assert.equal(fresh.status, 'ready'); assert.notEqual(fresh.fingerprint, before.fingerprint);
  const changed = await state.run('archive', before.fingerprint);
  assert.equal(changed.result.status, 'changed'); assert.equal(changed.result.code, 'fingerprint_changed');
  assert.doesNotMatch(changed.stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
  assert.equal(state.state().archived, 0); assertUnchangedModel(state.state(), 'ultra');
});

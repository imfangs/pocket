import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const cli = '/Applications/ChatGPT.app/Contents/Resources/codex';
const bridge = new URL('../bin/archive-thread.py', import.meta.url).pathname;
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function command(executable, args, { input = '', env = process.env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}
async function fixture(t, { empty = false, child = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pocket-archive-'));
  const home = join(base, 'home'), workspace = join(base, 'workspace');
  mkdirSync(home); mkdirSync(workspace);
  const env = { ...process.env, CODEX_HOME: home };
  delete env.CODEX_SQLITE_HOME; delete env.CODEX_THREAD_ID;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const state = id => {
    const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT id,archived,rollout_path,tokens_used,history_mode FROM threads WHERE id=?').get(id); }
    finally { db.close(); }
  };
  async function makeThread(parentId = null) {
    const id = randomUUID(), stamp = '2026-10-05T00:00:00.000Z';
    const folder = join(home, 'sessions', '2026', '10', '05'); mkdirSync(folder, { recursive: true });
    const path = join(folder, `rollout-2026-10-05T00-00-00-${id}.jsonl`);
    const meta = { id, timestamp: stamp, cwd: workspace, originator: 'codex_cli_rs', cli_version: '0.153.4',
      source: parentId ? { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } } : 'cli', model_provider: 'openai' };
    if (parentId) meta.session_id = parentId;
    const rows = [{ timestamp: stamp, type: 'session_meta', payload: meta }];
    if (!empty) rows.push({ timestamp: stamp, type: 'event_msg', payload: { type: 'user_message', message: 'Isolated archive fixture', images: [], local_images: [] } },
      { timestamp: stamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: randomUUID(), last_agent_message: 'Fixture completed' } });
    writeFileSync(path, rows.map(row => JSON.stringify(row) + '\n').join(''));
    const originalSha = sha(path);
    for (const operation of ['archive', 'unarchive']) {
      const result = await command(cli, [operation, id], { env, cwd: workspace });
      assert.equal(result.code, 0, result.stdout + result.stderr);
    }
    assert.equal(sha(state(id).rollout_path), originalSha);
    return id;
  }
  const id = await makeThread(), childId = child ? await makeThread(id) : null;
  const run = async (operation, expectedFingerprint, threadId = id, extra = {}) => {
    const result = await command('python3', [bridge], { env, cwd: workspace,
      input: JSON.stringify({ operation, threadId, codexHome: home, ...(expectedFingerprint ? { expectedFingerprint } : {}), ...extra }) });
    return result.stdout.trim() ? JSON.parse(result.stdout) : { status: 'unavailable', code: 'bridge_missing' };
  };
  return { id, childId, home, workspace, env, run, state };
}

test('official archive and restore preserve the isolated rollout bytes', async t => {
  const { id, run, state } = await fixture(t);
  const originalSha = sha(state(id).rollout_path);
  const before = await run('inspect'); assert.equal(before.status, 'ready'); assert.equal(before.descendantCount, 0);
  const archived = await run('archive', before.fingerprint);
  assert.equal(archived.status, 'archived'); assert.equal(archived.verified, true); assert.equal(state(id).archived, 1);
  assert.equal(sha(state(id).rollout_path), originalSha);
  const restored = await run('restore');
  assert.equal(restored.status, 'restored'); assert.equal(restored.verified, true); assert.equal(state(id).archived, 0);
  assert.equal(sha(state(id).rollout_path), originalSha);
});

test('session-meta-only empty threads can be archived without inventing a completed turn', async t => {
  const { id, run, state } = await fixture(t, { empty: true });
  assert.equal(state(id).tokens_used, 0);
  const before = await run('inspect'); assert.equal(before.status, 'ready');
  assert.equal((await run('archive', before.fingerprint)).status, 'archived');
  assert.equal((await run('restore')).status, 'restored');
});

test('a completed writer-held thread waits and the same fingerprint works after real lock release', async t => {
  const { id, home, env, run, state } = await fixture(t);
  const before = await run('inspect'); assert.equal(before.status, 'ready');
  const folder = join(home, 'thread-writer-locks'); mkdirSync(folder, { recursive: true });
  const holder = spawn('python3', ['-u', '-c', 'import fcntl,sys\nf=open(sys.argv[1],"w")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\nsys.stdin.read()\nf.close()', join(folder, `${id}.lock`)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  await once(holder.stdout, 'data');
  t.after(() => holder.stdin.end());
  const waiting = await run('inspect'); assert.equal(waiting.status, 'waiting'); assert.equal(waiting.fingerprint, before.fingerprint);
  assert.equal((await run('archive', waiting.fingerprint)).status, 'waiting'); assert.equal(state(id).archived, 0);
  holder.stdin.end(); await once(holder, 'close');
  assert.equal((await run('archive', waiting.fingerprint)).status, 'archived'); assert.equal(state(id).archived, 1);
});

test('archive verifies the whole spawned subtree, while restore changes only its exact root', async t => {
  const { id, childId, run, state } = await fixture(t, { child: true });
  const hashes = new Map([id, childId].map(value => [value, sha(state(value).rollout_path)]));
  const before = await run('inspect');
  assert.equal(before.status, 'ready'); assert.equal(before.rootArchived, false);
  assert.equal(before.descendantCount, 1); assert.deepEqual(before.threadIds, [id, childId].sort());
  const archived = await run('archive', before.fingerprint);
  assert.equal(archived.status, 'archived'); assert.equal(archived.rootArchived, true);
  assert.equal(state(childId).archived, 1);
  assert.equal(typeof archived.rootFingerprint, 'string');
  assert.notEqual(archived.rootFingerprint, archived.fingerprint);
  assert.equal((await run('restore', archived.fingerprint)).status, 'changed'); assert.equal(state(id).archived, 1);
  assert.equal((await run('restore', archived.rootFingerprint)).status, 'restored');
  assert.equal(state(id).archived, 0); assert.equal(state(childId).archived, 1);
  for (const value of [id, childId]) assert.equal(sha(state(value).rollout_path), hashes.get(value));
});

test('a partially archived subtree is explicit and is never treated as a fresh ready archive', async t => {
  const { childId, run } = await fixture(t, { child: true });
  const before = await run('inspect');
  assert.equal((await run('archive', before.fingerprint)).status, 'archived');
  assert.equal((await run('restore', undefined, childId)).status, 'restored');
  const partial = await run('inspect');
  assert.equal(partial.status, 'blocked'); assert.equal(partial.code, 'partial_subtree'); assert.equal(partial.rootArchived, true);
});

test('root-only restore and read-only recovery do not inspect an unrelated missing descendant', async t => {
  const { id, childId, run, state } = await fixture(t, { child: true });
  const before = await run('inspect'), archived = await run('archive', before.fingerprint);
  assert.equal(archived.status, 'archived');
  unlinkSync(state(childId).rollout_path);
  const restored = await run('restore');
  assert.equal(restored.status, 'restored'); assert.equal(restored.verified, true); assert.equal(restored.rootArchived, false);
  assert.deepEqual(restored.threadIds, [id]); assert.equal(state(childId).archived, 1);
  const inspected = await run('inspect', undefined, id, { rootOnly: true });
  assert.equal(inspected.status, 'ready'); assert.equal(inspected.rootArchived, false); assert.deepEqual(inspected.threadIds, [id]);
  assert.equal((await run('restore', undefined, id, { rootOnly: true })).code, 'invalid_request');
});

test('concurrent descendant activity during root restoration does not change the root-only verification result', async t => {
  const { id, childId, home, env, run, state } = await fixture(t, { child: true });
  const before = await run('inspect'); assert.equal((await run('archive', before.fingerprint)).status, 'archived');
  const rootSha = sha(state(id).rollout_path), childPath = state(childId).rollout_path;
  const program = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('archive_bridge',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ndef concurrent(binary,operation,root,store):\n result=m.official(binary,operation,root,store)\n with open(sys.argv[2],'ab') as out:out.write((json.dumps({'type':'event_msg','payload':{'type':'task_started','turn_id':'new-child-turn'}})+'\\n').encode())\n return result\nprint(json.dumps(m.execute(json.load(sys.stdin),run_cli=concurrent)))`;
  const result = await command('python3', ['-c', program, bridge, childPath], { env, input: JSON.stringify({ operation: 'restore', threadId: id, codexHome: home }) });
  assert.equal(result.code, 0, result.stderr);
  const restored = JSON.parse(result.stdout);
  assert.equal(restored.status, 'restored'); assert.equal(restored.verified, true); assert.deepEqual(restored.threadIds, [id]);
  assert.equal(sha(state(id).rollout_path), rootSha); assert.equal(state(childId).archived, 1);
});

test('new content rejects the old fingerprint and a late old completion cannot hide an active turn', async t => {
  const { id, run, state } = await fixture(t);
  const before = await run('inspect'), path = state(id).rollout_path;
  appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_started', turn_id: 'new-turn' } }) + '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'turn_complete', turn_id: 'older-turn' } }) + '\n');
  const blocked = await run('inspect');
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.rootArchived, false);
  assert.deepEqual(blocked.threadIds, [id]);
  assert.equal((await run('archive', before.fingerprint)).status, 'changed'); assert.equal(state(id).archived, 0);
  appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_complete', turn_id: 'new-turn' } }) + '\n');
  assert.equal((await run('inspect')).status, 'ready');
});

test('inspect has no write side effects and archive requires a confirmed fingerprint', async t => {
  const { id, home, run, state } = await fixture(t);
  const source = state(id).rollout_path, before = sha(source), database = sha(join(home, 'state_5.sqlite'));
  const inspected = await run('inspect'); assert.equal(inspected.status, 'ready');
  assert.equal((await run('archive')).code, 'fingerprint_required');
  assert.equal(sha(source), before); assert.equal(sha(join(home, 'state_5.sqlite')), database); assert.equal(state(id).archived, 0);
});

async function uncertainRun(env, data, mode) {
  const program = `import importlib.util,json,sys,types\nspec=importlib.util.spec_from_file_location('archive_bridge',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ncount=0\ndef uncertain(binary,operation,root,store):\n global count\n count+=1\n if sys.argv[2]=='after':\n  result=m.official(binary,operation,root,store)\n  if result.returncode: return result\n  raise RuntimeError('lost receipt after official execution')\n return types.SimpleNamespace(returncode=1,stderr='synthetic indeterminate failure')\nresult=m.execute(json.load(sys.stdin),run_cli=uncertain);result['attempts']=count;print(json.dumps(result))`;
  const result = await command('python3', ['-c', program, bridge, mode], { env, input: JSON.stringify(data) });
  assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout);
}

test('a lost CLI result is confirmed from persisted state instead of being blindly replayed', async t => {
  const { id, home, env, run, state } = await fixture(t);
  const before = await run('inspect'), originalSha = sha(state(id).rollout_path);
  const result = await uncertainRun(env, { operation: 'archive', threadId: id, codexHome: home, expectedFingerprint: before.fingerprint }, 'after');
  assert.equal(result.status, 'archived'); assert.equal(result.verified, true); assert.equal(result.attempts, 1);
  assert.equal(sha(state(id).rollout_path), originalSha);
});

test('an unexplained CLI failure stays unknown after readback instead of becoming a retryable lock wait', async t => {
  const { id, home, env, run, state } = await fixture(t);
  const before = await run('inspect');
  const result = await uncertainRun(env, { operation: 'archive', threadId: id, codexHome: home, expectedFingerprint: before.fingerprint }, 'before');
  assert.equal(result.status, 'unknown'); assert.equal(result.verified, false); assert.equal(result.attempts, 1);
  assert.equal(result.rootArchived, false); assert.equal(result.fingerprint, before.fingerprint); assert.equal(state(id).archived, 0);
});

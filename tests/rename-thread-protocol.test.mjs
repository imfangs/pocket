import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBridgeConfig } from '../server/bridge-config.mjs';

const config = readBridgeConfig();
const bridge = fileURLToPath(new URL('../bin/rename-thread.py', import.meta.url));
const creator = fileURLToPath(new URL('../bin/create-thread.py', import.meta.url));
const exec = promisify(execFile);
const loader = `import importlib.util,sys,json\nfrom pathlib import Path\ndef load(name,path):\n spec=importlib.util.spec_from_file_location(name,path); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m\nr=load('rename',sys.argv[1])\nc=load('create',sys.argv[2])\nhome=Path(sys.argv[3])\n`;

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-rename-protocol-')));
  const home = join(base, 'home'), cwd = join(base, 'workspace');
  mkdirSync(home); mkdirSync(cwd);
  // Actual official CLI, an empty private home, and no model endpoint or auth.
  writeFileSync(join(home, 'config.toml'), 'model="gpt-5"\nmodel_provider="probe"\napproval_policy="never"\nsandbox_mode="read-only"\n[model_providers.probe]\nname="No-model fixture"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, home, cwd };
}

function run(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
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

async function create(f) {
  const result = await run(creator, { requestId: randomUUID(), codexHome: f.home, cwd: f.cwd,
    receiptPath: join(f.base, 'create.json'), name: 'Original fixture' });
  assert.equal(result.status, 'created', JSON.stringify(result));
  return { operation: 'rename', codexHome: f.home, threadId: result.threadId,
    name: 'Pocket 新名称', expectedName: 'Original fixture' };
}

function source(home, threadId) {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM threads WHERE id=?').get(threadId);
    return { row, sha: createHash('sha256').update(readFileSync(row.rollout_path)).digest('hex') };
  } finally { db.close(); }
}

async function python(home, body) {
  const result = await exec(config.python, ['-c', loader + body, bridge, creator, home], { timeout: 30000 });
  return JSON.parse(result.stdout);
}

test('rename persists the original name only, exits its process, and a retry performs no write', async t => {
  const f = fixture(t), input = await create(f), before = source(f.home, input.threadId);
  const result = await run(bridge, input);
  assert.equal(result.status, 'renamed', JSON.stringify(result));
  assert.equal(result.verified, true); assert.equal(result.processStopped, true);
  assert.equal(result.name, input.name); assert.equal(result.title, input.name);
  assert.equal(result.modelTurnsStarted, 0);
  assert.deepEqual(result.rpcMethods, ['initialize', 'thread/name/set']);
  const after = source(f.home, input.threadId);
  assert.equal(after.sha, before.sha);
  // The official setter advances its update timestamp. Recency, permissions,
  // model configuration and every other original field must remain unchanged.
  const { name: oldName, updated_at: oldUpdated, updated_at_ms: oldUpdatedMs, ...oldFields } = before.row;
  const { name: newName, updated_at: newUpdated, updated_at_ms: newUpdatedMs, ...newFields } = after.row;
  assert.equal(oldName, input.expectedName); assert.equal(newName, input.name);
  assert.deepEqual(newFields, oldFields);
  assert.ok(newUpdated >= oldUpdated); assert.ok(newUpdatedMs >= oldUpdatedMs);
  const retry = await run(bridge, input);
  assert.equal(retry.status, 'unchanged'); assert.equal(retry.verified, true);
  assert.equal(retry.mutationAttempted, false); assert.deepEqual(retry.rpcMethods, []);
  assert.doesNotMatch(retry.stderr, /PHASE_V1 dispatch/);
});

test('inspection is read only and stale name or fingerprint cannot overwrite a later rename', async t => {
  const f = fixture(t), input = await create(f);
  const inspected = await run(bridge, { operation: 'inspect', threadId: input.threadId, codexHome: f.home });
  assert.equal(inspected.status, 'unchanged'); assert.equal(inspected.title, input.expectedName);
  assert.equal(inspected.canRename, true);
  assert.deepEqual(inspected.rpcMethods, []); assert.equal(inspected.mutationAttempted, false);
  const oldName = await run(bridge, { ...input, expectedName: 'Older title' });
  assert.equal(oldName.status, 'changed'); assert.equal(oldName.code, 'name_changed');
  const stale = await run(bridge, { ...input, expectedFingerprint: 'a'.repeat(64) });
  assert.equal(stale.status, 'changed'); assert.equal(stale.mutationAttempted, false);
  const renamed = await run(bridge, { ...input, expectedFingerprint: inspected.nameFingerprint });
  assert.equal(renamed.status, 'renamed');
  const late = await run(bridge, { ...input, name: 'Late overwrite' });
  assert.equal(late.status, 'changed'); assert.equal(late.title, input.name);
  assert.equal(source(f.home, input.threadId).row.name, input.name);
});

test('legacy rename uses the official title and name index without changing history', async t => {
  const f = fixture(t);
  const result = await python(f.home, `
with c.StdioServer(c.binary_for(home),home,home) as owner:
 tid=owner.call('thread/start',{'cwd':str(home),'ephemeral':False,'historyMode':'legacy'})['thread']['id']
 owner.call('thread/name/set',{'threadId':tid,'name':'Legacy original'})
 owner.call('thread/read',{'threadId':tid,'includeTurns':False})
store=r.RenameStore(home); before=store.snapshot(tid)
result=r.execute({'operation':'rename','threadId':tid,'codexHome':str(home),'expectedName':'Legacy original','name':'Legacy renamed'})
after=store.snapshot(tid)
entries=[json.loads(line) for line in (home/'session_index.jsonl').read_text().splitlines()]
print(json.dumps({'result':result,'before':before,'after':after,'indexedName':[e['thread_name'] for e in entries if e.get('id')==tid][-1]}))
`);
  assert.equal(result.result.status, 'renamed', JSON.stringify(result));
  assert.equal(result.after.rawTitle, 'Legacy renamed'); assert.equal(result.indexedName, 'Legacy renamed');
  assert.deepEqual(result.after.protected, result.before.protected);
});

test('a loaded original keeps its writer lock while the metadata process renames without loading it', async t => {
  const f = fixture(t);
  const result = await python(f.home, `
import fcntl
c.ALLOWED_METHODS.add('thread/loaded/list')
with c.StdioServer(c.binary_for(home),home,home) as owner:
 tid=owner.call('thread/start',{'cwd':str(home),'ephemeral':False,'historyMode':'paginated'})['thread']['id']
 owner.call('thread/name/set',{'threadId':tid,'name':'Loaded original'})
 owner.call('thread/read',{'threadId':tid,'includeTurns':True})
 def busy():
  with (home/'thread-writer-locks'/(tid+'.lock')).open('rb') as lock:
   try: fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
   except BlockingIOError: return True
   fcntl.flock(lock,fcntl.LOCK_UN); return False
 before=busy()
 result=r.execute({'operation':'rename','threadId':tid,'codexHome':str(home),'name':'Loaded renamed','expectedName':'Loaded original'})
 after=busy(); loaded=owner.call('thread/loaded/list',{})['data']
 observed=owner.call('thread/read',{'threadId':tid,'includeTurns':False})['thread']['name']
print(json.dumps({'before':before,'after':after,'result':result,'loaded':loaded,'id':tid,'observed':observed}))
`);
  assert.equal(result.result.status, 'renamed', JSON.stringify(result));
  assert.equal(result.before, true); assert.equal(result.after, true);
  assert.deepEqual(result.loaded, [result.id]); assert.equal(result.observed, 'Loaded renamed');
  assert.deepEqual(result.result.rpcMethods, ['initialize', 'thread/name/set']);
  assert.equal(result.result.processStopped, true);
});

test('archived threads remain inspectable and are not restored to make rename possible', async t => {
  const f = fixture(t), input = await create(f);
  await python(f.home, `
c.ALLOWED_METHODS.add('thread/archive')
with c.StdioServer(c.binary_for(home),home,home) as server: server.call('thread/archive',{'threadId':${JSON.stringify(input.threadId)}})
print('{}')
`);
  const inspected = await run(bridge, { operation: 'inspect', threadId: input.threadId, codexHome: f.home });
  assert.equal(inspected.archived, true); assert.equal(inspected.verified, true);
  assert.equal(inspected.canRename, false); assert.equal(inspected.code, 'archived_thread');
  const result = await run(bridge, input);
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'archived_thread');
  assert.equal(result.mutationAttempted, false); assert.deepEqual(result.rpcMethods, []);
  assert.equal(source(f.home, input.threadId).row.archived, 1);
});

test('invalid names, execution overrides and mutation-bearing inspections never reach a write', async t => {
  const f = fixture(t), input = await create(f);
  for (const name of ['', '  ', 'line\nbreak', 'tab\tname', 'C1\u0085name', 'line\u2028break', 'a'.repeat(221), '🙂'.repeat(111), '\ud800']) {
    const result = await run(bridge, { ...input, name });
    assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'invalid_thread_name');
    assert.equal(result.mutationAttempted, false);
  }
  for (const extra of [{ model: 'override' }, { history: [] }, { operation: 'cancel' },
    { operation: 'inspect' }, { method: 'turn/start' }]) {
    const result = await run(bridge, { ...input, ...extra });
    assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'invalid_rename_request');
    assert.deepEqual(result.rpcMethods, []);
  }
  assert.equal(source(f.home, input.threadId).row.name, input.expectedName);
});

test('App releases and unverified CLI versions preserve rename dispatch while failed probes stop before it', async t => {
  const f = fixture(t), input = await create(f);
  const result = await python(f.home, `
from unittest.mock import patch
from types import SimpleNamespace
from contextlib import redirect_stderr
from io import StringIO
from tempfile import TemporaryFile
data=json.loads(${JSON.stringify(JSON.stringify(input))})
with patch.object(r,'CONFIG',{**r.CONFIG,'supportedVersion':'unverified'}): inspected=r.execute({'operation':'inspect','threadId':data['threadId'],'codexHome':str(home)})
with TemporaryFile(mode='w+',encoding='utf-8') as diagnostics:
 with redirect_stderr(diagnostics), patch('bundled_cli.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout='codex-cli 99.0.0',stderr='')):
  unverified=r.execute(data)
  retry=r.execute(data)
 diagnostics.flush();diagnostics.seek(0);diagnostics_text=diagnostics.read()
next_data={**data,'expectedName':data['name'],'name':'App release rename'}
failed_diagnostics=StringIO()
with redirect_stderr(failed_diagnostics), patch('bundled_cli.subprocess.run',return_value=SimpleNamespace(returncode=1,stdout='codex-cli 99.0.0',stderr='synthetic failure')):
 failed=r.execute(next_data)
with patch.object(r,'CONFIG',{**r.CONFIG,'supportedVersion':'unverified'}): renamed=r.execute(next_data)
print(json.dumps({'app':renamed,'cli':unverified,'retry':retry,'failed':failed,'inspect':inspected,'diagnostics':diagnostics_text,'failedDiagnostics':failed_diagnostics.getvalue()}))
`);
  assert.equal(result.app.status, 'renamed'); assert.equal(result.app.verified, true);
  assert.equal(result.cli.status, 'renamed'); assert.equal(result.cli.verified, true);
  assert.equal(result.cli.mutationAttempted, true); assert.equal(result.cli.processStopped, true);
  assert.deepEqual(result.cli.rpcMethods, ['initialize', 'thread/name/set']);
  const warnings = result.diagnostics.split('\n').filter(line => line.startsWith('POCKET_BRIDGE_WARNING_V1 '));
  assert.deepEqual(warnings.map(line => JSON.parse(line.slice('POCKET_BRIDGE_WARNING_V1 '.length))),
    [{ code: 'unverified_cli_version', cliVersion: 'codex-cli 99.0.0' }]);
  assert.equal(result.diagnostics.split('\n').filter(line => line === 'POCKET_BRIDGE_PHASE_V1 dispatch').length, 1);
  assert.equal(result.retry.status, 'unchanged'); assert.equal(result.retry.mutationAttempted, false);
  assert.deepEqual(result.retry.rpcMethods, []);
  assert.equal(result.failed.status, 'unavailable'); assert.equal(result.failed.code, 'bundled_cli_unavailable');
  assert.equal(result.failed.mutationAttempted, false); assert.deepEqual(result.failed.rpcMethods, []);
  assert.doesNotMatch(result.failedDiagnostics, /POCKET_BRIDGE_PHASE_V1 dispatch/);
  assert.equal(result.inspect.status, 'unchanged'); assert.equal(result.inspect.verified, true);
  assert.equal(result.inspect.canRename, true);
  assert.equal(source(f.home, input.threadId).row.name, 'App release rename');
});

test('late source changes, lost replies and protected metadata changes have distinct outcomes', async t => {
  const f = fixture(t), input = await create(f);
  const result = await python(f.home, `
data=json.loads(${JSON.stringify(JSON.stringify(input))})
class Race(r.RenameServer):
 def __enter__(self):
  result=super().__enter__()
  with r.sqlite3.connect(self.store.database) as db: db.execute('UPDATE threads SET name=? WHERE id=?',('Concurrent title',data['threadId']))
  return result
race=r.execute(data,server_factory=Race)
data['expectedName']='Concurrent title'
class LostReply(r.RenameServer):
 def call(self,method,params):
  result=super().call(method,params)
  if method=='thread/name/set': raise r.ArchiveError('rpc_timeout','Synthetic lost reply after accepted write')
  return result
recovered=r.execute(data,server_factory=LostReply)
data.update(expectedName=data['name'],name='Uncertain changed context')
class ChangedContext(r.RenameServer):
 def call(self,method,params):
  result=super().call(method,params)
  if method=='thread/name/set':
   with r.sqlite3.connect(self.store.database) as db: db.execute('UPDATE threads SET cwd=? WHERE id=?',(str(home),data['threadId']))
  return result
unknown=r.execute(data,server_factory=ChangedContext)
print(json.dumps({'race':race,'recovered':recovered,'unknown':unknown}))
`);
  assert.equal(result.race.status, 'changed'); assert.equal(result.race.mutationAttempted, false);
  assert.equal(result.race.processStopped, true);
  assert.equal(result.recovered.status, 'renamed'); assert.equal(result.recovered.verified, true);
  assert.deepEqual(result.recovered.rpcMethods, ['initialize', 'thread/name/set']);
  assert.equal(result.unknown.status, 'unknown'); assert.equal(result.unknown.verified, false);
  assert.equal(result.unknown.code, 'thread_metadata_changed');
  assert.equal(result.unknown.processStopped, true);
});

test('the rename transport rejects start, resume, archive, project and other metadata RPCs', async t => {
  const f = fixture(t);
  const result = await python(f.home, `
transport=r.RenameServer('/not-launched',r.RenameStore(home)); refused=[]
for method in ['thread/start','thread/resume','turn/start','thread/archive','project/create','thread/metadata/update','thread/settings/update']:
 try: transport.call(method,{})
 except r.ArchiveError as error: refused.append(error.code)
print(json.dumps({'refused':refused,'process':transport.process,'attempted':transport.mutation_attempted}))
`);
  assert.deepEqual(result.refused, Array(7).fill('rpc_not_allowed'));
  assert.equal(result.process, null); assert.equal(result.attempted, false);
});

test('interruption during name dispatch exits the metadata child and preserves an unknown receipt', async t => {
  const f = fixture(t), input = await create(f);
  const body = loader + `
import signal,time
signal.signal(signal.SIGTERM,r.interrupted)
class Waiting(r.RenameServer):
 def call(self,method,params):
  if method=='thread/name/set':
   self.mutation_attempted=True
   self.methods.append(method)
   print('TEST_CHILD '+str(self.process.pid),file=sys.stderr,flush=True)
   time.sleep(60)
  return super().call(method,params)
print(json.dumps(r.execute(json.loads(${JSON.stringify(JSON.stringify(input))}),server_factory=Waiting)))
`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(config.python, ['-c', body, bridge, creator, f.home]);
    let stdout = '', stderr = '', metadataPid;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Interrupted metadata process did not exit')); }, 12000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => {
      stderr += data;
      const match = stderr.match(/TEST_CHILD (\d+)/);
      if (match && metadataPid == null) { metadataPid = Number(match[1]); child.kill('SIGTERM'); }
    });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      try { assert.equal(code, 0, stderr); resolve({ receipt: JSON.parse(stdout), metadataPid }); }
      catch (error) { reject(error); }
    });
  });
  assert.equal(result.receipt.status, 'unknown'); assert.equal(result.receipt.verified, false);
  assert.equal(result.receipt.processStopped, true); assert.equal(result.receipt.mutationAttempted, true);
  assert.throws(() => process.kill(result.metadataPid, 0), { code: 'ESRCH' });
  assert.equal(source(f.home, input.threadId).row.name, input.expectedName);
});

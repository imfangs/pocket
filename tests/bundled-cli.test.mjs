import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBridgeConfig } from '../server/bridge-config.mjs';

const exec = promisify(execFile);
const config = readBridgeConfig();
const bin = fileURLToPath(new URL('../bin', import.meta.url));
const modern = '26.1007.21159:20052', legacy = '26.903.71938:8576';
const launcher = 'codex-cli/bin/codex', executable = 'codex-cli/CodexCLI.app/Contents/MacOS/codex';

function fixture(t, files = [], { version = modern, bundleId = 'com.openai.codex' } = {}) {
  const app = mkdtempSync(join(tmpdir(), 'pocket-cli-layout-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true });
  const [release = '', build = ''] = version.split(':');
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>${bundleId}</string>
    <key>CFBundleShortVersionString</key><string>${release}</string>
    <key>CFBundleVersion</key><string>${build}</string></dict></plist>`);
  for (const file of files) {
    const path = join(app, 'Contents/Resources', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\nexit 91\n', { mode: 0o755 });
  }
  return app;
}

async function resolve(app, version) {
  const { stdout } = await exec(config.python, ['-B', '-c', `
import json,sys
sys.path.insert(0,sys.argv[1])
from bundled_cli import bundled_cli,BundledCLIError
try:
 print(json.dumps({key:str(value) for key,value in bundled_cli(sys.argv[2],sys.argv[3]).items()}))
except BundledCLIError as error:
 print(json.dumps({'code':error.code}))
`, bin, app, version ?? 'ignored']);
  return JSON.parse(stdout);
}

test('packaged CLI uses its launcher for execution and actual Mach-O for process discovery', async t => {
  const app = fixture(t, [launcher, executable, 'codex']);
  const result = await resolve(app, modern);
  assert.ok(result.entrypoint.endsWith('/' + launcher));
  assert.ok(result.executable.endsWith('/' + executable));
  assert.equal(result.version, undefined, 'Layout cannot establish an actual CLI version');
});

test('an App update with the same bundled CLI layout does not require a release allowlist', async t => {
  const updated = '26.1007.30912:20156';
  const result = await resolve(fixture(t, [launcher, executable], { version: updated }), updated);
  assert.ok(result.entrypoint?.endsWith('/' + launcher), JSON.stringify(result));
  assert.ok(result.executable?.endsWith('/' + executable), JSON.stringify(result));
});

test('direct and packaged layouts follow available files, independent of the App release', async t => {
  const result = await resolve(fixture(t, ['codex'], { version: modern }), 'unverified');
  assert.equal(result.entrypoint, result.executable);
  assert.ok(result.entrypoint.endsWith('/Contents/Resources/codex'));
  const packaged = await resolve(fixture(t, [launcher, executable], { version: legacy }));
  assert.ok(packaged.executable.endsWith('/' + executable));
});

test('incomplete packages fail without falling back to a stale legacy binary', async t => {
  for (const files of [[], [launcher], [executable], ['codex', launcher], ['codex', executable]]) {
    assert.deepEqual(await resolve(fixture(t, files), modern), { code: 'bundled_cli_unavailable' });
  }
});

test('bundle identity and readable metadata are required, but a release string is diagnostic only', async t => {
  assert.deepEqual(await resolve(fixture(t, ['codex'], { bundleId: 'com.example.other' })), { code: 'unsupported_app_identity' });
  const app = fixture(t, ['codex'], { version: '' });
  const { stdout } = await exec(config.python, ['-B', '-c', `
import json,sys
sys.path.insert(0,sys.argv[1])
from bundled_cli import desktop_app,bundled_cli
app=desktop_app(sys.argv[2])
print(json.dumps({'version':app['version'],'path':str(app['path']),'id':app['info']['CFBundleIdentifier'],
 'entrypoint':str(bundled_cli(sys.argv[2])['entrypoint'])}))
`, bin, app]);
  const info = JSON.parse(stdout);
  assert.equal(info.version, 'unknown'); assert.equal(info.id, 'com.openai.codex');
  assert.ok(info.entrypoint.startsWith(info.path + '/'));
  for (const contents of ['malformed plist', '<?xml version="1.0"?><plist><dict>']) {
    writeFileSync(join(app, 'Contents/Info.plist'), contents);
    assert.deepEqual(await resolve(app), { code: 'bundled_app_unavailable' });
  }
  rmSync(join(app, 'Contents/Info.plist'));
  assert.deepEqual(await resolve(app), { code: 'bundled_app_unavailable' });
});

test('package resolution rejects paths outside the verified App resources', async t => {
  const app = fixture(t, [launcher]);
  const binary = join(app, 'Contents/Resources', executable);
  mkdirSync(dirname(binary), { recursive: true });
  symlinkSync('/bin/sh', binary);
  assert.deepEqual(await resolve(app, modern), { code: 'bundled_cli_unavailable' });
  const nonExecutable = fixture(t, ['codex']);
  chmodSync(join(nonExecutable, 'Contents/Resources/codex'), 0o644);
  assert.deepEqual(await resolve(nonExecutable), { code: 'bundled_cli_unavailable' });
});

test('creation and archive continue after an unverified CLI warning without changing dispatch arguments', async t => {
  const app = fixture(t, [launcher, executable]);
  const { stdout, stderr } = await exec(config.python, ['-B', '-c', `
import importlib.util,json,sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1])
app=Path(sys.argv[2])
results=[]
calls=[]
def probe_or_dispatch(args,**kwargs):
 calls.append([str(value) for value in args])
 return SimpleNamespace(returncode=0,stdout='codex-cli 99.0.0' if args[-1]=='--version' else '',stderr='')
for filename in ('create-thread.py','archive-thread.py'):
 spec=importlib.util.spec_from_file_location(filename,Path(sys.argv[1])/filename)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.CONFIG={**module.CONFIG,'appPath':str(app),'supportedVersion':'unverified'}
 module.subprocess.run=probe_or_dispatch
 if filename=='create-thread.py':results.append({'kind':'create','binary':str(module.binary_for(app))})
 else:results.append({'kind':'archive','returncode':module.official(app/'Contents/Resources/codex-cli/bin/codex','archive','fixture',SimpleNamespace(home=app,sqlite_home=app)).returncode})
print(json.dumps({'results':results,'calls':calls}))
`, bin, app]);
  const value = JSON.parse(stdout), binary = join(app, 'Contents/Resources', launcher);
  assert.deepEqual(value.results, [{ kind: 'create', binary: realpathSync(binary) }, { kind: 'archive', returncode: 0 }]);
  assert.deepEqual(value.calls, [[realpathSync(binary), '--version'], [binary, '--version'], [binary, 'archive', 'fixture', '-c', 'sqlite_home=' + JSON.stringify(app)]]);
  const warnings = stderr.split('\n').filter(line => line.startsWith('POCKET_BRIDGE_WARNING_V1 '));
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(line => !line.includes(app) && line.length <= 256));
  for (const line of warnings) assert.deepEqual(JSON.parse(line.slice('POCKET_BRIDGE_WARNING_V1 '.length)), { code: 'unverified_cli_version', cliVersion: 'codex-cli 99.0.0' });
  assert.equal((stderr.match(/POCKET_BRIDGE_PHASE_V1 dispatch/g) || []).length, 1);
});

test('CLI verification preserves tested versions and warns once for any valid unverified version', async t => {
  const app = fixture(t, ['codex']);
  const { stdout, stderr } = await exec(config.python, ['-B', '-c', `
import json,sys
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
from bundled_cli import verify_cli,BundledCLIError
results=[]
for value in ['codex-cli 0.153.4','codex-cli 0.162.0-alpha.17.2','codex-cli 0.163.0-alpha.10.2','codex-cli 0.164.0-alpha.11.1','codex-cli 0.166.0-alpha.5.1','codex-cli 0.164.0-alpha.11.2','codex-cli 99.0.0','codex-cli 123.4.5-rc.2+build.001']:
 with patch('bundled_cli.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=value)) as run:
  try: results.append({'version':verify_cli('/fake/codex',sys.argv[2])})
  except BundledCLIError as error: results.append({'code':error.code})
  assert run.call_args.args[0] == ['/fake/codex','--version']
  assert 'CODEX_THREAD_ID' not in run.call_args.kwargs['env']
print(json.dumps(results))
`, bin, app]);
  assert.deepEqual(JSON.parse(stdout), [
    { version: 'codex-cli 0.153.4' },
    { version: 'codex-cli 0.162.0-alpha.17.2' },
    { version: 'codex-cli 0.163.0-alpha.10.2' },
    { version: 'codex-cli 0.164.0-alpha.11.1' },
    { version: 'codex-cli 0.166.0-alpha.5.1' },
    { version: 'codex-cli 0.164.0-alpha.11.2' },
    { version: 'codex-cli 99.0.0' },
    { version: 'codex-cli 123.4.5-rc.2+build.001' },
  ]);
  const warnings = stderr.trim().split('\n'); assert.equal(warnings.length, 4);
  for (const [index, line] of warnings.entries()) {
    assert.ok(line.startsWith('POCKET_BRIDGE_WARNING_V1 '));
    assert.deepEqual(JSON.parse(line.slice('POCKET_BRIDGE_WARNING_V1 '.length)), {
      code: 'unverified_cli_version', cliVersion: JSON.parse(stdout)[index + 4].version,
    });
    assert.ok(line.length <= 256); assert.ok(!line.includes(app));
  }
});

test('failed, timed out, non-Codex and malformed version probes remain unavailable without echoing their output', async t => {
  const app = fixture(t, ['codex']);
  const invalid = ['', ' \n ', 'node v22.1.0', 'codex 1.2.3', 'codex-cli', 'codex-cli 1.2',
    'codex-cli 01.2.3', 'codex-cli 1.2.3-01', 'codex-cli 1.2.3-alpha..1', 'codex-cli 1.2.3+',
    'codex-cli 1.2.3 extra', 'codex-cli 1.2.3\nprivate-output', 'codex-cli 1.2.3-中文',
    'codex-cli 1.2.3-' + 'x'.repeat(161)];
  const { stdout, stderr } = await exec(config.python, ['-B', '-c', `
import json,sys,subprocess
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
from bundled_cli import verify_cli,BundledCLIError
errors=[]
for value in json.loads(sys.argv[3]):
 with patch('bundled_cli.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout=value,stderr='private error')):
  try: verify_cli('/fake/codex',sys.argv[2]); errors.append('accepted')
  except BundledCLIError as error: errors.append(error.code)
with patch('bundled_cli.subprocess.run',return_value=SimpleNamespace(returncode=1,stdout='codex-cli 99.0.0',stderr='private error')):
 try: verify_cli('/fake/codex',sys.argv[2]); errors.append('accepted')
 except BundledCLIError as error: errors.append(error.code)
for failure in [OSError('private failure'),subprocess.TimeoutExpired('private probe',5),UnicodeError('private encoding failure')]:
 with patch('bundled_cli.subprocess.run',side_effect=failure):
  try: verify_cli('/fake/codex',sys.argv[2]); errors.append('accepted')
  except BundledCLIError as error: errors.append(error.code)
print(json.dumps(errors))
`, bin, app, JSON.stringify(invalid)]);
  assert.deepEqual(JSON.parse(stdout), Array(invalid.length + 4).fill('bundled_cli_unavailable'));
  assert.equal(stderr, '');
});

test('an unavailable diagnostic sink cannot gate a valid unverified CLI or pollute stdout', async t => {
  const app = fixture(t, ['codex']);
  const { stdout, stderr } = await exec(config.python, ['-B', '-c', `
import io,json,sys
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
from bundled_cli import verify_cli
closed=io.StringIO();closed.close()
versions=[]
for sink in [None,closed]:
 with patch('bundled_cli.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout='codex-cli 99.0.0')),patch('sys.stderr',sink):
  versions.append(verify_cli('/fake/codex',sys.argv[2]))
print(json.dumps(versions))
`, bin, app]);
  assert.deepEqual(JSON.parse(stdout), ['codex-cli 99.0.0', 'codex-cli 99.0.0']);
  assert.equal(stderr, '');
});

test('a closed stderr pipe cannot change the successful process exit code during Python shutdown', async t => {
  const app = fixture(t, ['codex']);
  const child = spawn(config.python, ['-B', '-c', `
import json,sys
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
from bundled_cli import verify_cli
with patch('bundled_cli.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout='codex-cli 99.0.0')):
 version=verify_cli('/fake/codex',sys.argv[2])
print(json.dumps({'version':version}))
`, bin, app], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.destroy();
  let stdout = '';
  child.stdout.on('data', data => { stdout += data; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI warning fixture did not exit')); }, 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); resolve(status); });
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { version: 'codex-cli 99.0.0' });
});

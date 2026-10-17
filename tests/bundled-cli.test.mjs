import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const config = JSON.parse(readFileSync(new URL('../config/desktop-bridge.json', import.meta.url), 'utf8'));
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

test('creation and archive reject an unknown numeric CLI version before dispatch, regardless of App release', async t => {
  const app = fixture(t, [launcher, executable]);
  const { stdout, stderr } = await exec(config.python, ['-B', '-c', `
import importlib.util,json,sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1])
app=Path(sys.argv[2])
errors=[]
for filename in ('create-thread.py','archive-thread.py'):
 spec=importlib.util.spec_from_file_location(filename,Path(sys.argv[1])/filename)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.CONFIG={**module.CONFIG,'appPath':str(app),'supportedVersion':'unverified'}
 module.subprocess.run=lambda *args,**kwargs: SimpleNamespace(returncode=0,stdout='codex-cli 99.0.0',stderr='')
 try:
  if filename=='create-thread.py':module.binary_for(app)
  else:module.official(app/'Contents/Resources/codex-cli/bin/codex','archive','fixture',SimpleNamespace(home=app,sqlite_home=app))
 except Exception as error:
  errors.append(getattr(error,'code',str(error)))
print(json.dumps(errors))
`, bin, app]);
  assert.deepEqual(JSON.parse(stdout), ['cli_version_changed', 'cli_version_changed']);
  assert.doesNotMatch(stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
});

test('CLI verification accepts only independent tested behavior contracts and returns the actual version', async t => {
  const app = fixture(t, ['codex']);
  const { stdout } = await exec(config.python, ['-B', '-c', `
import json,sys
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,sys.argv[1])
from bundled_cli import verify_cli,BundledCLIError
results=[]
for value in ['codex-cli 0.153.4','codex-cli 0.162.0-alpha.17.2','codex-cli 0.163.0-alpha.10.2','codex-cli 0.163.0-alpha.10.3','codex-cli 99.0.0']:
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
    { code: 'cli_version_changed' },
    { code: 'cli_version_changed' },
  ]);
});

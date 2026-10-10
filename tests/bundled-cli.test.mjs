import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const config = JSON.parse(readFileSync(new URL('../config/desktop-bridge.json', import.meta.url), 'utf8'));
const bin = fileURLToPath(new URL('../bin', import.meta.url));
const modern = '26.1007.21159:20052', legacy = '26.903.71938:8576';
const launcher = 'codex-cli/bin/codex', executable = 'codex-cli/CodexCLI.app/Contents/MacOS/codex';

function fixture(t, files = []) {
  const app = mkdtempSync(join(tmpdir(), 'pocket-cli-layout-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  for (const file of files) {
    const path = join(app, 'Contents/Resources', file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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
`, bin, app, version]);
  return JSON.parse(stdout);
}

test('packaged CLI uses its launcher for execution and actual Mach-O for process discovery', async t => {
  const app = fixture(t, [launcher, executable, 'codex']);
  const result = await resolve(app, modern);
  assert.ok(result.entrypoint.endsWith('/' + launcher));
  assert.ok(result.executable.endsWith('/' + executable));
  assert.equal(result.version, 'codex-cli 0.162.0-alpha.17.2');
});

test('previous verified release retains its direct executable and exact CLI version', async t => {
  const result = await resolve(fixture(t, ['codex']), legacy);
  assert.equal(result.entrypoint, result.executable);
  assert.ok(result.entrypoint.endsWith('/Contents/Resources/codex'));
  assert.equal(result.version, 'codex-cli 0.153.4');
});

test('unknown releases and incomplete package layouts fail before any CLI invocation', async t => {
  assert.deepEqual(await resolve(fixture(t, [launcher, executable]), 'unverified'), { code: 'app_version_changed' });
  for (const files of [[], ['codex'], [launcher], [executable]]) {
    assert.deepEqual(await resolve(fixture(t, files), modern), { code: 'bundled_cli_unavailable' });
  }
});

test('package resolution rejects paths outside the verified App resources', async t => {
  const app = fixture(t, [launcher]);
  const binary = join(app, 'Contents/Resources', executable);
  mkdirSync(dirname(binary), { recursive: true });
  symlinkSync('/bin/sh', binary);
  assert.deepEqual(await resolve(app, modern), { code: 'bundled_cli_unavailable' });
});

test('creation and archive still reject an unexpected CLI version before dispatch', async t => {
  const app = fixture(t, [launcher, executable]);
  const { stdout, stderr } = await exec(config.python, ['-B', '-c', `
import importlib.util,json,plistlib,sys
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,sys.argv[1])
app=Path(sys.argv[2]);version=sys.argv[3]
with (app/'Contents/Info.plist').open('wb') as stream:
 plistlib.dump({'CFBundleIdentifier':'com.openai.codex','CFBundleShortVersionString':version.split(':')[0],'CFBundleVersion':version.split(':')[1]},stream)
errors=[]
for filename in ('create-thread.py','archive-thread.py'):
 spec=importlib.util.spec_from_file_location(filename,Path(sys.argv[1])/filename)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 module.CONFIG={**module.CONFIG,'appPath':str(app),'supportedVersion':version}
 module.subprocess.run=lambda *args,**kwargs: SimpleNamespace(returncode=0,stdout='codex-cli unverified',stderr='')
 try:
  if filename=='create-thread.py':module.binary_for(app)
  else:module.official(app/'Contents/Resources/codex-cli/bin/codex','archive','fixture',SimpleNamespace(home=app,sqlite_home=app))
 except Exception as error:
  errors.append(getattr(error,'code',str(error)))
print(json.dumps(errors))
`, bin, app, modern]);
  assert.deepEqual(JSON.parse(stdout), ['cli_version_changed', 'cli_version_changed']);
  assert.doesNotMatch(stderr, /POCKET_BRIDGE_PHASE_V1 dispatch/);
});

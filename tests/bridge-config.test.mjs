import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBridgeConfig } from '../server/bridge-config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const python = readBridgeConfig().python;
const modules = join(root, 'vendor/codex-bridge');
const entries = ['desktop-bridge.py', 'task-statuses.py', 'read-state.py', 'rename-thread.py', 'archive-thread.py'];

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-bridge-config-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}
const pythonConfig = config => JSON.parse(execFileSync(python, ['-B', '-c',
  'import json,sys;sys.path.insert(0,sys.argv[1]);from bridge_config import load_bridge_config;print(json.dumps(load_bridge_config()))', join(root, 'bin')],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NAVIGATOR_BRIDGE_CONFIG: config }, timeout: 5000 }));

test('bundled standard-library bridge files keep their exact recorded source bytes', () => {
  const provenance = JSON.parse(readFileSync(join(modules, 'provenance.json')));
  assert.deepEqual(provenance.files.map(file => file.file).sort(), ['app_ipc.py', 'archive_cli.py', 'contracts.py', 'metadata_cli.py']);
  for (const file of provenance.files) {
    const bytes = readFileSync(join(modules, file.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(file.modified, false);
    assert.equal(file.sourceMatchesCommit, true);
  }
});

test('an explicit portable config uses bundled IPC and independent metadata defaults in Node and Python', t => {
  const base = fixture(t), config = join(base, 'bridge.json');
  writeFileSync(config, JSON.stringify({ python, appPath: join(base, 'NotAnApp.app') }));
  const expected = { python, appPath: join(base, 'NotAnApp.app'), ipcModuleDirectory: modules, metadataModuleDirectory: modules };
  assert.deepEqual(readBridgeConfig(config), expected);
  assert.deepEqual(pythonConfig(config), expected);
});

test('explicit absolute paths remain exact, including unavailable paths, rather than falling back silently', t => {
  const base = fixture(t), config = join(base, 'explicit.json');
  const input = { python: join(base, 'missing-python'), appPath: join(base, 'missing-app'),
    ipcModuleDirectory: join(base, 'missing-ipc'), metadataModuleDirectory: join(base, 'missing-metadata') };
  writeFileSync(config, JSON.stringify(input));
  assert.deepEqual(readBridgeConfig(config), input);
  assert.deepEqual(pythonConfig(config), input);
  assert.throws(() => readBridgeConfig('relative.json'), /must be absolute/);
  assert.throws(() => readBridgeConfig(join(base, 'absent.json')), /ENOENT/);
});

test('configured executable names are resolved on PATH without consulting FBT', t => {
  const config = join(fixture(t), 'named.json');
  writeFileSync(config, JSON.stringify({ python: 'python3' }));
  const node = readBridgeConfig(config), py = pythonConfig(config);
  assert.deepEqual(node, py);
  assert.ok(isAbsolute(node.python) && existsSync(node.python));
  assert.equal(node.ipcModuleDirectory, modules); assert.equal(node.metadataModuleDirectory, modules);
  assert.ok(node.appPath.endsWith('Codex.app'));
});

test('malformed explicit fields and relative module paths fail rather than selecting another runtime', t => {
  const base = fixture(t), config = join(base, 'invalid.json');
  for (const value of [[], null, { python: false }, { python: './python3' }, { ipcModuleDirectory: 'relative' }, { metadataModuleDirectory: 'relative' }, { appPath: 'relative' }]) {
    writeFileSync(config, JSON.stringify(value));
    assert.throws(() => readBridgeConfig(config));
    assert.throws(() => pythonConfig(config));
  }
});

test('a repository export with unavailable author paths discovers Python and its own bundled modules', t => {
  const exported = join(fixture(t), 'export');
  for (const part of ['bin', 'server', 'config', 'vendor/codex-bridge']) mkdirSync(join(exported, part), { recursive: true });
  copyFileSync(join(root, 'bin/bridge_config.py'), join(exported, 'bin/bridge_config.py'));
  copyFileSync(join(root, 'server/bridge-config.mjs'), join(exported, 'server/bridge-config.mjs'));
  for (const file of ['app_ipc.py', 'contracts.py', 'archive_cli.py', 'metadata_cli.py']) copyFileSync(join(modules, file), join(exported, 'vendor/codex-bridge', file));
  const missing = join(exported, 'unavailable');
  writeFileSync(join(exported, 'config/desktop-bridge.json'), JSON.stringify({ python: join(missing, 'python'),
    appPath: join(missing, 'App'), ipcModuleDirectory: join(missing, 'ipc'), metadataModuleDirectory: join(missing, 'metadata') }));
  const env = { ...process.env }; delete env.NAVIGATOR_BRIDGE_CONFIG;
  const node = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    'import {readBridgeConfig} from "./server/bridge-config.mjs";console.log(JSON.stringify(readBridgeConfig()))'], { cwd: exported, env, encoding: 'utf8', timeout: 5000 }));
  const py = JSON.parse(execFileSync(python, ['-B', '-c', 'import sys,json;sys.path.insert(0,"bin");from bridge_config import load_bridge_config;print(json.dumps(load_bridge_config()))'],
    { cwd: exported, env, encoding: 'utf8', timeout: 5000 }));
  assert.deepEqual(node, py);
  assert.ok(isAbsolute(node.python) && existsSync(node.python));
  assert.equal(node.ipcModuleDirectory, join(exported, 'vendor/codex-bridge'));
  assert.equal(node.metadataModuleDirectory, node.ipcModuleDirectory);
  assert.ok(node.appPath.endsWith('Codex.app'));
});

test('all desktop bridge entrypoints import without a FBT checkout or desktop connection', t => {
  const exported = join(fixture(t), 'export');
  mkdirSync(join(exported, 'bin'), { recursive: true }); mkdirSync(join(exported, 'vendor/codex-bridge'), { recursive: true });
  for (const file of readdirSync(join(root, 'bin')).filter(file => file.endsWith('.py'))) copyFileSync(join(root, 'bin', file), join(exported, 'bin', file));
  for (const file of ['app_ipc.py', 'contracts.py', 'archive_cli.py', 'metadata_cli.py']) copyFileSync(join(modules, file), join(exported, 'vendor/codex-bridge', file));
  const config = join(exported, 'bridge.json');
  writeFileSync(config, JSON.stringify({ python, appPath: join(exported, 'NoDesktop.app') }));
  const importOnly = 'import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[2]);print("imported")';
  for (const file of entries) {
    const value = execFileSync(python, ['-B', '-c', importOnly, join(exported, 'bin'), join(exported, 'bin', file)],
      { cwd: exported, env: { ...process.env, NAVIGATOR_BRIDGE_CONFIG: config }, encoding: 'utf8', timeout: 5000 });
    assert.equal(value.trim(), 'imported', file);
  }
});

test('default compatibility loading preserves existing explicit runtime and module selections', t => {
  const exported = join(fixture(t), 'export');
  for (const part of ['bin', 'server', 'config', 'chosen-ipc', 'chosen-metadata', 'Chosen.app']) mkdirSync(join(exported, part), { recursive: true });
  copyFileSync(join(root, 'bin/bridge_config.py'), join(exported, 'bin/bridge_config.py'));
  copyFileSync(join(root, 'server/bridge-config.mjs'), join(exported, 'server/bridge-config.mjs'));
  for (const file of ['app_ipc.py', 'contracts.py']) writeFileSync(join(exported, 'chosen-ipc', file), '# fixture\n');
  for (const file of ['archive_cli.py', 'metadata_cli.py']) writeFileSync(join(exported, 'chosen-metadata', file), '# fixture\n');
  const binary = join(exported, 'chosen-python'); writeFileSync(binary, '#!/bin/sh\nexit 0\n'); chmodSync(binary, 0o700);
  const expected = { python: binary, ipcModuleDirectory: join(exported, 'chosen-ipc'), metadataModuleDirectory: join(exported, 'chosen-metadata'), appPath: join(exported, 'Chosen.app') };
  writeFileSync(join(exported, 'config/desktop-bridge.json'), JSON.stringify(expected));
  const env = { ...process.env }; delete env.NAVIGATOR_BRIDGE_CONFIG;
  const node = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', 'import {readBridgeConfig} from "./server/bridge-config.mjs";console.log(JSON.stringify(readBridgeConfig()))'], { cwd: exported, env, encoding: 'utf8', timeout: 5000 }));
  const py = JSON.parse(execFileSync(python, ['-B', '-c', 'import sys,json;sys.path.insert(0,"bin");from bridge_config import load_bridge_config;print(json.dumps(load_bridge_config()))'], { cwd: exported, env, encoding: 'utf8', timeout: 5000 }));
  assert.deepEqual(node, expected); assert.deepEqual(py, expected);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeApp } from '../server/index.mjs';
import { readBridgeConfig } from '../server/bridge-config.mjs';

test('Node and Python use the same explicit machine config and never silently fall back', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-machine-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bridge.json'), config = { python: '/fixture/python', ipcModuleDirectory: '/fixture/ipc', appPath: '/fixture/Codex.app' };
  writeFileSync(path, JSON.stringify(config));
  assert.deepEqual(readBridgeConfig(path), config);
  const run = override => execFileSync('python3', ['-c', 'import json; from bridge_config import load_bridge_config; print(json.dumps(load_bridge_config()))'],
    { env: { ...process.env, PYTHONPATH: resolve('bin'), PYTHONDONTWRITEBYTECODE: '1', NAVIGATOR_BRIDGE_CONFIG: override }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(run(path)), config);
  for (const invalid of ['relative.json', join(dir, 'missing.json')]) {
    assert.throws(() => readBridgeConfig(invalid));
    assert.throws(() => run(invalid));
  }
});

test('each API reports its own machine identity for health and denied private requests', async t => {
  for (const machineId of ['ged', 'wandou']) {
    const dir = mkdtempSync(join(tmpdir(), 'pocket-machine-api-'));
    const app = makeApp({ machineId, dataDir: dir, readSource: () => ({ threads: [], projects: [], sourceInfo: {} }) });
    await new Promise(done => app.server.listen(0, '127.0.0.1', done));
    t.after(async () => { app.server.closeAllConnections(); await new Promise(done => app.server.close(done)); rmSync(dir, { recursive: true, force: true }); });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const health = await fetch(url + '/api/health');
    assert.equal(health.headers.get('X-Pocket-Machine'), machineId);
    assert.equal((await health.json()).machineId, machineId);
    const denied = await fetch(url + '/api/catalog');
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('X-Pocket-Machine'), machineId);
  }
  assert.throws(() => makeApp({ machineId: '../other' }), /machine ID/);
});

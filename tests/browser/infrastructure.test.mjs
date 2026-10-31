import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStaticHeaders } from './headers.mjs';
import { createHarness } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-browser-harness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function minimalBuild(directory) {
  writeFileSync(join(directory, 'pocket-version.json'), JSON.stringify({ id: 'a'.repeat(64), assets: [] }));
  writeFileSync(join(directory, '_headers'), "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'\n");
}
function oldResults(output) {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'results.json'), JSON.stringify({ status: 'passed', passed: true, scenarios: [{ name: 'OLD GREEN', passed: true }] }));
  writeFileSync(join(output, 'scenarios.json'), JSON.stringify({ scenarios: [{ name: 'OLD GREEN', passed: true }] }));
  writeFileSync(join(output, 'test.log'), 'OLD GREEN');
}
function failedResult(output, stage) {
  const text = readFileSync(join(output, 'results.json'), 'utf8'), result = JSON.parse(text);
  assert.equal(result.passed, false); assert.equal(result.stage, stage); assert.ok(result.startedAt && result.finishedAt);
  assert.doesNotMatch(text, /OLD GREEN/); assert.doesNotMatch(readFileSync(join(output, 'test.log'), 'utf8'), /OLD GREEN/);
  return result;
}

test('static response headers follow exact and wildcard build rules and reject unsupported syntax', () => {
  const headers = parseStaticHeaders("/*\n  Content-Security-Policy: default-src 'self'\n  X-Test: general\n/pocket-version.json\n  Cache-Control: no-store\n  X-Test: version\n");
  assert.deepEqual(headers('/'), { 'content-security-policy': "default-src 'self'", 'x-test': 'general' });
  assert.deepEqual(headers('/pocket-version.json'), { 'content-security-policy': "default-src 'self'", 'x-test': 'general, version', 'cache-control': 'no-store' });
  assert.equal(headers('/pocket-version.json.bak')['cache-control'], undefined);
  assert.throws(() => parseStaticHeaders('/*\n  ! Content-Security-Policy'), /Unsupported/);
  assert.throws(() => parseStaticHeaders('/:unsupported\n  Cache-Control: no-store'), /Unsupported/);
});

test('partial browser setup always closes resources already created', async t => {
  const directory = workspace(t); minimalBuild(directory);
  for (const stage of ['context', 'init', 'route']) {
    const closed = [];
    const context = { close: async () => closed.push('context'), addInitScript: async () => { if (stage === 'init') throw new Error('init failed'); }, route: async () => { throw new Error('route failed'); } };
    const browser = { close: async () => closed.push('browser'), newContext: async () => { if (stage === 'context') throw new Error('context failed'); return context; } };
    await assert.rejects(createHarness('chromium', { directory, launch: async () => browser }), new RegExp(stage + ' failed'));
    assert.deepEqual(closed, stage === 'context' ? ['browser'] : ['context', 'browser']);
  }
});

test('browser launch failure becomes a failed scenario in the current report', async () => {
  const recorded = [];
  await assert.rejects(runScenario({ engine: 'chromium', name: 'startup', create: async () => { throw new Error('browser unavailable'); },
    run: () => assert.fail('No scenario can run without its harness'), record: result => recorded.push(result) }), /browser unavailable/);
  assert.equal(recorded.length, 1); assert.equal(recorded[0].passed, false); assert.equal(recorded[0].requests, 0);
  assert.match(recorded[0].error, /browser unavailable/);
});

test('cleanup failure cannot leave a scenario marked as passing', async () => {
  const recorded = [];
  await assert.rejects(runScenario({ engine: 'chromium', name: 'cleanup', create: async () => ({ build: 'test', errors: [], unexpected: [], calls: [], close: async () => { throw new Error('cleanup failed'); } }),
    run: async () => {}, record: result => recorded.push(result) }), /cleanup failed/);
  assert.equal(recorded[0].passed, false); assert.match(recorded[0].error, /cleanup failed/);
});

test('manifest failure replaces previous green results and logs before any browser starts', t => {
  const directory = workspace(t), output = join(directory, 'output'); oldResults(output);
  const result = spawnSync(process.execPath, [runner], { env: { ...process.env, POCKET_BROWSER_OUTPUT: output, POCKET_BROWSER_DIST: directory }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.equal(failedResult(output, 'manifest').status, 'failed');
});

test('build exit and command startup failures both leave current failed reports', t => {
  const directory = workspace(t), bin = join(directory, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho synthetic-build-failed\nexit 17\n', { mode: 0o755 });
  for (const [name, path] of [['exit', bin], ['spawn', join(directory, 'missing-bin')]]) {
    const output = join(directory, name); oldResults(output);
    const result = spawnSync(process.execPath, [runner], { env: { ...process.env, PATH: path, POCKET_BROWSER_OUTPUT: output, POCKET_BROWSER_DIST: '' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(failedResult(output, 'build').status, 'failed');
  }
});

test('SIGTERM records interruption and terminates the runner-owned child', { skip: process.platform === 'win32' }, async t => {
  const directory = workspace(t), bin = join(directory, 'bin'), output = join(directory, 'output'), pidFile = join(directory, 'child.pid');
  mkdirSync(bin); oldResults(output);
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.POCKET_FAKE_PID, String(process.pid)); setInterval(() => {}, 1000);\n', { mode: 0o755 });
  const child = spawn(process.execPath, [runner], { env: { ...process.env, PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
    POCKET_BROWSER_OUTPUT: output, POCKET_BROWSER_DIST: '', POCKET_FAKE_PID: pidFile }, stdio: 'ignore' });
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('close', code => done(code)); });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(pidFile)) { if (Date.now() > deadline) throw new Error('Synthetic child did not start'); await new Promise(done => setTimeout(done, 20)); }
    const ownedPid = Number(readFileSync(pidFile)); child.kill('SIGTERM');
    assert.equal(await exited, 143); assert.equal(failedResult(output, 'build').status, 'interrupted');
    assert.throws(() => process.kill(ownedPid, 0), error => error.code === 'ESRCH');
  } finally { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } }
});

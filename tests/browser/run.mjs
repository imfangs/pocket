import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = resolve(root, process.env.POCKET_BROWSER_DIST || '.local/qa/browser-dist');
const output = resolve(root, process.env.POCKET_BROWSER_OUTPUT || '.local/qa/browser-smoke');
const reportPath = resolve(output, 'results.json'), scenarioPath = resolve(output, 'scenarios.json'), logPath = resolve(output, 'test.log');
mkdirSync(output, { recursive: true });
// Invalidate old green results before any build, manifest or browser work.
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', passed: false, stage: 'starting', dist, scenarios: [] };
const save = () => { writeFileSync(reportPath + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(reportPath + '.tmp', reportPath); };
save(); rmSync(scenarioPath, { force: true }); writeFileSync(logPath, '');
const log = (value, destination = process.stdout) => { destination.write(value); appendFileSync(logPath, value); };
let running, interrupted, forceTimer;
const terminate = (child, signal) => {
  if (!child?.pid) return;
  try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const interrupt = signal => {
  interrupted ||= signal;
  const child = running;
  terminate(child, 'SIGTERM');
  clearTimeout(forceTimer);
  if (child) forceTimer = setTimeout(() => { if (running === child) terminate(child, 'SIGKILL'); }, 2000).unref();
};
const onInterrupt = () => interrupt('SIGINT'), onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt); process.on('SIGTERM', onTerminate);
const command = (file, args, env = process.env) => new Promise((done, reject) => {
  if (interrupted) return reject(new Error(`Interrupted by ${interrupted}`));
  const child = spawn(file, args, { cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  running = child;
  child.stdout.on('data', chunk => log(chunk)); child.stderr.on('data', chunk => log(chunk, process.stderr));
  child.once('error', reject);
  child.once('close', (code, signal) => {
    clearTimeout(forceTimer); if (running === child) running = null;
    if (interrupted) reject(new Error(`Interrupted by ${interrupted}`));
    else done(code ?? (signal ? 1 : 0));
  });
});

try {
  if (!process.env.POCKET_BROWSER_DIST) {
    report.stage = 'build'; save();
    const code = await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '--', '--outDir', dist]);
    if (code) throw new Error(`Browser smoke build failed with exit code ${code}`);
  }
  report.stage = 'manifest'; save();
  const manifest = JSON.parse(readFileSync(resolve(dist, 'pocket-version.json')));
  if (!/^[a-f0-9]{64}$/.test(manifest.id)) throw new Error('POCKET_BROWSER_DIST must contain a Pocket production build');
  report.build = manifest.id; report.stage = 'tests'; save();
  log(`Browser smoke build: ${manifest.id}\n`);
  const files = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.test.mjs')).sort().map(name => fileURLToPath(new URL(name, import.meta.url)));
  const code = await command(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    ...process.env, POCKET_BROWSER_DIST: dist, POCKET_BROWSER_REPORT: scenarioPath,
  });
  try { report.scenarios = JSON.parse(readFileSync(scenarioPath)).scenarios; } catch { /* The command failure below remains authoritative. */ }
  if (code) throw new Error(`Browser smoke tests failed with exit code ${code}`);
  if (!report.scenarios.length || report.scenarios.some(result => result.passed !== true)) throw new Error('Browser smoke did not produce a complete passing scenario report');
  report.status = 'passed'; report.passed = true; report.stage = 'complete';
} catch (error) {
  report.status = interrupted ? 'interrupted' : 'failed'; report.passed = false; report.error = error.stack || String(error);
  try { report.scenarios = JSON.parse(readFileSync(scenarioPath)).scenarios; } catch { /* Build/setup failures may have no scenarios. */ }
  log(report.error + '\n', process.stderr);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted ? 143 : 1;
} finally {
  clearTimeout(forceTimer); process.off('SIGINT', onInterrupt); process.off('SIGTERM', onTerminate);
  report.finishedAt = new Date().toISOString(); save();
}

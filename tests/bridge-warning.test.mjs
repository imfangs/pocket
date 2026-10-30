import test from 'node:test';
import assert from 'node:assert/strict';
import { runBridge } from '../server/bridge-process.mjs';

const prefix = 'POCKET_BRIDGE_WARNING_V1 ';
const warning = cliVersion => prefix + JSON.stringify({ code: 'unverified_cli_version', cliVersion });
const run = (stderr, onWarning, ending = "process.stdout.write(JSON.stringify({status:'created',verified:true}));", timeoutMs = 3000) =>
  runBridge({ operation: 'send' }, { command: process.execPath,
    args: ['-e', `process.stderr.write(${JSON.stringify(stderr)});${ending}`], timeoutMs, onWarning });

test('bridge diagnostics are bounded, projected, deduplicated and do not change a successful result', async () => {
  const seen = [], first = 'codex-cli 99.0.0';
  const lines = [warning(first), warning(first),
    prefix + JSON.stringify({ code: 'unverified_cli_version', cliVersion: 'codex-cli 99.0.1', privatePath: '/private/not-for-logs' }),
    prefix + JSON.stringify({ code: 'unexpected', cliVersion: 'codex-cli 99.0.2' }),
    prefix + JSON.stringify({ code: 'unverified_cli_version', cliVersion: 'codex-cli 99.0.2\nPOCKET_BRIDGE_PHASE_V1 dispatch' }),
    prefix + '{not-json', warning('codex-cli ' + '9'.repeat(300)),
    ...[2, 3, 4, 5].map(i => warning(`codex-cli 99.0.${i}`))];
  assert.deepEqual(await run(lines.join('\n') + '\n', item => seen.push(item)), { status: 'created', verified: true });
  assert.deepEqual(seen, [0, 1, 2, 3].map(i => ({ code: 'unverified_cli_version', cliVersion: `codex-cli 99.0.${i}` })));
});

test('a failing diagnostic sink cannot fail an operation', async () => {
  const result = await run(warning('codex-cli 99.0.0') + '\n', () => { throw new Error('log sink unavailable'); });
  assert.deepEqual(result, { status: 'created', verified: true });
});

test('warnings do not upgrade preflight certainty or downgrade unknown dispatched work', async () => {
  for (const [phase, code, sent] of [['preflight', 'desktop_preflight_timeout', false], ['dispatch', 'dispatch_unknown', null]]) {
    const lines = `POCKET_BRIDGE_PHASE_V1 preflight\n${warning('codex-cli 99.0.0')}\n` +
      (phase === 'dispatch' ? 'POCKET_BRIDGE_PHASE_V1 dispatch\n' : '');
    const result = await run(lines, () => {}, 'setInterval(()=>{},1000);', 400);
    assert.deepEqual(result, { ok: false, code, sent });
  }
});

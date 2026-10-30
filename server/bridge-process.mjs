import { spawn } from 'node:child_process';

export function runBridge(payload, { command, args, timeoutMs,
  onWarning = warning => console.warn('POCKET_BRIDGE_WARNING_V1 ' + JSON.stringify(warning)) }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, settled = false, phase = null, tail = '', timedOut = false, started = false;
    let forceTimer, drainTimer;
    const warnedVersions = new Set();
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);clearTimeout(forceTimer);clearTimeout(drainTimer);
      resolve(result);
    };
    const uncertain = drained => ['history', 'model'].includes(payload.operation)
      ? { ok: false, code: 'desktop_unavailable', sent: false }
      : drained && phase === 'preflight'
        ? { ok: false, code: timedOut ? 'desktop_preflight_timeout' : 'desktop_unavailable', sent: false }
        : { ok: false, code: 'dispatch_unknown', sent: null };
    const terminate = () => {
      if (settled || drainTimer) return;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      // Without close/stdio drain, never claim that a write did not start.
      drainTimer = setTimeout(() => finish(uncertain(false)), 1000);
    };
    const timer = setTimeout(() => { timedOut = true;terminate(); }, timeoutMs);
    child.stderr.on('data', chunk => {
      tail += chunk.toString();
      const lines = tail.split('\n');tail = lines.pop().slice(-256);
      for (const line of lines) {
        if (line === 'POCKET_BRIDGE_PHASE_V1 preflight' && phase === null) phase = 'preflight';
        if (line === 'POCKET_BRIDGE_PHASE_V1 dispatch') phase = 'dispatch';
        if (line.startsWith('POCKET_BRIDGE_WARNING_V1 ') && line.length <= 256) {
          try {
            const warning = JSON.parse(line.slice('POCKET_BRIDGE_WARNING_V1 '.length));
            const version = warning?.cliVersion;
            if (warning?.code === 'unverified_cli_version' && typeof version === 'string' && version.length <= 160 &&
                /^codex-cli [0-9A-Za-z.+-]+$/.test(version) && !warnedVersions.has(version) && warnedVersions.size < 4) {
              warnedVersions.add(version);
              onWarning({ code: 'unverified_cli_version', cliVersion: version });
            }
          } catch { /* Diagnostics must never change request execution or its result. */ }
        }
      }
    });
    child.stderr.on('error', () => { phase = 'unknown'; });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) terminate();
      else chunks.push(chunk);
    });
    child.once('spawn', () => { started = true; });
    child.on('error', () => finish(started ? uncertain(false) : { ok: false, code: 'desktop_unavailable', sent: false }));
    child.stdin.on('error', () => {});
    // close fires after stdio drains: a marker written before the command cannot
    // be overtaken by a timeout and misclassified as safe to retry.
    child.on('close', () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(uncertain(true)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

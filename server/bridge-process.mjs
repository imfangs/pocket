import { spawn } from 'node:child_process';

export function runBridge(payload, { command, args, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, settled = false, phase = null, tail = '', timedOut = false, started = false;
    let forceTimer, drainTimer;
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

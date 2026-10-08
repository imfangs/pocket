import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const kinds = new Set(['running', 'waiting_input', 'waiting_approval', 'idle', 'unknown']);
const unavailable = checkedAt => ({ available: false, checkedAt, states: [] });

// Read the existing owner only; never open a task or start a turn.
export function readNativeTaskStatuses(payload, { signal } = {}) {
  return new Promise(resolve => {
    let config;
    try { config = JSON.parse(readFileSync(new URL('../config/desktop-bridge.json', import.meta.url), 'utf8')); }
    catch { resolve(unavailable(Date.now())); return; }
    const child = execFile(config.python, [fileURLToPath(new URL('../bin/task-statuses.py', import.meta.url))],
      { signal, timeout: 6500, maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) { resolve(unavailable(Date.now())); return; }
        try { resolve(JSON.parse(stdout)); } catch { resolve(unavailable(Date.now())); }
      });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

export class TaskStatusService {
  constructor({ codexHome, threads, excluded = () => [], read = readNativeTaskStatuses, now = Date.now, cacheMs = 8000 }) {
    Object.assign(this, { codexHome, threads, excluded, read, now, cacheMs });
    this.generation = 0; this.pending = null; this.cached = null; this.stopped = false;
  }
  targets() {
    const excluded = new Set(this.excluded());
    const threadIds = this.threads().filter(thread => !thread.archived && !thread.missing && !thread.separator && !excluded.has(thread.id)).map(thread => thread.id);
    return { threadIds, excludedThreadIds: [...excluded] };
  }
  publicResult(result, startedAt) {
    const now = this.now();
    if (this.stopped || result?.available !== true || !Number.isFinite(result.checkedAt) || result.checkedAt < startedAt - 1000 || result.checkedAt > now + 1000 || !Array.isArray(result.states)) return unavailable(now);
    const allowed = new Set(this.targets().threadIds), seen = new Set();
    const states = [];
    for (const row of result.states) {
      if (!row || !allowed.has(row.threadId) || seen.has(row.threadId)) continue;
      seen.add(row.threadId);
      const fresh = Number.isFinite(row.checkedAt) && row.checkedAt >= startedAt - 1000 && row.checkedAt <= now + 1000;
      states.push({ threadId: row.threadId, status: fresh && kinds.has(row.status) ? row.status : 'unknown', checkedAt: fresh ? row.checkedAt : now });
    }
    return { available: true, checkedAt: result.checkedAt, states };
  }
  snapshot() {
    if (this.stopped) return Promise.resolve(unavailable(this.now()));
    if (this.cached && this.now() - this.cached.receivedAt < this.cacheMs)
      return Promise.resolve(this.publicResult(this.cached.result, this.cached.startedAt));
    if (this.pending) return this.pending;
    const startedAt = this.now(), generation = this.generation, controller = new AbortController();
    this.controller = controller;
    const targets = this.targets();
    const pending = Promise.resolve().then(() => this.read({ codexHome: this.codexHome, ...targets }, { signal: controller.signal }))
      .then(result => {
        if (generation !== this.generation || this.stopped) return unavailable(this.now());
        const normalized = this.publicResult(result, startedAt);
        // Share failures too, so open clients cannot create a retry storm.
        this.cached = { result: normalized, receivedAt: this.now(), startedAt };
        return normalized;
      }, () => {
        const result = unavailable(this.now());
        if (generation === this.generation && !this.stopped) this.cached = { result, receivedAt: this.now(), startedAt };
        return result;
      }).finally(() => {
        if (this.pending === pending) { this.pending = null; this.controller = null; }
      });
    this.pending = pending;
    return pending;
  }
  invalidate() { this.generation++; this.cached = null; this.controller?.abort(); }
  stop() { this.stopped = true; this.invalidate(); }
}

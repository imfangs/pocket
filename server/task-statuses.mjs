import { readBridgeConfig } from "./bridge-config.mjs";
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const kinds = new Set(['running', 'waiting_input', 'waiting_approval', 'idle', 'unknown']);
const unavailable = checkedAt => ({ available: false, checkedAt, states: [] });
const MAX_PRIORITY_IDS = 32;
const PRIORITY_TTL_MS = 30000;
const threadIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function priorityIds(value) {
  // Hints are optional and cannot expand the eligible catalog or the read budget.
  const values = typeof value === 'string' && value.length <= 4096 ? value.split(',', MAX_PRIORITY_IDS)
    : Array.isArray(value) ? value.slice(0, MAX_PRIORITY_IDS) : [];
  return [...new Set(values.filter(id => typeof id === 'string' && threadIdPattern.test(id)).map(id => id.toLowerCase()))];
}

// Read the existing owner only; never open a task or start a turn.
export function readNativeTaskStatuses(payload, { signal } = {}) {
  return new Promise(resolve => {
    let config;
    try { config = readBridgeConfig(); }
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
    this.priorities = new Map(); this.rotation = 0;
  }
  targets() {
    const excluded = new Set(this.excluded());
    const threadIds = this.threads().filter(thread => !thread.sourceExcluded && !thread.archived && !thread.missing && !thread.separator && !excluded.has(thread.id)).map(thread => thread.id);
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
  rememberPriorities(value, threadIds, now) {
    const allowed = new Set(threadIds);
    for (const [id, at] of this.priorities) {
      if (!allowed.has(id) || now - at >= PRIORITY_TTL_MS || now < at) this.priorities.delete(id);
    }
    // Keep the client's most relevant ID first, and merge other open clients'
    // hints briefly. New hints never force a fresh read or split the shared cache.
    for (const id of priorityIds(value).reverse()) {
      if (!allowed.has(id)) continue;
      this.priorities.delete(id);
      this.priorities.set(id, now);
    }
    while (this.priorities.size > MAX_PRIORITY_IDS) this.priorities.delete(this.priorities.keys().next().value);
    return [...this.priorities.keys()].reverse();
  }
  snapshot({ priorityThreadIds } = {}) {
    if (this.stopped) return Promise.resolve(unavailable(this.now()));
    const requestedAt = this.now(), targets = this.targets();
    const priorities = this.rememberPriorities(priorityThreadIds, targets.threadIds, requestedAt);
    if (this.cached && requestedAt - this.cached.receivedAt < this.cacheMs)
      return Promise.resolve(this.publicResult(this.cached.result, this.cached.startedAt));
    if (this.pending) return this.pending;
    const startedAt = requestedAt, generation = this.generation, controller = new AbortController();
    this.controller = controller;
    const rotation = this.rotation;
    this.rotation = (rotation + 1) % 2147483648;
    const pending = Promise.resolve().then(() => this.read({ codexHome: this.codexHome, ...targets,
      priorityThreadIds: priorities, rotation }, { signal: controller.signal }))
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
  stop() { this.stopped = true; this.priorities.clear(); this.invalidate(); }
}

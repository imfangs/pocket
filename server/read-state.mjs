import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError } from './store.mjs';
import { readHistorySourceVersion } from './history.mjs';
import { readLocalReadStateSnapshot } from './unread.mjs';
import { runBridge } from './bridge-process.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => !!a && !!b && ['sourceVersion', 'identityKey', 'executionHostKey'].every(key => a[key] === b[key]);
const snapshotKey = (id, value) => hash(JSON.stringify([id, value.sourceVersion, value.identityKey, value.executionHostKey]));
const statuses = new Set(['read', 'stale', 'unavailable', 'unknown']);

export async function writeNativeReadState(payload) {
  const config = JSON.parse(readFileSync(new URL('../config/desktop-bridge.json', import.meta.url), 'utf8'));
  const result = await runBridge({ ...payload, operation: 'mark-read' }, {
    command: config.python,
    args: [fileURLToPath(new URL('../bin/read-state.py', import.meta.url))], timeoutMs: 12000,
  });
  return statuses.has(result.status) ? result : {
    status: result.sent === false ? 'unavailable' : 'unknown',
    code: result.sent === false ? 'desktop_unavailable' : 'read_outcome_unknown',
  };
}

export class ReadStateService {
  constructor(store, codexHome, options = {}) {
    this.store = store;
    this.codexHome = codexHome;
    this.readSnapshot = options.readSnapshot || (id => ({
      sourceVersion: readHistorySourceVersion(codexHome, id), ...readLocalReadStateSnapshot(codexHome, id),
    }));
    this.write = options.write || writeNativeReadState;
    this.now = options.now || Date.now;
    this.observationTtlMs = options.observationTtlMs ?? 120000;
    this.observations = new Map();
    this.pending = new Map();
    store.db.exec('CREATE TABLE IF NOT EXISTS read_state_receipts(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,observation_hash TEXT NOT NULL,observation_key TEXT,status TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL)');
    if (!store.db.prepare('PRAGMA table_info(read_state_receipts)').all().some(row => row.name === 'observation_key'))
      store.db.exec('ALTER TABLE read_state_receipts ADD COLUMN observation_key TEXT');
    store.db.exec("UPDATE read_state_receipts SET status='unknown',code='read_interrupted' WHERE status='pending'");
  }
  observeTranscript(id, readTranscript) {
    const thread = this.store.thread(id);
    let before;
    try { before = this.readSnapshot(id); } catch { /* Reading remains available without the setter. */ }
    const data = readTranscript();
    const last = data.messages?.at(-1);
    if (!before || before.unread !== true || !last?.id || !last.text || thread.archived || thread.missing ||
      !['completed', 'interrupted'].includes(data.turnTiming?.status)) return { ...data, readObservation: null };
    let after;
    try { after = this.readSnapshot(id); } catch { return { ...data, readObservation: null }; }
    if (!same(before, after) || after.unread !== true) return { ...data, readObservation: null };
    const now = this.now();
    for (const [token, entry] of this.observations) if (entry.expiresAt <= now) this.observations.delete(token);
    const visibleVersion = hash(JSON.stringify([last.id, last.role, last.text]));
    const token = randomBytes(24).toString('base64url');
    this.observations.set(token, { threadId: id, expected: after, visibleVersion, expiresAt: now + this.observationTtlMs });
    if (this.observations.size > 500) this.observations.delete(this.observations.keys().next().value);
    return { ...data, readObservation: { token, lastVisibleItemId: last.id, visibleVersion } };
  }
  receipt(row) { return { requestId: row.id, status: row.status, ...(row.code ? { code: row.code } : {}) }; }
  reconcileUnknown(row) {
    if (row.status !== 'unknown' || !row.observation_key) return row;
    try {
      const current = this.readSnapshot(row.thread_id);
      if (current.unread === false && snapshotKey(row.thread_id, current) === row.observation_key) {
        this.store.db.prepare("UPDATE read_state_receipts SET status='read',code=NULL WHERE id=?").run(row.id);
        return { ...row, status: 'read', code: null };
      }
    } catch { /* A later read may resolve an unknown outcome without writing again. */ }
    return row;
  }
  async markRead(id, input) {
    this.store.thread(id);
    if (!input || Object.keys(input).some(key => !['requestId', 'observationToken'].includes(key)) ||
      typeof input.requestId !== 'string' || !uuid.test(input.requestId) ||
      typeof input.observationToken !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(input.observationToken))
      throw new AppError('需要有效的阅读观察和请求编号', 400);
    const observationHash = hash(input.observationToken);
    const old = this.store.db.prepare('SELECT * FROM read_state_receipts WHERE id=?').get(input.requestId);
    if (old) {
      if (old.thread_id !== id || old.observation_hash !== observationHash) throw new AppError('请求编号已用于另一条阅读操作', 409);
      const pending = this.pending.get(id);
      if (pending?.requestId === input.requestId) return pending.promise;
      return this.receipt(this.reconcileUnknown(old));
    }
    const observed = this.observations.get(input.observationToken);
    const save = result => {
      this.store.db.prepare('INSERT INTO read_state_receipts(id,thread_id,observation_hash,observation_key,status,code,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(input.requestId, id, observationHash, observed ? snapshotKey(id, observed.expected) : null, result.status, result.code || null, this.now());
      return { requestId: input.requestId, ...result };
    };
    if (this.pending.has(id)) return save({ status: 'unavailable', code: 'read_in_progress' });
    const unresolved = this.store.db.prepare("SELECT * FROM read_state_receipts WHERE observation_hash=? AND status IN('pending','unknown') LIMIT 1").get(observationHash);
    if (unresolved) {
      const resolved = this.reconcileUnknown(unresolved);
      return save(resolved.status === 'read' ? { status: 'read' } : { status: 'unknown', code: 'read_outcome_unknown' });
    }
    const thread = this.store.thread(id);
    if (!observed || observed.threadId !== id || observed.expiresAt <= this.now() || thread.archived || thread.missing)
      return save({ status: 'stale', code: 'observation_expired' });
    let current;
    try { current = this.readSnapshot(id); } catch { return save({ status: 'unavailable', code: 'read_state_unavailable' }); }
    if (!same(observed.expected, current)) return save({ status: 'stale', code: 'observation_changed' });
    if (current.unread === false) return save({ status: 'read' });
    save({ status: 'pending' });
    const promise = Promise.resolve().then(async () => {
      let result;
      try { result = await this.write({ threadId: id, requestId: input.requestId, codexHome: this.codexHome,
        expected: { sourceVersion: current.sourceVersion, identityKey: current.identityKey, executionHostKey: current.executionHostKey } }); }
      catch { result = { status: 'unknown', code: 'read_outcome_unknown' }; }
      if (!statuses.has(result?.status)) result = { status: 'unknown', code: 'read_outcome_unknown' };
      if (result.status === 'read' || result.status === 'unknown') {
        try {
          const after = this.readSnapshot(id);
          if (!same(current, after)) result = { status: 'unknown', code: 'observation_changed_after_write' };
          else if (after.unread === false) result = { status: 'read' };
          else result = { status: 'unknown', code: result.code || 'readback_mismatch' };
        } catch { result = { status: 'unknown', code: 'readback_unavailable' }; }
      }
      const code = typeof result.code === 'string' && /^[a-z_]{1,80}$/.test(result.code) ? result.code : null;
      this.store.db.prepare('UPDATE read_state_receipts SET status=?,code=? WHERE id=?').run(result.status, code, input.requestId);
      return { requestId: input.requestId, status: result.status, ...(code ? { code } : {}) };
    }).finally(() => { if (this.pending.get(id)?.requestId === input.requestId) this.pending.delete(id); });
    this.pending.set(id, { requestId: input.requestId, promise });
    return promise;
  }
}

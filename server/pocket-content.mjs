import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// Private, in-process evidence. Symbols survive object spread but never enter
// JSON responses, the catalog's stored source JSON, or the browser cache.
export const POCKET_CONTENT = Symbol('pocket-content-evidence');
export const DESKTOP_READ = Symbol('pocket-desktop-read-evidence');
export const DESKTOP_READ_SETTLE_MS = 2000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const EMPTY_CONTENT_VERSION = hash(['pocket-assistant-content-v1', null]);
export const assistantContentVersion = (id, text, phase) =>
  hash(['pocket-assistant-content-v1', id, text, phase ?? null]);
export const contentFileVersion = stat =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String).join(':');
let observationSequence = 0;
export const contentEvidence = (candidate, file, version) => ({ ...candidate,
  source: { file, version, order: ++observationSequence } });

export function contentSourceIsCurrent(candidate) {
  if (!candidate?.source?.file || !candidate.source.version) return false;
  try {
    const stat = statSync(candidate.source.file, { bigint: true });
    return stat.isFile() && contentFileVersion(stat) === candidate.source.version;
  } catch { return false; }
}

function sourceIdentity(codexHome) {
  let path;
  try { path = realpathSync(codexHome); } catch { path = resolve(codexHome); }
  return hash(['pocket-codex-source-v1', path]);
}

// This ledger versions source content, not user reading. It never stores text,
// calls Codex setters, or changes send/approval authority.
export class PocketContentService {
  constructor(store, codexHome, options = {}) {
    this.store = store;
    this.isCurrent = options.isCurrent || contentSourceIsCurrent;
    this.now = options.now || Date.now;
    this.desktopReadCandidates = new Map();
    this.observedOrder = new Map();
    const identity = sourceIdentity(codexHome);
    const saved = store.setting('pocketContentSource');
    this.scope = saved?.identity === identity && typeof saved.scope === 'string'
      ? saved.scope : randomUUID();
    if (this.scope !== saved?.scope) store.set('pocketContentSource', { identity, scope: this.scope });
    store.db.exec(`CREATE TABLE IF NOT EXISTS pocket_content(
      scope TEXT NOT NULL, thread_id TEXT NOT NULL, version TEXT NOT NULL,
      revision INTEGER NOT NULL, message_id TEXT, available INTEGER NOT NULL,
      PRIMARY KEY(scope,thread_id))`);
    this.get = store.db.prepare('SELECT * FROM pocket_content WHERE scope=? AND thread_id=?');
    this.upsert = store.db.prepare(`INSERT INTO pocket_content VALUES(?,?,?,?,?,1)
      ON CONFLICT(scope,thread_id) DO UPDATE SET version=excluded.version,
      revision=excluded.revision,message_id=excluded.message_id,available=1`);
    this.unavailable = store.db.prepare('UPDATE pocket_content SET available=0 WHERE scope=? AND thread_id=? AND available<>0');
  }
  public(row) {
    return row?.available ? { scope: this.scope, revision: row.revision, version: row.version,
      messageId: row.message_id, known: true } : { known: false };
  }
  observe(id, candidate) {
    const order = candidate?.source?.order;
    // An old source path can remain intact after the thread has moved to a
    // newer rollout. File equality alone cannot make that late read current.
    if (Number.isSafeInteger(order) && order < (this.observedOrder.get(id) ?? 0)) return { known: false };
    if (Number.isSafeInteger(order)) this.observedOrder.set(id, order);
    if (candidate?.known !== true || typeof candidate.version !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.version) ||
      !(candidate.messageId === null || typeof candidate.messageId === 'string' && candidate.messageId.length > 0) ||
      !this.isCurrent(candidate)) {
      this.unavailable.run(this.scope, id);
      return { known: false };
    }
    const previous = this.get.get(this.scope, id);
    if (previous?.version === candidate.version && previous.message_id === candidate.messageId) {
      if (!previous.available) this.upsert.run(this.scope, id, previous.version, previous.revision, previous.message_id);
      return this.public({ ...previous, available: 1 });
    }
    const revision = (previous?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Pocket content revision exhausted');
    this.upsert.run(this.scope, id, candidate.version, revision, candidate.messageId);
    return this.public({ version: candidate.version, revision, message_id: candidate.messageId, available: 1 });
  }
  source(data) {
    // Keep reading and registration synchronous: a queued/slow old snapshot
    // must be rejected by its file evidence, never assigned a newer revision.
    const present = new Set(data.threads.map(thread => thread.id));
    for (const id of this.desktopReadCandidates.keys()) if (!present.has(id)) this.desktopReadCandidates.delete(id);
    const threads = data.threads.map(thread => {
      const candidate = thread[POCKET_CONTENT];
      const pocketContent = this.observe(thread.id, candidate);
      // A serialized/previous source object cannot carry read authority into
      // this scan. Only this fresh, private observation may create a hint.
      const { desktopReadContent: ignored, ...rest } = thread;
      const hint = this.desktopReadHint(thread, candidate, pocketContent);
      return { ...rest, pocketContent, ...(hint ? { desktopReadContent: hint } : {}) };
    });
    // Candidates contain no body text and have the same bound as tail caches.
    while (this.desktopReadCandidates.size > 4096) this.desktopReadCandidates.delete(this.desktopReadCandidates.keys().next().value);
    return { ...data, threads, sourceInfo: { ...data.sourceInfo, pocketRead: { available: true, scope: this.scope } } };
  }
  desktopReadHint(thread, candidate, content) {
    const prior = this.desktopReadCandidates.get(thread.id);
    const source = candidate?.source;
    if (!content.known || content.messageId === null || thread[DESKTOP_READ] !== true ||
      thread.hasUnreadTurn !== false || candidate.turnState !== 'ended' || !Number.isSafeInteger(source?.order)) {
      this.desktopReadCandidates.delete(thread.id);
      return null;
    }
    // A final reply may land before the desktop's unread notification. Two
    // independent settled observations reduce that persistence race; the
    // native boolean is still a hint, not a per-message reading receipt.
    const same = prior && prior.revision === content.revision && prior.version === content.version &&
      prior.messageId === content.messageId && prior.file === source.file && prior.fileVersion === source.version;
    if (!same) {
      this.desktopReadCandidates.set(thread.id, { ...content, file: source.file, fileVersion: source.version,
        order: source.order, since: this.now(), confirmed: false });
      return null;
    }
    if (source.order <= prior.order) return null;
    prior.order = source.order;
    if (this.now() - prior.since < DESKTOP_READ_SETTLE_MS) return null;
    prior.confirmed = true;
    return content;
  }
  readConfirmationDelay() {
    const pending = [...this.desktopReadCandidates.values()].filter(candidate => !candidate.confirmed);
    return pending.length ? Math.max(0, Math.min(DESKTOP_READ_SETTLE_MS,
      Math.max(...pending.map(candidate => candidate.since + DESKTOP_READ_SETTLE_MS - this.now())))) : null;
  }
  sourceUnavailable() {
    // Recovery must establish two fresh observations; an outage does not
    // count as time spent observing a stable desktop read state.
    this.desktopReadCandidates.clear();
  }
  catalog(data) {
    const rows = this.store.db.prepare('SELECT * FROM pocket_content WHERE scope=?').all(this.scope);
    const byId = new Map(rows.map(row => [row.thread_id, row]));
    return { ...data, threads: data.threads.map(thread => ({ ...thread, pocketContent: this.public(byId.get(thread.id)) })),
      sourceInfo: { ...data.sourceInfo, pocketRead: { available: true, scope: this.scope } } };
  }
  transcript(id, data) {
    const candidate = data[POCKET_CONTENT];
    const content = this.observe(id, candidate);
    const target = data.messages?.findLast(message => message.role === 'assistant');
    const readable = content.known && content.messageId !== null && candidate.readable === true &&
      target?.id === content.messageId && target.text && !target.truncated &&
      assistantContentVersion(target.id, target.text, target.phase) === content.version;
    return { ...data, pocketContent: readable ? content : { known: false } };
  }
}

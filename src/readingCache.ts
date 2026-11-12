import type { Catalog, Group, PocketContent, Project, Thread } from "./types";
import { hiddenFields } from "./hiddenThreads.ts";
import type { Message, SavedTranscript } from "./conversationFeed";
import { turnFailures } from "./turnFailures.ts";
import {
  clearReadingCache, createReadingCacheStorage, readingCacheFence, readingCacheKey, readingCacheLimits, mergeReadingCatalogRecords,
  subscribeReadingCacheInvalidation, type ReadingCacheRecord, type ReadingCacheStorage,
} from "./readingCacheStorage.ts";

export { clearReadingCache, readingCacheLimits, subscribeReadingCacheInvalidation, trimReadingCache } from "./readingCacheStorage.ts";
export type ReadingSnapshot<T> = { value: T; scope: string; savedAt: number };
const string = (value: unknown): value is string => typeof value === "string";
const identity = (value: unknown): value is string => string(value) && value.length > 0 && value.length <= 512;
const finite = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown) => Array.isArray(value) && value.every(string) ? [...value] : [];
function content(value: unknown, scope: string): PocketContent | undefined {
  if (!object(value) || value.known !== true || value.scope !== scope || !Number.isSafeInteger(value.revision) ||
      (value.revision as number) <= 0 || !string(value.version) || !/^[a-f0-9]{64}$/.test(value.version) ||
      value.messageId !== null && !identity(value.messageId)) return undefined;
  return { known: true, scope, revision: value.revision as number, version: value.version, messageId: value.messageId as string | null };
}
export function readingCatalogScope(value: Catalog): string | null {
  const supplied = value?.sourceInfo?.pocketRead?.scope;
  if (identity(supplied)) return supplied;
  const scopes = new Set((Array.isArray(value?.threads) ? value.threads : []).map(thread => thread?.pocketContent?.scope).filter(identity));
  return scopes.size === 1 ? [...scopes][0] : null;
}

// Deliberate allowlists: credentials, desktop read hints, control state, private
// notes, upload/file capabilities and observation tokens cannot enter the DTO.
function sanitizeCatalog(value: unknown, scope: string): Catalog | null {
  if (!object(value) || !Array.isArray(value.threads) || !Array.isArray(value.groups) || !Array.isArray(value.projects)) return null;
  const threads: Thread[] = [];
  for (const item of value.threads) {
    if (!object(item) || !identity(item.id) || !string(item.title) || !string(item.cwd)) return null;
    threads.push({
      id: item.id, hostId: string(item.hostId) ? item.hostId : "", title: item.title,
      titleRevision: finite(item.titleRevision), cwd: item.cwd, projectId: string(item.projectId) ? item.projectId : null,
      projectName: string(item.projectName) ? item.projectName : "", archived: item.archived === true,
      pinned: item.pinned === true, pinnedOrder: finite(item.pinnedOrder), pinRevision: finite(item.pinRevision),
      ...(item.pinSource === "pocket" || item.pinSource === "codex" ? { pinSource: item.pinSource } : {}),
      codexPinned: item.codexPinned === true, pocketPriority: item.pocketPriority === true,
      ...hiddenFields(item),
      separator: item.separator === true, source: string(item.source) ? item.source : "", createdAt: finite(item.createdAt),
      updatedAt: finite(item.updatedAt), lastMessageAt: typeof item.lastMessageAt === "number" ? finite(item.lastMessageAt) : null,
      branch: string(item.branch) ? item.branch : null, missing: item.missing === true, sourceExcluded: item.sourceExcluded === true,
      intent: ["active", "later", "reference"].includes(item.intent as string) ? item.intent as Thread["intent"] : "none",
      note: "", reviewAt: string(item.reviewAt) ? item.reviewAt : null, groupIds: strings(item.groupIds),
      lastOpenedAt: typeof item.lastOpenedAt === "number" ? finite(item.lastOpenedAt) : null, revision: finite(item.revision),
      ...(content(item.pocketContent, scope) ? { pocketContent: content(item.pocketContent, scope) } : {}),
    });
  }
  const groups: Group[] = [], projects: Project[] = [];
  for (const item of value.groups) {
    if (!object(item) || !identity(item.id) || !string(item.name)) return null;
    groups.push({ id: item.id, name: item.name, parentId: string(item.parentId) ? item.parentId : null,
      color: string(item.color) ? item.color : "", position: finite(item.position), sourceProjectId: string(item.sourceProjectId) ? item.sourceProjectId : null });
  }
  for (const item of value.projects) {
    if (!object(item) || !identity(item.id) || !string(item.name)) return null;
    projects.push({ id: item.id, name: item.name, paths: strings(item.paths), order: finite(item.order), separator: item.separator === true });
  }
  const info = object(value.sourceInfo) ? value.sourceInfo : {};
  return { threads, groups, projects, excludedThreadIds: strings(value.excludedThreadIds),
    excludedThreadStates: Array.isArray(value.excludedThreadStates) ? value.excludedThreadStates.flatMap(item =>
      object(item) && identity(item.id) ? [{ id: item.id, archived: item.archived === true }] : []) : [],
    sourceInfo: { syncedAt: finite(info.syncedAt), active: finite(info.active), archived: finite(info.archived), total: finite(info.total),
      scope: string(info.scope) ? info.scope : "", pocketRead: { available: true, scope } }, sourceError: null };
}
function sanitizeTranscript(value: unknown, scope: string): SavedTranscript | null {
  if (!object(value) || !Array.isArray(value.messages)) return null;
  const messages: Message[] = [];
  for (const item of value.messages) {
    if (!object(item) || !identity(item.id) || !["user", "assistant"].includes(item.role as string) || !string(item.text)) return null;
    messages.push({ id: item.id, role: item.role as Message["role"], text: item.text,
      ...(identity(item.turnId) ? { turnId: item.turnId } : {}), ...(string(item.phase) ? { phase: item.phase } : {}),
      ...(item.isQuestion === true ? { isQuestion: true } : {}), ...(item.truncated === true ? { truncated: true } : {}),
      ...(typeof item.timestamp === "number" ? { timestamp: finite(item.timestamp) } : {}),
      ...(typeof item.turnDurationMs === "number" ? { turnDurationMs: finite(item.turnDurationMs) } : {}),
      ...(identity(item.clientMessageId) ? { clientMessageId: item.clientMessageId } : {}),
      ...(item.role === "user" && item.origin === "codex_delegation" ? { origin: "codex_delegation" as const } : {}),
      ...(item.role === "user" && item.attachmentEnvelope === true ? { attachmentEnvelope: true } : {}),
    });
  }
  const failures = turnFailures(value.turnFailures);
  return { source: "rollout", messages, hasMore: value.hasMore === true, checkedAt: finite(value.checkedAt),
    ...(failures.length ? { turnFailures: failures } : {}),
    ...(content(value.pocketContent, scope) ? { pocketContent: content(value.pocketContent, scope) } : {}) };
}

type Options = { storage?: ReadingCacheStorage | null; now?: () => number };
export function createReadingCache({ storage, now = Date.now }: Options = {}) {
  const memory = new Map<string, ReadingCacheRecord>(), pending = new Map<string, ReadingCacheRecord>();
  const revoked = new Set<string>(), observedFences = new Map<string, string | null>();
  let disposed = false, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let disk: ReadingCacheStorage | null | undefined = storage, writing: Promise<void> | null = null;
  const currentFence = (machine: string) => {
    const fence = readingCacheFence(machine);
    if (observedFences.has(machine) && observedFences.get(machine) !== fence) revoke(machine);
    else observedFences.set(machine, fence);
    return fence;
  };
  const revoke = (machine?: string) => {
    generation++;
    if (machine) revoked.add(machine); else disposed = true;
    for (const [key, record] of memory) if (!machine || record.machine === machine) memory.delete(key);
    for (const [key, record] of pending) if (!machine || record.machine === machine) pending.delete(key);
  };
  const unsubscribe = subscribeReadingCacheInvalidation(event => revoke(event.machine ?? undefined));
  const available = (machine: string) => !disposed && identity(machine) && !revoked.has(machine);
  const getDisk = () => disk === undefined ? disk = createReadingCacheStorage() : disk;
  const valid = (record: ReadingCacheRecord, machine: string) => record.schema === 1 && record.machine === machine &&
    identity(record.scope) && record.key === readingCacheKey(record.machine, record.scope, record.kind, record.threadId) &&
    record.savedAt <= now() + 60000 && record.savedAt > now() - readingCacheLimits.ttlMs &&
    string(record.json) && record.json.length * 2 <= readingCacheLimits.memoryBytes && record.fence === currentFence(machine);
  const memoryWeight = (record: ReadingCacheRecord) => record.json.length * 2 + record.key.length * 2 + 512;
  const prune = () => {
    let bytes = 0, transcripts = 0, catalogs = 0;
    const records = [...memory.values()].reverse().sort((a, b) => b.accessedAt - a.accessedAt);
    for (const record of records) {
      const weight = memoryWeight(record), fitsCount = record.kind === "transcript" ? transcripts < readingCacheLimits.memoryTranscripts : catalogs < readingCacheLimits.catalogs;
      if (!fitsCount || bytes + weight > readingCacheLimits.memoryBytes || record.savedAt <= now() - readingCacheLimits.ttlMs) memory.delete(record.key);
      else { bytes += weight; if (record.kind === "transcript") transcripts++; else catalogs++; }
    }
    // Pending writes share the same immutable records as L1; do not retain an
    // unbounded second cache when many conversations arrive before the debounce.
    for (const key of pending.keys()) if (!memory.has(key)) pending.delete(key);
  };
  const flush = (): Promise<void> => {
    clearTimeout(timer); timer = undefined;
    // While IDB is busy keep only each key's latest pending value. Do not queue
    // another captured batch for every streaming timer or visibility flush.
    if (writing) return writing;
    if (disposed || !pending.size) return Promise.resolve();
    writing = (async () => {
      while (!disposed && pending.size) {
        const ticket = generation, batch = [...pending.values()]; pending.clear();
        const records = batch.filter(record => available(record.machine) && record.fence === currentFence(record.machine));
        if (ticket !== generation || !records.length) continue;
        try { await getDisk()?.write(records, now()); } catch { disk?.close(); disk = null; pending.clear(); }
      }
    })().finally(() => { writing = null; });
    return writing;
  };
  const schedule = (record: ReadingCacheRecord, touch = false) => {
    if (record.fence === "memory-only" || !record.fence || disk === null) return;
    // A read during an unflushed update must not downgrade that fresh body to
    // a metadata-only touch. Otherwise touches never carry replacement rights.
    if (touch && pending.has(record.key) && !pending.get(record.key)!.touch) return;
    pending.set(record.key, touch ? { ...record, touch: true } : record);
    if (!timer) timer = setTimeout(() => { void flush(); }, readingCacheLimits.writeDelayMs);
  };
  const remember = (machine: string, scope: string, kind: ReadingCacheRecord["kind"], threadId: string, value: unknown) => {
    if (!available(machine) || !identity(scope) || kind === "transcript" && !identity(threadId)) return false;
    const fence = currentFence(machine);
    if (!available(machine)) return false;
    try {
      const clean = kind === "catalog" ? sanitizeCatalog(value, scope) : sanitizeTranscript(value, scope);
      if (!clean) return false;
      const transcript = clean as SavedTranscript, catalog = clean as Catalog;
      const observedAt = kind === "transcript" ? transcript.checkedAt : catalog.sourceInfo!.syncedAt;
      // Observation headers change on a 304 without changing readable content.
      // Keep that timestamp outside the stable body, and restore it on decode.
      const json = JSON.stringify(kind === "transcript" ? { ...transcript, checkedAt: 0 }
        : { ...catalog, sourceInfo: { ...catalog.sourceInfo, syncedAt: 0 } });
      const key = readingCacheKey(machine, scope, kind, threadId);
      let record: ReadingCacheRecord = { schema: 1, key, machine, scope, kind, threadId, savedAt: now(), accessedAt: now(),
        bytes: new TextEncoder().encode(json).byteLength + key.length * 2 + 512, json, fence: fence ?? "memory-only",
        observedAt, contentRevision: kind === "transcript" ? transcript.pocketContent?.revision ?? 0 : 0 };
      if (memoryWeight(record) > readingCacheLimits.memoryBytes || record.bytes > readingCacheLimits.diskBytes) return false;
      const previous = memory.get(key);
      if (previous) record = mergeReadingCatalogRecords(record, previous);
      if (record === previous) return false;
      if (memoryWeight(record) > readingCacheLimits.memoryBytes || record.bytes > readingCacheLimits.diskBytes) {
        memory.delete(key); pending.delete(key); return false;
      }
      const sameBody = previous?.json === record.json;
      const deferUnchanged = sameBody && record.savedAt - previous.savedAt < readingCacheLimits.validationRefreshMs;
      if (deferUnchanged) record.savedAt = previous.savedAt;
      if (kind === "catalog") for (const [oldKey, old] of memory) {
        if (old.kind === "catalog" && old.machine === machine && oldKey !== key) { memory.delete(oldKey); pending.delete(oldKey); }
      }
      memory.delete(key); memory.set(key, record); prune();
      if (memory.has(key)) {
        if (!deferUnchanged) schedule(record);
        else if (pending.has(key) && !pending.get(key)!.touch) pending.set(key, record);
      }
      return true;
    } catch { return false; }
  };
  const decode = <T extends Catalog | SavedTranscript>(record: ReadingCacheRecord, machine: string): ReadingSnapshot<T> | null => {
    if (record.fence === "memory-only" ? !available(machine) || record.savedAt <= now() - readingCacheLimits.ttlMs : !valid(record, machine)) return null;
    try {
      const raw = JSON.parse(record.json);
      if (record.observedAt !== undefined) {
        if (record.kind === "catalog" && object(raw.sourceInfo)) raw.sourceInfo.syncedAt = record.observedAt;
        else if (record.kind === "transcript") raw.checkedAt = record.observedAt;
      }
      const value = record.kind === "catalog" ? sanitizeCatalog(raw, record.scope) : sanitizeTranscript(raw, record.scope);
      return value ? { value: value as T, scope: record.scope, savedAt: record.savedAt } : null;
    } catch { return null; }
  };
  const load = async <T extends Catalog | SavedTranscript>(machine: string, scope?: string, threadId?: string): Promise<ReadingSnapshot<T> | null> => {
    if (!available(machine)) return null;
    const fence = currentFence(machine), ticket = generation;
    if (!available(machine)) return null;
    const key = scope && threadId ? readingCacheKey(machine, scope, "transcript", threadId) : null;
    const remembered = () => key ? memory.get(key) : [...memory.values()].filter(item => item.machine === machine && item.kind === "catalog")
      .sort((a, b) => b.savedAt - a.savedAt)[0];
    const current = () => available(machine) && ticket === generation && currentFence(machine) === fence;
    const adopt = (record: ReadingCacheRecord, touch = true): ReadingSnapshot<T> | null => {
      if (memoryWeight(record) > readingCacheLimits.memoryBytes || record.bytes > readingCacheLimits.diskBytes) {
        memory.delete(record.key); pending.delete(record.key); return null;
      }
      const snapshot = decode<T>(record, machine);
      if (!snapshot) { memory.delete(record.key); return null; }
      record = { ...record, accessedAt: now() };
      if (!key) for (const [otherKey, other] of memory) {
        if (other.machine === machine && other.kind === "catalog" && otherKey !== record.key) { memory.delete(otherKey); pending.delete(otherKey); }
      }
      memory.delete(record.key); memory.set(record.key, record); prune(); schedule(record, touch);
      return snapshot;
    };
    let record = remembered();
    const initialCatalogScope = !key && record && decode<T>(record, machine) ? record.scope : undefined;
    if (record) {
      // IDB epochs cover tabs whose broadcast/storage notifications were lost,
      // including readable-but-unwritable localStorage. This reads metadata only.
      if (disk?.isCurrent) {
        try { if (!await disk.isCurrent(machine)) { revoke(machine); return null; } }
        catch { disk?.close(); disk = null; }
        if (!current()) return null;
        record = remembered();
      }
    }
    // Catalogs may receive independent preference writes from another tab.
    // Reconcile that small stored projection on load; transcript hot reads keep
    // their original memory-only path after the epoch check above.
    if (record && (key || fence === null || disk === null)) {
      const snapshot = adopt(record);
      if (snapshot) return snapshot;
    }
    if (fence === null) return null;
    try {
      const stored = (await (key ? getDisk()?.transcript(key, machine) : getDisk()?.catalog(machine))) ?? undefined;
      if (!current()) return null;
      const diskRecord = stored && (key ? stored.key === key : stored.kind === "catalog") && decode<T>(stored, machine) ? stored : undefined;
      // A network result may have populated L1 while the disk read was pending.
      const latest = remembered(), liveRecord = latest && decode<T>(latest, machine) ? latest : undefined;
      if (liveRecord && initialCatalogScope === liveRecord.scope && diskRecord && diskRecord.scope !== liveRecord.scope)
        return adopt(liveRecord);
      record = diskRecord && liveRecord ? mergeReadingCatalogRecords(liveRecord, diskRecord) : diskRecord ?? liveRecord;
      if (!record) return null;
      // A merged preference projection can carry new metadata even when its
      // body/timestamps came from disk. A plain LRU read cannot recreate an
      // evicted entry; pending new bodies still retain their scheduled write.
      const changedMetadata = !key && diskRecord?.key === record.key && diskRecord.json !== record.json;
      return adopt(record, !changedMetadata);
    } catch {
      disk?.close(); disk = null;
      if (!current()) return null;
      const fallback = remembered();
      return fallback ? adopt(fallback) : null;
    }
  };
  return {
    loadCatalog: (machine: string) => load<Catalog>(machine),
    loadTranscript: (machine: string, scope: string, threadId: string) => identity(scope) && identity(threadId)
      ? load<SavedTranscript>(machine, scope, threadId) : Promise.resolve(null),
    rememberCatalog(machine: string, catalog: Catalog) {
      const scope = readingCatalogScope(catalog);
      return scope ? remember(machine, scope, "catalog", "", catalog) : false;
    },
    rememberTranscript: (machine: string, scope: string, threadId: string, transcript: SavedTranscript) => remember(machine, scope, "transcript", threadId, transcript),
    clearMachine(machine: string) { revoke(machine); return clearReadingCache(machine); },
    clearAll() { revoke(); return clearReadingCache(); },
    flush,
    dispose() { revoke(); clearTimeout(timer); timer = undefined; unsubscribe(); disk?.close(); disk = null; },
  };
}
export type ReadingCache = ReturnType<typeof createReadingCache>;

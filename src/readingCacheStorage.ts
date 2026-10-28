import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from "idb";
import { readReadingCacheLimit, subscribeReadingCacheLimit } from "./readingCachePreference.ts";

export const READING_CACHE_DATABASE = "pocket-reading-cache-v1";
const fencePrefix = "pocket.reading-cache.epoch.v1.";
const channelName = "pocket-reading-cache-v1";
const allMachines = "*";

export type ReadingCacheInvalidation = { machine: string | null };
export type ReadingCacheRecord = {
  schema: 1; key: string; machine: string; scope: string; kind: "catalog" | "transcript";
  threadId: string; savedAt: number; accessedAt: number; bytes: number; json: string; fence: string;
  observedAt?: number; contentRevision?: number;
  touch?: true;
};
type DiskRecord = ReadingCacheRecord & { globalEpoch: number; machineEpoch: number };
interface ReadingDatabase extends DBSchema {
  entries: { key: string; value: DiskRecord; indexes: { machine: string; machineKind: [string, string] } };
  epochs: { key: string; value: number };
}
export type ReadingCacheStorage = {
  isCurrent?(machine: string): Promise<boolean>;
  catalog(machine: string): Promise<ReadingCacheRecord | null>;
  transcript(key: string, machine: string): Promise<ReadingCacheRecord | null>;
  write(records: ReadingCacheRecord[], now: number): Promise<void>;
  close(): void;
};
export const readingCacheLimits = Object.freeze({
  memoryBytes: 8 * 1024 * 1024, diskBytes: 30 * 1024 * 1024,
  memoryTranscripts: 20, catalogs: 8,
  ttlMs: 7 * 24 * 60 * 60 * 1000, writeDelayMs: 2000, validationRefreshMs: 60_000,
});
const listeners = new Set<(event: ReadingCacheInvalidation) => void>();
let channel: BroadcastChannel | undefined, listening = false;
const notify = (event: ReadingCacheInvalidation) => listeners.forEach(listener => {
  try { listener(event); } catch { /* One view cannot prevent the other views from clearing. */ }
});
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("storage", event => {
    if (event.key === null) { notify({ machine: null }); return; }
    if (!event.key?.startsWith(fencePrefix)) return;
    const suffix = event.key.slice(fencePrefix.length);
    notify({ machine: suffix === allMachines ? null : suffix });
  });
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(channelName);
      channel.onmessage = event => {
        if (event.data?.type === "invalidate" && (event.data.machine === null || typeof event.data.machine === "string"))
          notify({ machine: event.data.machine });
      };
    }
  } catch { /* Storage events and persistent epochs still invalidate other tabs. */ }
}
export function subscribeReadingCacheInvalidation(listener: (event: ReadingCacheInvalidation) => void) {
  listen(); listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// A non-sensitive tombstone also protects reads if an IDB deletion fails. If
// this storage is unavailable, the caller uses its bounded memory layer only.
export function readingCacheFence(machine: string): string | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    return `${storage.getItem(`${fencePrefix}${allMachines}`) ?? "0"}:${storage.getItem(`${fencePrefix}${machine}`) ?? "0"}`;
  } catch { return null; }
}
const invalidateFence = (machine?: string) => {
  try {
    const key = `${fencePrefix}${machine ?? allMachines}`, token = crypto.randomUUID();
    globalThis.localStorage.setItem(key, token);
    return globalThis.localStorage.getItem(key) === token;
  } catch { return false; }
};
const epoch = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
const expired = (record: ReadingCacheRecord, now: number) => !Number.isFinite(record.savedAt) ||
  record.savedAt > now + 60000 || record.savedAt <= now - readingCacheLimits.ttlMs;
export const readingCacheKey = (machine: string, scope: string, kind: ReadingCacheRecord["kind"], threadId = "") =>
  JSON.stringify([machine, scope, kind, threadId]);

function sourceVersion(record: ReadingCacheRecord) {
  let observedAt = record.observedAt, revision = record.contentRevision;
  // Compatibility with the initial v1 records, which kept observation times in
  // their JSON. A malformed old payload supplies no ordering evidence.
  if (observedAt === undefined) try {
    const value = JSON.parse(record.json);
    observedAt = record.kind === "transcript" ? value.checkedAt : value.sourceInfo?.syncedAt;
    revision = record.kind === "transcript" ? value.pocketContent?.revision : undefined;
  } catch { /* Arrival time is the only available fallback. */ }
  return { observedAt: typeof observedAt === "number" && Number.isFinite(observedAt) && observedAt > 0 ? observedAt : 0,
    revision: Number.isSafeInteger(revision) && revision! > 0 ? revision! : 0 };
}
export function readingRecordOrder(next: ReadingCacheRecord, previous: ReadingCacheRecord) {
  if (next.scope === previous.scope && next.kind === previous.kind) {
    const a = sourceVersion(next), b = sourceVersion(previous);
    if (next.kind === "transcript" && a.revision && b.revision && a.revision !== b.revision) return a.revision - b.revision;
    if (a.observedAt && b.observedAt && a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
  }
  // Source clocks/revisions may reset with a different source scope.
  return next.savedAt - previous.savedAt;
}

async function openReadingDatabase(name: string): Promise<IDBPDatabase<ReadingDatabase>> {
  let unavailable = false, timer: ReturnType<typeof setTimeout>;
  const pending = openDB<ReadingDatabase>(name, 1, {
    upgrade(db) {
      const entries = db.createObjectStore("entries", { keyPath: "key" });
      entries.createIndex("machine", "machine");
      entries.createIndex("machineKind", ["machine", "kind"]);
      db.createObjectStore("epochs");
    },
    blocking(_old, _next, event) { (event.target as IDBDatabase)?.close(); },
  });
  // A blocked upgrade must never hold the reading UI or logout indefinitely.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { unavailable = true; reject(new Error("Reading cache unavailable")); }, 1500);
  });
  pending.then(db => { if (unavailable) db.close(); }, () => {});
  try { return await Promise.race([pending, deadline]); } finally { clearTimeout(timer!); }
}

async function pruneReadingEntries(tx: IDBPTransaction<ReadingDatabase, ("entries" | "epochs")[], "readwrite">, now: number) {
  const entries = tx.objectStore("entries");
  // Keep only eviction metadata in memory, never a second full disk cache.
  const metadata: { key: string; kind: string; bytes: number; accessedAt: number }[] = [];
  let cursor = await entries.openCursor();
  while (cursor) {
    const record = cursor.value;
    if (record.schema !== 1 || expired(record, now) || record.fence !== readingCacheFence(record.machine) ||
        typeof record.json !== "string" || !Number.isSafeInteger(record.bytes) || record.bytes < record.json.length ||
        record.bytes > readingCacheLimits.diskBytes || !["catalog", "transcript"].includes(record.kind))
      await cursor.delete();
    else metadata.push({ key: record.key, kind: record.kind, bytes: record.bytes, accessedAt: record.accessedAt });
    cursor = await cursor.continue();
  }
  metadata.sort((a, b) => b.accessedAt - a.accessedAt);
  let bytes = 0, transcripts = 0, catalogs = 0;
  for (const record of metadata) {
    const countFits = record.kind === "transcript" ? transcripts < readReadingCacheLimit() : catalogs < readingCacheLimits.catalogs;
    if (!countFits || bytes + record.bytes > readingCacheLimits.diskBytes) await entries.delete(record.key);
    else { bytes += record.bytes; if (record.kind === "transcript") transcripts++; else catalogs++; }
  }
}

// Changing a size preference is not an authentication/cache invalidation. This
// prunes only old reading entries, leaving epochs, fences and live views intact.
export async function trimReadingCache(now = Date.now(), databaseName = READING_CACHE_DATABASE) {
  let db: IDBPDatabase<ReadingDatabase> | undefined;
  try {
    db = await openReadingDatabase(databaseName);
    const tx = db.transaction(["entries", "epochs"], "readwrite");
    void tx.done.catch(() => {});
    await pruneReadingEntries(tx, now); await tx.done;
    return { trimmed: true };
  } catch { return { trimmed: false }; }
  finally { db?.close(); }
}

export function createReadingCacheStorage({ databaseName = READING_CACHE_DATABASE }: { databaseName?: string } = {}): ReadingCacheStorage {
  let closed = false;
  // Capture the authenticated instance's epochs before any read/write. A clear
  // in another tab revokes this instance; only a new instance can use new epochs.
  const connection = openReadingDatabase(databaseName).then(async db => {
    try {
      const tx = db.transaction("epochs");
      void tx.done.catch(() => {});
      const keys = await tx.store.getAllKeys(), values = await tx.store.getAll();
      await tx.done;
      if (closed) throw new Error("Reading cache closed");
      return { db, epochs: new Map(keys.map((key, index) => [key, epoch(values[index])])) };
    } catch (error) { db.close(); throw error; }
  });
  // Creating the optional cache must not produce an unhandled rejection in
  // private mode or while IndexedDB is disabled.
  void connection.catch(() => {});
  const load = async (machine: string, key?: string) => {
    const { db, epochs } = await connection;
    if (closed) return null;
    const tx = db.transaction(["entries", "epochs"]);
    void tx.done.catch(() => {});
    const globalEpoch = epoch(await tx.objectStore("epochs").get(allMachines));
    const machineEpoch = epoch(await tx.objectStore("epochs").get(machine));
    if (globalEpoch !== (epochs.get(allMachines) ?? 0) || machineEpoch !== (epochs.get(machine) ?? 0)) {
      await tx.done; notify({ machine }); return null;
    }
    const candidates = key ? [await tx.objectStore("entries").get(key)]
      : await tx.objectStore("entries").index("machineKind").getAll([machine, "catalog"]);
    await tx.done;
    if (closed) return null;
    return candidates.filter((record): record is DiskRecord => !!record && record.machine === machine &&
      record.globalEpoch === globalEpoch && record.machineEpoch === machineEpoch &&
      record.fence === readingCacheFence(machine)).sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
  };
  let lastLimit = readReadingCacheLimit();
  const unsubscribePreference = subscribeReadingCacheLimit(() => {
    const limit = readReadingCacheLimit(), reduced = limit < lastLimit;
    lastLimit = limit;
    if (!reduced || closed) return;
    // Queue immediately behind any in-flight write, outside its transaction.
    // The queued trim reads the current setting again, not this captured limit.
    void connection.then(async ({ db }) => {
      if (closed) return;
      const tx = db.transaction(["entries", "epochs"], "readwrite");
      void tx.done.catch(() => {});
      await pruneReadingEntries(tx, Date.now()); await tx.done;
    }).catch(() => {});
  });
  return {
    async isCurrent(machine) {
      const { db, epochs } = await connection;
      if (closed) return false;
      const tx = db.transaction("epochs");
      void tx.done.catch(() => {});
      const globalEpoch = epoch(await tx.store.get(allMachines)), machineEpoch = epoch(await tx.store.get(machine));
      await tx.done;
      const current = !closed && globalEpoch === (epochs.get(allMachines) ?? 0) && machineEpoch === (epochs.get(machine) ?? 0);
      if (!current && !closed) notify({ machine });
      return current;
    },
    catalog: machine => load(machine),
    transcript: (key, machine) => load(machine, key),
    async write(records, now) {
      const { db, epochs } = await connection;
      if (closed || !records.length) return;
      const tx = db.transaction(["entries", "epochs"], "readwrite");
      void tx.done.catch(() => {});
      const entries = tx.objectStore("entries"), controls = tx.objectStore("epochs");
      const globalEpoch = epoch(await controls.get(allMachines));
      if (closed || globalEpoch !== (epochs.get(allMachines) ?? 0)) { await tx.done; return; }
      const machines = new Map<string, number>();
      for (const { touch, ...record } of records) {
        const machineEpoch = machines.get(record.machine) ?? epoch(await controls.get(record.machine));
        machines.set(record.machine, machineEpoch);
        if (closed || machineEpoch !== (epochs.get(record.machine) ?? 0) ||
            record.fence !== readingCacheFence(record.machine)) continue;
        const existing = await entries.get(record.key);
        if (touch || existing && readingRecordOrder(record, existing) < 0) {
          // L1 can lag another tab's fresh body. An LRU touch only changes the
          // existing disk entry's access time and never resurrects an eviction.
          if (existing && existing.globalEpoch === globalEpoch && existing.machineEpoch === machineEpoch && existing.fence === record.fence)
            await entries.put({ ...existing, accessedAt: Math.max(existing.accessedAt, record.accessedAt) });
          continue;
        }
        if (record.kind === "catalog") {
          const catalogs = await entries.index("machineKind").getAll([record.machine, "catalog"]);
          if (catalogs.some(previous => previous.savedAt > record.savedAt && previous.fence === record.fence)) continue;
          let previous = await entries.index("machineKind").openCursor([record.machine, "catalog"]);
          while (previous) {
            if (previous.value.key !== record.key) await previous.delete();
            previous = await previous.continue();
          }
        }
        await entries.put({ ...record, globalEpoch, machineEpoch });
      }
      await pruneReadingEntries(tx, now);
      await tx.done;
    },
    close() { closed = true; unsubscribePreference(); void connection.then(({ db }) => db.close(), () => {}); },
  };
}

export async function clearReadingCache(machine?: string, databaseName = READING_CACHE_DATABASE) {
  listen();
  const fenced = invalidateFence(machine), event = { machine: machine ?? null };
  notify(event);
  try { channel?.postMessage({ type: "invalidate", ...event }); } catch { /* Persistent epochs remain authoritative. */ }
  let cleared = false, db: IDBPDatabase<ReadingDatabase> | undefined;
  try {
    db = await openReadingDatabase(databaseName);
    const tx = db.transaction(["entries", "epochs"], "readwrite"), controls = tx.objectStore("epochs");
    void tx.done.catch(() => {});
    const key = machine ?? allMachines;
    await controls.put(epoch(await controls.get(key)) + 1, key);
    if (machine) {
      let cursor = await tx.objectStore("entries").index("machine").openCursor(machine);
      while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
    } else await tx.objectStore("entries").clear();
    await tx.done; cleared = true;
  } catch { /* The synchronous tombstone prevents reading undeleted entries. */ }
  finally { db?.close(); }
  return { invalidated: fenced || cleared, cleared };
}

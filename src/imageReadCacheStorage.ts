import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { readingCacheFence } from "./readingCacheStorage.ts";

export const IMAGE_READ_CACHE_DATABASE = "pocket-image-read-cache-v1";
export const imageReadCacheLimits = Object.freeze({ memoryBytes: 12 * 1024 * 1024, diskBytes: 64 * 1024 * 1024,
  imageBytes: 8 * 1024 * 1024, entries: 256, concurrentReads: 8, timeoutMs: 25000 });
export type ImageReadVariant = "original" | "preview";
export type ImageReadRecord = { schema: 1; key: string; machine: string; scope: string; threadId: string;
  sha256: string; variant: ImageReadVariant; mime: string; bytes: number; blob: Blob; accessedAt: number; fence: string };
type DiskMetadata = Omit<ImageReadRecord, "blob"> & { globalEpoch: number; machineEpoch: number };
// WebKit can decode Blob URLs while rejecting Blob/File cloning into IDB.
// Keep the byte representation portable; older Blob records remain readable.
type DiskRecord = DiskMetadata & ({ data: ArrayBuffer; blob?: never } | { blob: Blob; data?: never });
interface ImageDatabase extends DBSchema {
  images: { key: string; value: DiskRecord; indexes: { machine: string } };
  epochs: { key: string; value: number };
}
export type ImageReadStorage = { read(key: string, machine: string): Promise<ImageReadRecord | null>;
  write(record: ImageReadRecord): Promise<void>; remove(key: string): Promise<void>;
  retainScope?(machine: string, scope: string, current: () => boolean): Promise<boolean>; close(): void };
const fencePrefix = "pocket.image-read-cache.epoch.v1.", channelName = IMAGE_READ_CACHE_DATABASE, all = "*";
const listeners = new Set<(machine?: string) => void>();
let listening = false, channel: BroadcastChannel | undefined;
const notify = (machine?: string) => listeners.forEach(listener => { try { listener(machine); } catch { /* Other views still clear. */ } });
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("storage", event => {
    if (event.key === null) notify();
    else if (event.key.startsWith(fencePrefix)) { const suffix = event.key.slice(fencePrefix.length); notify(suffix === all ? undefined : suffix); }
  });
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(channelName);
      // Node-based UI harnesses expose browser globals; their optional channel
      // must not keep a finished test process alive.
      (channel as BroadcastChannel & { unref?: () => void }).unref?.();
      channel.onmessage = event => { if (event.data?.type === "invalidate" && (event.data.machine === null || typeof event.data.machine === "string")) notify(event.data.machine ?? undefined); };
    }
  } catch { /* Persistent epochs protect tabs without this optional channel. */ }
}
export function subscribeImageReadInvalidation(listener: (machine?: string) => void) {
  listen(); listeners.add(listener); return () => { listeners.delete(listener); };
}
export function imageReadCacheFence(machine: string): string | null {
  try {
    const storage = globalThis.localStorage, reading = readingCacheFence(machine);
    return storage && reading !== null ? `${reading}:${storage.getItem(fencePrefix + all) ?? "0"}:${storage.getItem(fencePrefix + machine) ?? "0"}` : null;
  } catch { return null; }
}
export const imageReadCacheKey = (machine: string, scope: string, threadId: string, sha256: string, variant: ImageReadVariant) =>
  JSON.stringify([machine, scope, threadId, sha256, variant]);
const epoch = (value?: number) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
function readableRecord(record: DiskRecord): ImageReadRecord | null {
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 1 || record.bytes > imageReadCacheLimits.imageBytes || typeof record.mime !== "string") return null;
  if (record.data instanceof ArrayBuffer) {
    if (record.data.byteLength !== record.bytes) return null;
    const { data, ...metadata } = record;
    return { ...metadata, blob: new Blob([data], { type: record.mime }) };
  }
  const legacy = record.blob;
  return legacy instanceof Blob && legacy.size === record.bytes && legacy.type === record.mime ? { ...record, blob: legacy } : null;
}
async function openImageDatabase(name: string) {
  let unavailable = false, timer: ReturnType<typeof setTimeout>;
  const pending = openDB<ImageDatabase>(name, 1, { upgrade(db) {
    db.createObjectStore("images", { keyPath: "key" }).createIndex("machine", "machine"); db.createObjectStore("epochs");
  }, blocking(_old, _next, event) { (event.target as IDBDatabase)?.close(); } });
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { unavailable = true; reject(new Error("Image cache unavailable")); }, 1500); });
  pending.then(db => { if (unavailable) db.close(); }, () => {});
  try { return await Promise.race([pending, deadline]); } finally { clearTimeout(timer!); }
}
export function createImageReadStorage({ databaseName = IMAGE_READ_CACHE_DATABASE }: { databaseName?: string } = {}): ImageReadStorage {
  let closed = false;
  const connection = openImageDatabase(databaseName).then(async db => {
    try {
      const tx = db.transaction("epochs"); void tx.done.catch(() => {});
      const keys = await tx.store.getAllKeys(), values = await tx.store.getAll(); await tx.done;
      if (closed) throw new Error("Image cache closed");
      return { db, epochs: new Map(keys.map((key, index) => [key, epoch(values[index])])) };
    } catch (error) { db.close(); throw error; }
  });
  void connection.catch(() => {});
  return {
    async retainScope(machine, scope, current) {
      const { db, epochs } = await connection;
      if (closed || !current()) return false;
      const tx = db.transaction(["images", "epochs"], "readwrite"); void tx.done.catch(() => {});
      const controls = tx.objectStore("epochs"), store = tx.objectStore("images");
      const globalEpoch = epoch(await controls.get(all)), machineEpoch = epoch(await controls.get(machine));
      if (closed || !current() || globalEpoch !== (epochs.get(all) ?? 0) || machineEpoch !== (epochs.get(machine) ?? 0)) { await tx.done; return false; }
      const retained: string[] = []; let removed = false;
      let cursor = await store.index("machine").openCursor(machine);
      while (cursor) {
        if (closed || !current()) { tx.abort(); await tx.done.catch(() => {}); return false; }
        if (cursor.value.scope !== scope) { await cursor.delete(); removed = true; }
        else retained.push(cursor.value.key);
        cursor = await cursor.continue();
      }
      // A cold source change also revokes older storage instances, so their
      // delayed writes cannot recreate the removed scope. Matching rows keep
      // their verified bytes, adopting only this new machine epoch.
      if (removed) {
        await controls.put(machineEpoch + 1, machine);
        for (const key of retained) {
          const record = await store.get(key);
          if (record) await store.put({ ...record, machineEpoch: machineEpoch + 1 });
        }
      }
      if (closed || !current()) { tx.abort(); await tx.done.catch(() => {}); return false; }
      await tx.done;
      if (removed) epochs.set(machine, machineEpoch + 1);
      return !closed && current();
    },
    async read(key, machine) {
      const { db, epochs } = await connection;
      if (closed) return null;
      const tx = db.transaction(["images", "epochs"], "readwrite"); void tx.done.catch(() => {});
      const globalEpoch = epoch(await tx.objectStore("epochs").get(all)), machineEpoch = epoch(await tx.objectStore("epochs").get(machine));
      if (closed || globalEpoch !== (epochs.get(all) ?? 0) || machineEpoch !== (epochs.get(machine) ?? 0)) { await tx.done; return null; }
      const record = await tx.objectStore("images").get(key);
      if (!record || record.machine !== machine || record.globalEpoch !== globalEpoch || record.machineEpoch !== machineEpoch ||
          record.fence !== imageReadCacheFence(machine)) { await tx.done; return null; }
      const readable = readableRecord(record);
      if (!readable) { await tx.done; return null; }
      if (record.data instanceof ArrayBuffer) {
        await tx.objectStore("images").put({ ...record, accessedAt: Date.now() }); await tx.done;
      } else {
        // Extract legacy bytes outside a transaction: Safari may close a
        // transaction during Blob.arrayBuffer(). Recheck revocation before
        // migrating or touching its access time in a new transaction.
        await tx.done;
        const data = await readable.blob.arrayBuffer();
        if (closed || record.fence !== imageReadCacheFence(machine)) return null;
        const migration = db.transaction(["images", "epochs"], "readwrite"); void migration.done.catch(() => {});
        const controls = migration.objectStore("epochs");
        if (globalEpoch !== epoch(await controls.get(all)) || machineEpoch !== epoch(await controls.get(machine)) ||
            closed || record.fence !== imageReadCacheFence(machine)) { await migration.done; return null; }
        const current = await migration.objectStore("images").get(key);
        if (!current || current.schema !== record.schema || current.machine !== machine || current.scope !== record.scope ||
            current.threadId !== record.threadId || current.sha256 !== record.sha256 || current.variant !== record.variant ||
            current.fence !== record.fence || current.globalEpoch !== globalEpoch || current.machineEpoch !== machineEpoch) {
          await migration.done; return null;
        }
        const { blob: _legacyBlob, ...metadata } = record;
        await migration.objectStore("images").put({ ...metadata, data, accessedAt: Date.now() }); await migration.done;
      }
      return closed || record.fence !== imageReadCacheFence(machine) ? null : readable;
    },
    async write(record) {
      const { db, epochs } = await connection;
      if (closed || record.fence !== imageReadCacheFence(record.machine)) return;
      if (record.bytes !== record.blob.size || record.mime !== record.blob.type || record.bytes < 1 || record.bytes > imageReadCacheLimits.imageBytes) return;
      const { blob, ...recordMetadata } = record, data = await blob.arrayBuffer();
      if (closed || record.fence !== imageReadCacheFence(record.machine)) return;
      const tx = db.transaction(["images", "epochs"], "readwrite"); void tx.done.catch(() => {});
      const store = tx.objectStore("images"), controls = tx.objectStore("epochs");
      const globalEpoch = epoch(await controls.get(all)), machineEpoch = epoch(await controls.get(record.machine));
      if (closed || globalEpoch !== (epochs.get(all) ?? 0) || machineEpoch !== (epochs.get(record.machine) ?? 0) || record.fence !== imageReadCacheFence(record.machine)) { await tx.done; return; }
      await store.put({ ...recordMetadata, data, globalEpoch, machineEpoch });
      // Eviction holds only metadata in memory, never copies all image blobs.
      const metadata: { key: string; bytes: number; accessedAt: number }[] = [];
      let cursor = await store.openCursor();
      while (cursor) {
        const item = cursor.value;
        if (item.schema !== 1 || item.fence !== imageReadCacheFence(item.machine) || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > imageReadCacheLimits.imageBytes)
          await cursor.delete();
        else metadata.push({ key: item.key, bytes: item.bytes, accessedAt: item.accessedAt });
        cursor = await cursor.continue();
      }
      metadata.sort((a, b) => b.accessedAt - a.accessedAt);
      let bytes = 0, count = 0;
      for (const item of metadata) {
        if (++count > imageReadCacheLimits.entries || bytes + item.bytes > imageReadCacheLimits.diskBytes) await store.delete(item.key);
        else bytes += item.bytes;
      }
      await tx.done;
    },
    async remove(key) { const { db } = await connection; if (!closed) await db.delete("images", key); },
    close() { closed = true; void connection.then(({ db }) => db.close(), () => {}); },
  };
}
export async function clearImageReadStorage(machine?: string, databaseName = IMAGE_READ_CACHE_DATABASE) {
  listen(); let fenced = false;
  try {
    const key = fencePrefix + (machine ?? all), token = crypto.randomUUID();
    globalThis.localStorage.setItem(key, token); fenced = globalThis.localStorage.getItem(key) === token;
  } catch { /* The disk epoch remains an independent revocation fence. */ }
  notify(machine); try { channel?.postMessage({ type: "invalidate", machine: machine ?? null }); } catch { /* Optional broadcast. */ }
  let cleared = false, db: IDBPDatabase<ImageDatabase> | undefined;
  try {
    db = await openImageDatabase(databaseName);
    const tx = db.transaction(["images", "epochs"], "readwrite"); void tx.done.catch(() => {});
    const controls = tx.objectStore("epochs"), key = machine ?? all;
    await controls.put(epoch(await controls.get(key)) + 1, key);
    if (machine) { let cursor = await tx.objectStore("images").index("machine").openCursor(machine); while (cursor) { await cursor.delete(); cursor = await cursor.continue(); } }
    else await tx.objectStore("images").clear();
    await tx.done; cleared = true;
  } catch { /* Callers retain synchronous memory revocation even if IDB fails. */ }
  finally { db?.close(); }
  return { invalidated: fenced || cleared, cleared };
}

import type { PocketActivity } from "./smartOrder.ts";
import type { TaskOperation } from "./taskOperations.ts";
import { machineStorageKey } from "./machineScope.ts";

const key = "pocket.activity.v1";
const lifetime = 90 * 86400000;
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const time = (value: unknown, now: number) => typeof value === "number" && Number.isFinite(value) && value > now - lifetime && value > 0 ? Math.min(value, now) : undefined;

function bounded(entries: Iterable<[string, PocketActivity]>, now: number): ReadonlyMap<string, PocketActivity> {
  return new Map([...entries].filter(([id]) => validId(id)).map(([id, value]): [string, PocketActivity] => [id, {
    createdAt: time(value?.createdAt, now), visitedAt: time(value?.visitedAt, now),
  }]).filter(([, value]) => value.createdAt || value.visitedAt)
    .sort((a, b) => Math.max(b[1].createdAt || 0, b[1].visitedAt || 0) - Math.max(a[1].createdAt || 0, a[1].visitedAt || 0)).slice(0, 200));
}

function preserveUnchanged(current: ReadonlyMap<string, PocketActivity>, next: ReadonlyMap<string, PocketActivity>) {
  return current.size === next.size && [...next].every(([id, value]) => {
    const old = current.get(id);
    return old?.createdAt === value.createdAt && old?.visitedAt === value.visitedAt && current.has(id);
  }) ? current : next;
}

export function readPocketActivity(storage?: Pick<Storage, "getItem">, now = Date.now()): ReadonlyMap<string, PocketActivity> {
  try {
    const entries: unknown = JSON.parse((storage ?? localStorage).getItem(machineStorageKey(key)) || "[]");
    if (!Array.isArray(entries)) return new Map();
    return bounded(entries.filter(entry => Array.isArray(entry) && entry.length === 2 && entry[1] && typeof entry[1] === "object") as [string, PocketActivity][], now);
  } catch { return new Map(); }
}

export function savePocketActivity(activity: ReadonlyMap<string, PocketActivity>, storage?: Pick<Storage, "setItem">) {
  try { (storage ?? localStorage).setItem(machineStorageKey(key), JSON.stringify([...activity])); }
  catch { /* Private/limited browser storage must not prevent opening a chat. */ }
}

// Called only by a deliberate row activation, never by polling or restoration.
export function recordPocketVisit(current: ReadonlyMap<string, PocketActivity>, id: string, now = Date.now()) {
  if (!validId(id)) return current;
  const next = new Map(current);
  next.set(id, { ...next.get(id), visitedAt: now });
  return preserveUnchanged(current, bounded(next, now));
}

export function rememberPocketCreations(current: ReadonlyMap<string, PocketActivity>, operations: readonly TaskOperation[], now = Date.now()) {
  let next: Map<string, PocketActivity> | undefined;
  for (const operation of operations) {
    const createdAt = time(operation.createdAt, now);
    if (operation.operation !== "create" || !(operation.status === "succeeded" || operation.creationStatus === "created") || !validId(operation.threadId) || !createdAt) continue;
    const old = (next ?? current).get(operation.threadId);
    // Re-reading or recovering one creation cannot make its original date newer.
    if (old?.createdAt && old.createdAt <= createdAt) continue;
    next ??= new Map(current);
    next.set(operation.threadId, { ...old, createdAt });
  }
  return next ? preserveUnchanged(current, bounded(next, now)) : current;
}

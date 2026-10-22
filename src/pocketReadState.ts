import { currentMachineId, machineStorageKey, type MachineId } from "./machineScope.ts";

import type { PocketContent } from "./types";
export type { PocketContent } from "./types";
type ContentVersion = Pick<PocketContent, "revision" | "version" | "messageId">;
type ReadEntry = { schema: 1; latest: ContentVersion; seen: ContentVersion | null; conflict: boolean; touchedAt: number };
type ReadThread = { id: string; pocketContent?: PocketContent | null; desktopReadContent?: PocketContent | null; hasUnreadTurn?: boolean | null; needsInput?: boolean };
type StorageLike = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "key" | "removeItem" | "length">>;
type BrowserLike = Pick<Window, "addEventListener" | "removeEventListener">;
const prefix = "pocket.read.v1.";
export const MAX_POCKET_READ_RECORDS = 4096;
const overflowKey = "pocket.read.overflow.v1";
const validString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const sameVersion = (a: ContentVersion, b: ContentVersion) => a.revision === b.revision && a.version === b.version && a.messageId === b.messageId;
const version = (value: unknown): value is ContentVersion => {
  const item = value as ContentVersion | null;
  return !!item && Number.isSafeInteger(item.revision) && item.revision > 0 && typeof item.version === "string" && /^[a-f0-9]{64}$/.test(item.version) &&
    (item.messageId === null || validString(item.messageId));
};
export function isPocketContent(value: unknown): value is PocketContent {
  const item = value as PocketContent | null;
  return !!item && item.known === true && validString(item.scope) && version(item);
}
const reference = ({ revision, version, messageId }: ContentVersion): ContentVersion => ({ revision, version, messageId });
function parse(raw: string | null): ReadEntry | null {
  try {
    const value = JSON.parse(raw || "null");
    if (value?.schema !== 1 || !version(value.latest) || value.seen !== null && !version(value.seen) ||
      typeof value.conflict !== "boolean" || value.seen?.revision > value.latest.revision) return null;
    return { schema: 1, latest: reference(value.latest), seen: value.seen ? reference(value.seen) : null, conflict: value.conflict, touchedAt: Number.isFinite(value.touchedAt) && value.touchedAt >= 0 ? value.touchedAt : 0 };
  } catch { return null; }
}
function merge(a: ReadEntry | null, b: ReadEntry): ReadEntry {
  if (!a) return b;
  const latest = a.latest.revision >= b.latest.revision ? a.latest : b.latest;
  const conflict = a.latest.revision === b.latest.revision
    ? a.conflict || b.conflict || !sameVersion(a.latest, b.latest)
    : latest === a.latest ? a.conflict : b.conflict;
  const seen = !a.seen ? b.seen : !b.seen ? a.seen : a.seen.revision >= b.seen.revision ? a.seen : b.seen;
  // An inconsistent hash at one revision cannot be evidence of having read it.
  const seenConflict = !!a.seen && !!b.seen && a.seen.revision === b.seen.revision && !sameVersion(a.seen, b.seen);
  return { schema: 1, latest, seen, conflict: conflict || seenConflict && seen!.revision === latest.revision, touchedAt: Math.max(a.touchedAt, b.touchedAt) };
}
const encode = (value: ReadEntry) => JSON.stringify(value);

export function createPocketReadStateStore({
  storage,
  browser = () => typeof window === "undefined" ? undefined : window,
  machine = currentMachineId,
  maxRecords = MAX_POCKET_READ_RECORDS,
  now = Date.now,
}: { storage?: StorageLike; browser?: () => BrowserLike | undefined; machine?: () => MachineId | null; maxRecords?: number; now?: () => number } = {}) {
  const limit = Math.max(1, Math.min(MAX_POCKET_READ_RECORDS, Math.floor(maxRecords) || MAX_POCKET_READ_RECORDS));
  const entries = new Map<string, ReadEntry>();
  const activeScopes = new Map<MachineId, string>();
  const overflowedMachines = new Set<MachineId>();
  const listeners = new Set<() => void>();
  let snapshot = 0, listening: BrowserLike | undefined;
  const targetStorage = () => storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  const keyFor = (id: string, scope: string) => {
    const selected = machine();
    return selected && validString(id) && validString(scope)
      ? machineStorageKey(`${prefix}${encodeURIComponent(scope)}.${encodeURIComponent(id)}`, selected) : null;
  };
  const read = (key: string) => {
    let saved: ReadEntry | null = null;
    try { saved = parse(targetStorage()?.getItem(key) ?? null); } catch { /* The in-page record still applies. */ }
    const current = entries.get(key) ?? null;
    return saved ? merge(current, saved) : current;
  };
  const notify = () => { snapshot++; listeners.forEach(listener => listener()); };
  const put = (key: string, next: ReadEntry, persist = true) => {
    const current = entries.get(key);
    const merged = merge(read(key), next);
    if (current && (!sameVersion(current.latest, merged.latest) || current.conflict !== merged.conflict ||
      JSON.stringify(current.seen) !== JSON.stringify(merged.seen))) merged.touchedAt = Math.max(merged.touchedAt, now());
    const changed = !current || encode(current) !== encode(merged);
    entries.set(key, merged);
    if (persist) try {
      // Rewriting only this conversation also repairs an older tab's late write.
      if (targetStorage()?.getItem(key) !== encode(merged)) targetStorage()?.setItem(key, encode(merged));
    } catch { /* Quota/private mode must not undo actual reading in this page. */ }
    return changed;
  };
  const overflowed = () => {
    const selected = machine();
    if (!selected) return false;
    try { if (targetStorage()?.getItem(machineStorageKey(overflowKey, selected)) === "true") overflowedMachines.add(selected); } catch { /* In-page flag remains. */ }
    return overflowedMachines.has(selected);
  };
  const prune = () => {
    const selected = machine();
    if (!selected) return false;
    const machinePrefix = machineStorageKey(prefix, selected);
    // Below capacity even the origin-wide key count proves no scan is needed.
    // This keeps a second tab's individual storage events cheap after import.
    try { if (entries.size <= limit && (targetStorage()?.length ?? 0) <= limit) return false; } catch { /* Enforce the memory bound below. */ }
    const candidates = new Map([...entries].filter(([key]) => key.startsWith(machinePrefix)));
    try {
      const storage = targetStorage();
      for (let i = 0; i < (storage?.length ?? 0); i++) {
        const key = storage?.key?.(i);
        if (!key?.startsWith(machinePrefix)) continue;
        const saved = read(key);
        if (saved) candidates.set(key, saved);
      }
    } catch { /* The memory budget can still be enforced when storage is unavailable. */ }
    if (candidates.size <= limit) return false;
    overflowedMachines.add(selected);
    try { targetStorage()?.setItem(machineStorageKey(overflowKey, selected), "true"); } catch { /* Keep the in-page overflow policy. */ }
    const ordered = [...candidates].sort((a, b) => b[1].touchedAt - a[1].touchedAt || a[0].localeCompare(b[0]));
    let changed = false;
    for (const [key] of ordered.slice(limit)) {
      changed = entries.delete(key) || changed;
      try { targetStorage()?.removeItem?.(key); } catch { /* A blocked storage write cannot undo current-page reading. */ }
    }
    return changed;
  };
  const stored = (event: Event) => {
    const key = (event as StorageEvent).key;
    const selected = machine();
    if (!selected) return;
    const machinePrefix = machineStorageKey(prefix, selected);
    if (key === machineStorageKey(overflowKey, selected)) { overflowed(); notify(); return; }
    if (key !== null && (typeof key !== "string" || !key.startsWith(machinePrefix))) return;
    if (key !== null && (event as StorageEvent).newValue === null) {
      // Another tab may be enforcing the same capacity bound. Never recreate
      // its deleted row from a stale in-memory copy or the tabs can ping-pong.
      const current = entries.get(key), removed = parse((event as StorageEvent).oldValue);
      const newer = current && removed && (current.latest.revision > removed.latest.revision ||
        (current.seen?.revision ?? 0) > (removed.seen?.revision ?? 0) || current.touchedAt > removed.touchedAt);
      if (!newer && entries.delete(key)) notify();
      return;
    }
    let changed = false;
    for (const target of key === null ? entries.keys() : [key]) {
      const previous = entries.get(target);
      const saved = read(target);
      if (saved) changed = put(target, saved, key !== null) || changed;
      else if (previous) entries.set(target, previous);
    }
    if (changed) { prune(); notify(); }
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!listening) { listening = browser(); listening?.addEventListener("storage", stored); }
    return () => {
      listeners.delete(listener);
      if (!listeners.size && listening) { listening.removeEventListener("storage", stored); listening = undefined; }
    };
  };
  const catalogEntry = (thread: ReadThread, content: PocketContent, current: ReadEntry | null) => {
    const latest = reference(content);
    // Native booleans establish the first baseline only. Later desktop reads
    // must name the content version observed by the server, not its latest row.
    const initiallyUnread = !overflowed() && thread.hasUnreadTurn !== false && (thread.hasUnreadTurn === true || thread.needsInput === true);
    const next = merge(current, { schema: 1, latest, seen: current || initiallyUnread ? null : latest, conflict: false, touchedAt: 0 });
    const hint = thread.desktopReadContent;
    if (!isPocketContent(hint) || hint.scope !== content.scope || hint.revision > content.revision ||
      next.conflict && hint.revision === next.latest.revision) return next;
    // Reject inconsistent hints without poisoning an otherwise usable record.
    // An old catalog may carry its old hint, but cannot relabel it as new content.
    for (const known of [content, current?.latest, current?.seen, next.latest, next.seen])
      if (known?.revision === hint.revision && !sameVersion(known, hint)) return next;
    if (!next.seen || hint.revision > next.seen.revision) return { ...next, seen: reference(hint) };
    return next;
  };
  const observeCatalog = (threads: readonly ReadThread[], scope?: string) => {
    const selected = machine();
    const scopes = new Set(threads.map(thread => thread.pocketContent).filter(isPocketContent).map(content => content.scope));
    const observedScope = validString(scope) ? scope : scopes.size === 1 ? [...scopes][0] : undefined;
    const scopeChanged = !!selected && !!observedScope && (validString(scope) || !activeScopes.has(selected)) && activeScopes.get(selected) !== observedScope;
    if (scopeChanged) activeScopes.set(selected!, observedScope!);
    let changed = scopeChanged;
    for (const thread of threads) {
      const content = thread.pocketContent;
      if (!isPocketContent(content) || observedScope && content.scope !== observedScope) continue;
      const key = keyFor(thread.id, content.scope);
      if (!key) continue;
      const current = read(key);
      changed = put(key, catalogEntry(thread, content, current)) || changed;
    }
    if (changed) { prune(); notify(); }
  };
  const markSeen = (threadId: string, content: PocketContent) => {
    if (!isPocketContent(content) || content.messageId === null) return;
    const key = keyFor(threadId, content.scope);
    if (!key) return;
    const current = read(key);
    const latest = reference(content);
    const next = merge(current, { schema: 1, latest, seen: null, conflict: false, touchedAt: now() });
    // Same-revision disagreement remains unread until a higher valid revision.
    if (!(next.conflict && next.latest.revision === content.revision))
      next.seen = !next.seen || content.revision > next.seen.revision ? latest : next.seen;
    if (put(key, next)) { prune(); notify(); }
  };
  const unread = (thread: ReadThread, scope?: string): boolean | undefined => {
    const supplied = isPocketContent(thread.pocketContent) ? thread.pocketContent : null;
    const selected = machine();
    const source = scope ?? (selected ? activeScopes.get(selected) : undefined) ?? supplied?.scope;
    if (!source) return undefined;
    const content = supplied?.scope === source ? supplied : null;
    const key = keyFor(thread.id, source);
    if (!key) return undefined;
    const current = read(key);
    const value = content ? catalogEntry(thread, content, current) : current;
    if (!value) return undefined;
    if (value.latest.messageId === null) return false;
    return value.conflict || !value.seen || value.seen.revision < value.latest.revision ||
      value.seen.revision === value.latest.revision && !sameVersion(value.seen, value.latest);
  };
  return { subscribe, getSnapshot: () => snapshot, observeCatalog, markSeen, unread };
}

export const pocketReadState = createPocketReadStateStore();

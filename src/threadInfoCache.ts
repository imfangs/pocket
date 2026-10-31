import type { MachineId } from "./machineScope.ts";

export type ThreadInfoKey = { machine: MachineId; hostId: string; threadId: string; kind: "models" | "automations" };
export type ThreadInfoTicket = Readonly<{ key: string; owner: object }>;
export type ThreadInfoSnapshot<T> = { value: T; savedAt: number; fresh: boolean };
export const threadInfoCacheLimits = { freshMs: 30000, maxAgeMs: 300000, entries: 64, bytes: 1024 * 1024 } as const;
const cacheKey = (key: ThreadInfoKey) => JSON.stringify([key.machine, key.hostId, key.threadId, key.kind]);

// Ephemeral, authenticated-page information only. Callers project display data
// before writing; revisions, permissions and operation receipts do not belong
// here. Tickets also fence reads that finish after logout/source invalidation.
export function createThreadInfoCache({ now = Date.now }: { now?: () => number } = {}) {
  const entries = new Map<string, { machine: MachineId; value: unknown; savedAt: number; bytes: number }>();
  const owners = new Map<string, { machine: MachineId; token: object }>();
  const listeners = new Set<(event: { machine?: MachineId }) => void>();
  let bytes = 0;
  const removeEntry = (id: string) => {
    const entry = entries.get(id);
    if (entry) bytes -= entry.bytes;
    entries.delete(id);
  };
  const current = (key: ThreadInfoKey, ticket: ThreadInfoTicket) => {
    const id = cacheKey(key);
    return ticket.key === id && owners.get(id)?.token === ticket.owner;
  };
  return {
    ticket(key: ThreadInfoKey): ThreadInfoTicket {
      const id = cacheKey(key), owner = owners.get(id) ?? { machine: key.machine, token: {} };
      owners.delete(id); owners.set(id, owner);
      // Tickets are bounded too. Eviction invalidates an old read, rather than
      // letting a recycled numeric generation accept its late response.
      while (owners.size > threadInfoCacheLimits.entries) owners.delete(owners.keys().next().value!);
      return { key: id, owner: owner.token };
    },
    current,
    get<T>(key: ThreadInfoKey): ThreadInfoSnapshot<T> | null {
      const id = cacheKey(key), entry = entries.get(id);
      if (!entry) return null;
      const age = now() - entry.savedAt;
      if (age < 0 || age >= threadInfoCacheLimits.maxAgeMs) { removeEntry(id); return null; }
      entries.delete(id); entries.set(id, entry);
      return { value: structuredClone(entry.value) as T, savedAt: entry.savedAt, fresh: age < threadInfoCacheLimits.freshMs };
    },
    put<T>(key: ThreadInfoKey, value: T, ticket: ThreadInfoTicket): boolean {
      if (!current(key, ticket)) return false;
      const id = cacheKey(key);
      try {
        const copy = structuredClone(value), size = JSON.stringify(copy).length * 2 + id.length * 2 + 128;
        if (size > threadInfoCacheLimits.bytes) return false;
        removeEntry(id);
        entries.set(id, { machine: key.machine, value: copy, savedAt: now(), bytes: size }); bytes += size;
        while (entries.size > threadInfoCacheLimits.entries || bytes > threadInfoCacheLimits.bytes) removeEntry(entries.keys().next().value!);
        return true;
      } catch { return false; }
    },
    remove(key: ThreadInfoKey) {
      const id = cacheKey(key); removeEntry(id); owners.delete(id);
    },
    clear(machine?: MachineId) {
      for (const [id, entry] of entries) if (!machine || entry.machine === machine) removeEntry(id);
      for (const [id, owner] of owners) if (!machine || owner.machine === machine) owners.delete(id);
      for (const listener of listeners) {
        try { listener({ machine }); } catch { /* A view cannot block cache revocation. */ }
      }
    },
    subscribe(listener: (event: { machine?: MachineId }) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export const threadInfoCache = createThreadInfoCache();

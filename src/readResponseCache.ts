// Short-lived response bodies belong only to this authenticated page. Disk
// storage uses the separate, display-only reading cache.
export function createReadResponseCache() {
  const entries = new Map<string, { version: string; data: unknown; bytes: number; at: number }>();
  let bytes = 0;
  const remove = (key: string) => { const old = entries.get(key); if (old) bytes -= old.bytes; entries.delete(key); };
  return {
    get(key: string) {
      const entry = entries.get(key);
      if (!entry) return;
      if (Date.now() - entry.at > 300000) { remove(key); return; }
      entries.delete(key); entries.set(key, entry);
      return { version: entry.version, data: structuredClone(entry.data) };
    },
    put(key: string, version: string, data: unknown) {
      remove(key);
      // Bound the serialized UTF-16 payload, independently of entry count.
      const size = JSON.stringify(data).length * 2;
      if (size > 8 * 1024 * 1024) return;
      entries.set(key, { version, data: structuredClone(data), bytes: size, at: Date.now() }); bytes += size;
      while (entries.size > 32 || bytes > 8 * 1024 * 1024) remove(entries.keys().next().value!);
    },
    clear(machine?: string) {
      for (const key of entries.keys()) if (!machine || key.startsWith(`${machine}:`)) remove(key);
    },
  };
}

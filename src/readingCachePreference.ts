export const readingCachePreferenceKey = "pocket.reading-cache.limit.v1";
export const readingCacheLimitOptions = Object.freeze([20, 50, 100, 200, 500] as const);
export type ReadingCacheLimit = typeof readingCacheLimitOptions[number];
export const defaultReadingCacheLimit: ReadingCacheLimit = 50;
const changedEvent = "pocket-reading-cache-limit-changed";
type PreferenceBrowser = Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent" | "localStorage">;
type PreferenceChange = { source: object; limit: ReadingCacheLimit; persisted: boolean };
const normalize = (value: unknown): ReadingCacheLimit =>
  readingCacheLimitOptions.includes(value as ReadingCacheLimit) ? value as ReadingCacheLimit : defaultReadingCacheLimit;
const parse = (raw: string | null): ReadingCacheLimit => readingCacheLimitOptions.find(value => String(value) === raw) ?? defaultReadingCacheLimit;

export function createReadingCachePreferenceStore({
  browser = () => typeof window === "undefined" ? undefined : window,
  storage,
}: { browser?: () => PreferenceBrowser | undefined; storage?: () => Pick<Storage, "getItem" | "setItem"> | undefined } = {}) {
  // Only this numeric preference is shared across machines. Failed writes keep
  // the explicit choice for this page until a real storage event supersedes it.
  let transient: ReadingCacheLimit | undefined, listening: PreferenceBrowser | undefined;
  const listeners = new Set<() => void>(), source = {};
  const targetStorage = () => storage ? storage() : browser()?.localStorage ?? globalThis.localStorage;
  const notify = () => listeners.forEach(listener => { try { listener(); } catch { /* Other views still update. */ } });
  const read = () => {
    if (transient !== undefined) return transient;
    try { return parse(targetStorage()?.getItem(readingCachePreferenceKey) ?? null); }
    catch { return defaultReadingCacheLimit; }
  };
  const changed = (event: Event) => {
    const detail = (event as CustomEvent<PreferenceChange>).detail;
    if (!detail || detail.source === source) return;
    transient = detail.persisted ? undefined : normalize(detail.limit);
    notify();
  };
  const stored = (event: StorageEvent) => {
    if (event.key !== null && event.key !== readingCachePreferenceKey) return;
    try { if (event.storageArea && event.storageArea !== targetStorage()) return; }
    catch { return; }
    transient = undefined;
    notify();
  };
  const unwatch = () => {
    listening?.removeEventListener?.(changedEvent, changed);
    listening?.removeEventListener?.("storage", stored);
    listening = undefined;
  };
  const watch = () => {
    const target = browser();
    if (!target || target === listening) return;
    unwatch(); listening = target;
    target.addEventListener(changedEvent, changed);
    target.addEventListener("storage", stored);
  };
  return {
    read,
    save(value: number) {
      const limit = normalize(value);
      let persisted = false;
      try {
        const target = targetStorage();
        target?.setItem(readingCachePreferenceKey, String(limit));
        persisted = target?.getItem(readingCachePreferenceKey) === String(limit);
      } catch { /* The page-local override remains available below. */ }
      transient = persisted ? undefined : limit;
      notify();
      browser()?.dispatchEvent?.(new CustomEvent<PreferenceChange>(changedEvent, { detail: { source, limit, persisted } }));
      return { limit, persisted };
    },
    subscribe(listener: () => void) {
      listeners.add(listener); watch();
      return () => { listeners.delete(listener); if (!listeners.size) unwatch(); };
    },
  };
}

const preference = createReadingCachePreferenceStore();
export const readReadingCacheLimit = preference.read;
export const saveReadingCacheLimit = preference.save;
export const subscribeReadingCacheLimit = preference.subscribe;

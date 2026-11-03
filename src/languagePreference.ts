export const languagePreferenceKey = "pocket.language.v1";
export type LanguagePreference = "system" | "zh-CN" | "en";
export type PocketLocale = "zh-CN" | "en";

export function normalizeLanguagePreference(value: unknown): LanguagePreference {
  return value === "zh-CN" || value === "en" ? value : "system";
}

export function resolveLanguage(preference: LanguagePreference, languages: readonly string[]): PocketLocale {
  if (preference !== "system") return preference;
  for (const value of languages) {
    const language = typeof value === "string" ? value.toLowerCase().split(/[-_]/)[0] : "";
    if (language === "zh") return "zh-CN";
    if (language === "en") return "en";
  }
  return "en";
}

type LanguageEnvironment = {
  read: () => string | null;
  write: (value: LanguagePreference) => void;
  languages: () => readonly string[];
  listen: (notify: (reason: "storage" | "system") => void) => () => void;
};

// One preference belongs to the client, rather than to a Mac or conversation.
// Storage failure cannot prevent a language change in the current page.
export function createLanguageStore(environment?: LanguageEnvironment) {
  const read = () => {
    try { return normalizeLanguagePreference(environment?.read()); } catch { return "system" as const; }
  };
  let preference = read();
  const locale = () => environment ? resolveLanguage(preference, environment.languages()) : preference === "system" ? "zh-CN" as const : preference;
  let snapshot = `${preference}:${locale()}`;
  const listeners = new Set<() => void>();
  let release: (() => void) | undefined;
  const notify = () => {
    const next = `${preference}:${locale()}`;
    if (snapshot === next) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    getPreference: () => preference,
    getLocale: locale,
    setPreference(value: LanguagePreference) {
      preference = normalizeLanguagePreference(value);
      try { environment?.write(preference); } catch { /* Session preference stays usable. */ }
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) release = environment?.listen(reason => { if (reason === "storage") preference = read(); notify(); });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { release?.(); release = undefined; }
      };
    },
  };
}

export const languageStore = createLanguageStore(typeof window === "undefined" || !window.navigator ? undefined : {
  read: () => window.localStorage.getItem(languagePreferenceKey),
  write: value => window.localStorage.setItem(languagePreferenceKey, value),
  languages: () => window.navigator.languages?.length ? window.navigator.languages : [window.navigator.language],
  listen: notify => {
    const storage = (event: StorageEvent) => { if (event.key === languagePreferenceKey || event.key === null) notify("storage"); };
    const system = () => notify("system");
    window.addEventListener("storage", storage);
    window.addEventListener("languagechange", system);
    return () => { window.removeEventListener("storage", storage); window.removeEventListener("languagechange", system); };
  },
});

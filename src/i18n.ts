import { useSyncExternalStore } from "react";
import { languageStore, type LanguagePreference } from "./languagePreference.ts";
import { currentLocale } from "./i18nCore.ts";
export { currentLocale, t, formatDate, englishMessages } from "./i18nCore.ts";
const appliedLanguages = new WeakMap<Document, string>();
export function setLanguagePreference(value: LanguagePreference) {
  languageStore.setPreference(value);
  applyDocumentLanguage();
}
export function applyDocumentLanguage() {
  if (typeof document === "undefined" || !document.documentElement) return;
  const locale = currentLocale();
  document.documentElement.lang = locale;
  if (appliedLanguages.get(document) === locale) return;
  appliedLanguages.set(document, locale);
  if (typeof window !== "undefined" && typeof window.CustomEvent === "function")
    window.dispatchEvent(new CustomEvent("pocket-language-changed", { detail: locale }));
}
export function useLocale() {
  useSyncExternalStore(languageStore.subscribe, languageStore.getSnapshot, languageStore.getSnapshot);
  applyDocumentLanguage();
  return currentLocale();
}
applyDocumentLanguage();

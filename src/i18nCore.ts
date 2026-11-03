import i18next from "i18next";
import { languageStore } from "./languagePreference.ts";
import core from "./locales/en/core.json" with { type: "json" };
import navigation from "./locales/en/navigation.json" with { type: "json" };
import conversation from "./locales/en/conversation.json" with { type: "json" };
import settings from "./locales/en/settings-media.json" with { type: "json" };

export const englishMessages: Record<string, string> = { ...core, ...navigation, ...conversation, ...settings };
const engine = i18next.createInstance();
void engine.init({
  lng: languageStore.getLocale(), fallbackLng: "zh-CN", supportedLngs: ["en", "zh-CN"],
  load: "currentOnly", initAsync: false, keySeparator: false, nsSeparator: false,
  resources: { en: { translation: englishMessages } },
  interpolation: { escapeValue: false }, returnNull: false,
});

export function currentLocale() { return languageStore.getLocale(); }
export function t(source: string, values: Record<string, unknown> = {}): string {
  return engine.t(source, { ...values, lng: currentLocale(), defaultValue: source }) as string;
}
export function formatDate(value: number | Date, options: Intl.DateTimeFormatOptions = {
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
}) {
  return new Intl.DateTimeFormat(currentLocale(), options).format(value);
}

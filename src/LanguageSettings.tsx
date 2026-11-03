import { useId } from "react";
import { t, useLocale, setLanguagePreference } from "./i18n";
import { languageStore, resolveLanguage, type LanguagePreference } from "./languagePreference";
import "./language-settings.css";

export default function LanguageSettings() {
  useLocale();
  const id = useId();
  const system = typeof navigator === "undefined" ? "zh-CN" : resolveLanguage("system", navigator.languages?.length ? navigator.languages : [navigator.language]);
  return <section className="language-setting" aria-label={t("语言设置")}>
    <div className="language-setting-row">
      <label htmlFor={id}>{t("语言")}</label>
      <select id={id} value={languageStore.getPreference()} onChange={event => setLanguagePreference(event.target.value as LanguagePreference)} aria-describedby={`${id}-help`}>
        <option value="system">{t("跟随系统（{{language}}）", { language: system === "zh-CN" ? "简体中文" : "English" })}</option>
        <option value="zh-CN">简体中文</option>
        <option value="en">English</option>
      </select>
    </div>
    <p id={`${id}-help`} className="field-help">{t("默认跟随系统，也可以单独选择。")}</p>
  </section>;
}

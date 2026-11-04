import { t, useLocale } from "./i18n";
import { useId, useState, useSyncExternalStore } from "react";
import { trimReadingCache } from "./readingCache";
import { defaultReadingCacheLimit, readingCacheLimitOptions, readReadingCacheLimit, saveReadingCacheLimit, subscribeReadingCacheLimit } from "./readingCachePreference";
import "./reading-cache-settings.css";

export default function ReadingCacheSettings() {
  useLocale();
  const limit = useSyncExternalStore(subscribeReadingCacheLimit, readReadingCacheLimit, readReadingCacheLimit);
  const [temporary, setTemporary] = useState(false);
  const id = useId();
  return <section className="reading-cache-setting" aria-label={t("阅读缓存")}>
    <div className="reading-cache-setting-row">
      <label htmlFor={id}>{t("最多缓存会话")}</label>
      <select id={id} value={limit} aria-describedby={`${id}-help`} onChange={event => {
        const result = saveReadingCacheLimit(Number(event.currentTarget.value));
        setTemporary(!result.persisted);
        // This only trims cached copies. Drafts, authentication and the current
        // conversation remain owned by their existing controllers.
        void trimReadingCache();
      }}>
        {readingCacheLimitOptions.map(value => <option key={value} value={value}>{t(value === defaultReadingCacheLimit ? "{{count}} 个（默认）" : "{{count}} 个", { count: value })}</option>)}
      </select>
    </div>
    <p id={`${id}-help`} className="field-help">{t("保留近期读过的会话，最多使用 30 MiB。")}</p>
    {temporary && <p className="field-help" role="status">{t("浏览器未允许保存设置，仅本次使用生效。")}</p>}
  </section>;
}

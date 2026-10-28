import { useId, useState, useSyncExternalStore } from "react";
import { trimReadingCache } from "./readingCache";
import { defaultReadingCacheLimit, readingCacheLimitOptions, readReadingCacheLimit, saveReadingCacheLimit, subscribeReadingCacheLimit } from "./readingCachePreference";
import "./reading-cache-settings.css";

export default function ReadingCacheSettings() {
  const limit = useSyncExternalStore(subscribeReadingCacheLimit, readReadingCacheLimit, readReadingCacheLimit);
  const [temporary, setTemporary] = useState(false);
  const id = useId();
  return <section className="reading-cache-setting" aria-label="阅读缓存">
    <div className="reading-cache-setting-row">
      <label htmlFor={id}>最多缓存会话</label>
      <select id={id} value={limit} aria-describedby={`${id}-help`} onChange={event => {
        const result = saveReadingCacheLimit(Number(event.currentTarget.value));
        setTemporary(!result.persisted);
        // This only trims cached copies. Drafts, authentication and the current
        // conversation remain owned by their existing controllers.
        void trimReadingCache();
      }}>
        {readingCacheLimitOptions.map(value => <option key={value} value={value}>{value} 个{value === defaultReadingCacheLimit ? "（默认）" : ""}</option>)}
      </select>
    </div>
    <p id={`${id}-help`} className="field-help">保留近期读过的会话，最多使用 30 MiB。</p>
    {temporary && <p className="field-help" role="status">浏览器未允许保存设置，仅本次使用生效。</p>}
  </section>;
}

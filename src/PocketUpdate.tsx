import { t, useLocale } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { createAppUpdate, type AppVersion } from "./appUpdate";
import { getReloadBlocker } from "./updateSafety";
import { CLIENT_VERSION, clientVersionHeaders } from "./clientVersion";

export default function PocketUpdate({ taskId }: { taskId: string | null }) {
  useLocale();
  const [available, setAvailable] = useState<AppVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const selected = useRef(taskId);
  selected.current = taskId;
  useEffect(() => setHint(""), [taskId]);
  const entryUrl = () => {
    const url = new URL(location.href);
    if (selected.current) url.searchParams.set("task", selected.current);
    else url.searchParams.delete("task");
    return url.pathname + url.search;
  };
  const [update] = useState(() => createAppUpdate({
    currentId: CLIENT_VERSION,
    request: (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(clientVersionHeaders())) headers.set(name, value);
      return fetch(input, { ...init, headers });
    },
    blocker: getReloadBlocker,
    entryUrl,
    onAvailable: version => setAvailable(old => old?.id === version?.id ? old : version),
    reload() {
      history.replaceState(history.state, "", entryUrl());
      location.reload();
    },
  }));
  useEffect(() => {
    update.resume();
    let lastCheck = -Infinity;
    const check = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine || Date.now() - lastCheck < 60000) return;
      lastCheck = Date.now();
      void update.check();
    };
    check();
    const reconnect = () => { lastCheck = -Infinity; check(); };
    const timer = window.setInterval(check, 300000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", reconnect);
    window.addEventListener("pageshow", check);
    return () => {
      update.stop();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("pageshow", check);
    };
  }, [update]);
  if (!available) return null;
  return <div className="pocket-update" role="status">
    <div className="pocket-update-copy"><span>{t("Pocket 有新版本")}</span>{hint && <small>{t(hint)}</small>}</div>
    <button type="button" disabled={busy} aria-label={t("更新 Pocket")} onClick={async () => {
      setBusy(true);
      setHint("");
      const result = await update.apply();
      if (result.status !== "updated") {
        setBusy(false);
        setHint(result.reason || (result.status === "current" ? "已经是最新版本。" : "稍后再试。"));
      }
    }}><RefreshCw size={14} className={busy ? "spinning" : undefined} />{busy ? t("检查中…") : t("更新")}</button>
  </div>;
}

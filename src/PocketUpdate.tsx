import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { createAppUpdate, type AppVersion } from "./appUpdate";
import { getReloadBlocker } from "./updateSafety";

export default function PocketUpdate({ taskId }: { taskId: string | null }) {
  const [available, setAvailable] = useState<AppVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = useRef(taskId);
  selected.current = taskId;
  const entryUrl = () => {
    const url = new URL(location.href);
    if (selected.current) url.searchParams.set("task", selected.current);
    else url.searchParams.delete("task");
    return url.pathname + url.search;
  };
  const [update] = useState(() => createAppUpdate({
    currentId: typeof __POCKET_BUILD_ID__ === "string" ? __POCKET_BUILD_ID__ : "development",
    request: (input, init) => fetch(input, init),
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
    <span>Pocket 有新版本</span>
    <button type="button" disabled={busy} aria-label="更新 Pocket" onClick={async () => {
      setBusy(true);
      const result = await update.apply();
      if (result.status !== "updated") {
        setBusy(false);
        toast(result.reason || (result.status === "current" ? "已经是最新版本。" : "稍后再试。"), { id: "pocket-update", duration: 4000 });
      }
    }}><RefreshCw size={14} className={busy ? "spinning" : undefined} />{busy ? "检查中…" : "更新"}</button>
  </div>;
}

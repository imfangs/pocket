import { AppIcon } from "./ui/AppIcon";
import { t as tr, useLocale } from "./i18n";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { persistentCollectionFailureAt, type ReadHealth } from "./readHealth";
import "./collection-feedback.css";

export default function CollectionReadFeedback({ hasCatalog, pending, syncPending = pending, error, stale = false, cachedStatus = false, cachedList = false, readHealth = [], retry }: {
  hasCatalog: boolean;
  pending: boolean;
  syncPending?: boolean;
  error: string;
  stale?: boolean;
  cachedStatus?: boolean;
  cachedList?: boolean;
  readHealth?: readonly ReadHealth[];
  retry: () => void;
}) {
  useLocale();
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [, tick] = useState(0);
  const warningAt = persistentCollectionFailureAt(readHealth);
  const now = typeof performance === "undefined" ? 0 : performance.now();
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  useEffect(() => {
    if (warningAt === null || warningAt <= performance.now()) return;
    const timer = window.setTimeout(() => tick(value => value + 1), warningAt - performance.now());
    return () => window.clearTimeout(timer);
  }, [warningAt]);
  if (!hasCatalog) return <div className="collection-load-state" role="status" data-pending={pending || undefined}>
    {pending ? <><AppIcon icon={RefreshCw} kind="auxiliary" aria-hidden="true" /><p>{tr("正在读取会话…")}</p></>
      : <><h2>{tr("暂时无法读取会话")}</h2><p>{tr(error)}</p>
        <button type="button" className="collection-feedback-retry" aria-label={tr("重试刷新")} onClick={retry}><AppIcon icon={RefreshCw} kind="auxiliary" aria-hidden="true" />{tr("重新读取")}</button></>}
  </div>;
  const mode = !online ? "offline" : warningAt !== null && now >= warningAt ? "unreachable"
    : syncPending ? "syncing" : error || stale || cachedStatus || cachedList || readHealth.some(item => item.failures) ? "waiting" : "idle";
  const warning = mode === "offline" || mode === "unreachable";
  const label = mode === "offline" ? "已离线，联网后自动恢复。" : mode === "unreachable" ? "连接暂未恢复，请重试。"
    : mode === "syncing" ? "正在同步列表…" : mode === "waiting" ? "等待列表同步" : "";
  return <div className="collection-sync-feedback" data-collection-feedback={mode}>
    <div className="collection-sync-line" data-loading={mode === "syncing" || undefined} aria-hidden="true" />
    {warning ? <div className="collection-feedback" role="status">
      <span>{tr(label)}</span>
      <button type="button" className="collection-feedback-retry" aria-label={tr("重试刷新")} onClick={retry}>
        <AppIcon icon={RefreshCw} kind="auxiliary" aria-hidden="true" />{tr("重试")}
      </button>
    </div> : <span className="sr-only">{tr(label)}</span>}
  </div>;
}

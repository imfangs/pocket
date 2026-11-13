import { AppIcon } from "./ui/AppIcon";
import { t as tr, useLocale } from "./i18n";
import { RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { persistentCollectionFailureAt, type ReadHealth, type ReadCompletion } from "./readHealth";
import { createCollectionSyncMotion } from "./collectionSyncMotion";
import "./collection-feedback.css";

export default function CollectionReadFeedback({ hasCatalog, pending, syncPending = pending, error, stale = false, cachedStatus = false, cachedList = false, readHealth = [], motionScope = null, completions = [], currentData = true, retry }: {
  hasCatalog: boolean;
  pending: boolean;
  syncPending?: boolean;
  error: string;
  stale?: boolean;
  cachedStatus?: boolean;
  cachedList?: boolean;
  readHealth?: readonly ReadHealth[];
  motionScope?: string | null;
  completions?: readonly ReadCompletion[];
  currentData?: boolean;
  retry: () => void;
}) {
  useLocale();
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [, tick] = useState(0);
  const warningAt = persistentCollectionFailureAt(readHealth);
  const now = typeof performance === "undefined" ? 0 : performance.now();
  const line = useRef<HTMLDivElement>(null), motion = useRef<ReturnType<typeof createCollectionSyncMotion> | null>(null);
  const mode = !online ? "offline" : warningAt !== null && now >= warningAt ? "unreachable"
    : syncPending ? "syncing" : error || stale || cachedStatus || cachedList || readHealth.some(item => item.failures) ? "waiting" : "idle";
  useLayoutEffect(() => {
    if (!line.current) return;
    const owner = createCollectionSyncMotion(line.current); motion.current = owner;
    return () => { owner.dispose(); if (motion.current === owner) motion.current = null; };
  }, [hasCatalog]);
  useLayoutEffect(() => { motion.current?.observe({ scope: motionScope, pending: syncPending, current: mode === "idle" && currentData, completions }); });
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
  const warning = mode === "offline" || mode === "unreachable";
  const label = mode === "offline" ? "已离线，联网后自动恢复。" : mode === "unreachable" ? "连接暂未恢复，请重试。"
    : mode === "syncing" ? "正在同步列表…" : mode === "waiting" ? "等待列表同步" : "";
  return <div className="collection-sync-feedback" data-collection-feedback={mode}>
    <div ref={line} className="collection-sync-line" data-loading={mode === "syncing" || undefined} aria-hidden="true" />
    {warning ? <div className="collection-feedback" role="status">
      <span>{tr(label)}</span>
      <button type="button" className="collection-feedback-retry" aria-label={tr("重试刷新")} onClick={retry}>
        <AppIcon icon={RefreshCw} kind="auxiliary" aria-hidden="true" />{tr("重试")}
      </button>
    </div> : <span className="sr-only">{tr(label)}</span>}
  </div>;
}

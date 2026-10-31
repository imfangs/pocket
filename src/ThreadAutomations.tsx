import { Clock } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { api } from "./api";
import { currentMachineId, requireMachine } from "./machineScope";
import { threadInfoCache, type ThreadInfoKey } from "./threadInfoCache";
import type { Thread, ThreadAutomationsSource } from "./types";
import "./thread-automations.css";

type Props = { thread: Pick<Thread, "id" | "hostId" | "automationSummary"> };
type CachedAutomations = { source: ThreadAutomationsSource; summaryKey: string };

export default function ThreadAutomations({ thread }: Props) {
  return <ThreadAutomationsSession key={`${currentMachineId()}:${thread.hostId}:${thread.id}`} thread={thread} />;
}

function validSource(value: unknown): value is ThreadAutomationsSource {
  if (!value || typeof value !== "object") return false;
  const source = value as ThreadAutomationsSource;
  return typeof source.available === "boolean" && typeof source.stale === "boolean" && typeof source.timeZone === "string"
    && Array.isArray(source.automations) && source.automations.every(automation => automation && typeof automation.id === "string"
      && typeof automation.name === "string" && typeof automation.prompt === "string" && typeof automation.scheduleLabel === "string"
      && typeof automation.scheduleSupported === "boolean" && ["ACTIVE", "PAUSED", "UNKNOWN"].includes(automation.status));
}

function ThreadAutomationsSession({ thread }: Props) {
  const threadId = thread.id;
  const key = useMemo<ThreadInfoKey>(() => ({ machine: requireMachine(), hostId: thread.hostId, threadId, kind: "automations" }), [thread.hostId, threadId]);
  const summary = thread.automationSummary;
  const summaryKey = JSON.stringify(summary ? [summary.count, summary.activeCount, summary.pausedCount, !!summary.stale] : null);
  const [source, setSource] = useState<ThreadAutomationsSource | null>(() => {
    const cached = threadInfoCache.get<CachedAutomations>(key);
    return !cached ? null : cached.value.summaryKey === summaryKey ? cached.value.source : { ...cached.value.source, stale: true };
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    let timeout: ReturnType<typeof window.setTimeout> | undefined;
    const unsubscribe = threadInfoCache.subscribe(event => {
      if (event.machine && event.machine !== key.machine) return;
      current = false; controller.abort(); window.clearTimeout(timeout);
      setSource(null); setLoading(false); setError("会话信息已变化，请重新读取。");
    });
    const cleanup = () => { current = false; controller.abort(); window.clearTimeout(timeout); unsubscribe(); };
    const cached = threadInfoCache.get<CachedAutomations>(key);
    const matching = cached?.value.summaryKey === summaryKey;
    if (cached) setSource(matching ? cached.value.source : { ...cached.value.source, stale: true });
    if (matching && cached.fresh && attempt === 0) {
      setLoading(false); setError("");
      return cleanup;
    }
    const ticket = threadInfoCache.ticket(key);
    setLoading(true); setError("");
    timeout = window.setTimeout(() => {
      if (!current) return;
      current = false; controller.abort();
      setLoading(false); setError("读取超时，请重试。");
    }, 15000);
    void api<unknown>(`/api/tasks/${encodeURIComponent(threadId)}/automations`, "GET", undefined, { signal: controller.signal })
      .then(next => {
        if (!current || !threadInfoCache.current(key, ticket)) return;
        if (!validSource(next)) throw new Error("Invalid automation response");
        if (next.available && !next.stale) {
          threadInfoCache.put(key, { source: next, summaryKey }, ticket);
          setSource(next);
        } else {
          // An unavailable read cannot erase plans already known in this page.
          setSource(previous => next.automations.length || !previous?.automations.length ? next
            : { ...previous, available: next.available, stale: true });
        }
      })
      .catch(() => { if (current) setError("暂时无法读取定时任务，请重试。"); })
      .finally(() => { window.clearTimeout(timeout); if (current) setLoading(false); });
    return cleanup;
  }, [threadId, key, summaryKey, attempt]);
  return <ThreadAutomationsContent source={source} loading={loading} error={error} onRetry={() => setAttempt(value => value + 1)} />;
}

export function ThreadAutomationsContent({ source, loading = false, error = "", onRetry }: {
  source: ThreadAutomationsSource | null;
  loading?: boolean;
  error?: string;
  onRetry: () => void;
}) {
  const headingId = useId();
  const automations = source?.automations ?? [];
  const stale = !!source && (source.stale || !source.available || !!error);
  const unavailable = !!error || (!!source && !source.available);
  const needsRetry = !!error || !!source?.stale || (!!source && !source.available);
  const status = error || (!loading && (source?.stale || unavailable) ? automations.length > 0
    ? "暂时无法读取最新计划，以下为缓存内容。" : "暂时无法确认是否有关联的定时任务。" : "");
  const empty = !loading && !status && source?.available && !source.stale && automations.length === 0;
  return <section className="thread-automations" aria-labelledby={headingId} aria-busy={loading} data-empty={empty || undefined}>
    <div className="thread-automations-heading">
      <h3 id={headingId}><Clock size={14} aria-hidden="true" />定时任务{automations.length > 0 && <span>{automations.length}</span>}</h3>
      {needsRetry && !loading ? <button type="button" className="text-button" onClick={onRetry}>重新读取</button>
        : <p className="thread-automations-summary" role={loading ? "status" : undefined}>
          {loading ? source ? "正在刷新…" : "正在读取…" : empty ? "暂无关联的定时任务" : ""}
        </p>}
    </div>
    {status && <p className="thread-automations-notice" role={error ? "alert" : "status"}>{status}{error && automations.length > 0 ? " 以下为缓存内容。" : ""}</p>}
    {automations.length > 0 && <ul className="thread-automations-list" data-stale={stale || undefined}>
      {automations.map(automation => <li key={automation.id} className="thread-automation">
        <div className="thread-automation-heading">
          <h4>{automation.name || "未命名任务"}</h4>
          <span className="thread-automation-status" data-status={automation.status}>
            {automation.status === "ACTIVE" ? "已启用" : automation.status === "PAUSED" ? "已暂停" : "状态待确认"}
          </span>
        </div>
        <p className="thread-automation-schedule">{automation.scheduleLabel || "暂无法读取执行安排"}</p>
        <details className="thread-automation-content">
          <summary>任务内容</summary>
          <p>{automation.prompt || "未提供任务内容"}</p>
        </details>
      </li>)}
    </ul>}
  </section>;
}

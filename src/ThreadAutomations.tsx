import { Clock } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { api } from "./api";
import type { Thread, ThreadAutomationsSource } from "./types";
import "./thread-automations.css";

type Props = { thread: Pick<Thread, "id" | "hostId"> };

export default function ThreadAutomations({ thread }: Props) {
  return <ThreadAutomationsSession key={`${thread.hostId}:${thread.id}`} threadId={thread.id} />;
}

function validSource(value: unknown): value is ThreadAutomationsSource {
  if (!value || typeof value !== "object") return false;
  const source = value as ThreadAutomationsSource;
  return typeof source.available === "boolean" && typeof source.stale === "boolean" && typeof source.timeZone === "string"
    && Array.isArray(source.automations) && source.automations.every(automation => automation && typeof automation.id === "string"
      && typeof automation.name === "string" && typeof automation.prompt === "string" && typeof automation.scheduleLabel === "string"
      && typeof automation.scheduleSupported === "boolean" && ["ACTIVE", "PAUSED", "UNKNOWN"].includes(automation.status));
}

function ThreadAutomationsSession({ threadId }: { threadId: string }) {
  const [source, setSource] = useState<ThreadAutomationsSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setLoading(true); setError("");
    const timeout = window.setTimeout(() => {
      if (!current) return;
      current = false; controller.abort();
      setLoading(false); setError("读取超时，请重试。");
    }, 15000);
    void api<unknown>(`/api/tasks/${encodeURIComponent(threadId)}/automations`, "GET", undefined, { signal: controller.signal })
      .then(next => {
        if (!current) return;
        if (!validSource(next)) throw new Error("Invalid automation response");
        setSource(next);
      })
      .catch(() => { if (current) setError("暂时无法读取定时任务，请重试。"); })
      .finally(() => { window.clearTimeout(timeout); if (current) setLoading(false); });
    return () => { current = false; controller.abort(); window.clearTimeout(timeout); };
  }, [threadId, attempt]);
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
  const status = error || (source?.stale || unavailable ? automations.length > 0
    ? "暂时无法读取最新计划，以下为缓存内容。" : "暂时无法确认是否有关联的定时任务。" : "");
  return <section className="thread-automations" aria-labelledby={headingId} aria-busy={loading}>
    <div className="thread-automations-heading">
      <h3 id={headingId}><Clock size={14} aria-hidden="true" />定时任务{automations.length > 0 && <span>{automations.length}</span>}</h3>
      {needsRetry && <button type="button" className="text-button" disabled={loading} onClick={onRetry}>重新读取</button>}
    </div>
    {loading && <p className="thread-automations-notice" role="status">{source ? "正在刷新…" : "正在读取…"}</p>}
    {status && <p className="thread-automations-notice" role={error ? "alert" : "status"}>{status}{error && automations.length > 0 ? " 以下为缓存内容。" : ""}</p>}
    {!loading && !status && source?.available && !source.stale && automations.length === 0
      && <p className="thread-automations-notice">暂无关联的定时任务</p>}
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

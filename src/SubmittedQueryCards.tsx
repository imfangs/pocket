import { useState } from "react";
import { CheckCircle2, Copy } from "lucide-react";
import { submittedQueryLabel, type SubmittedQuery } from "./submittedQueries";
import "./submitted-queries.css";

export default function SubmittedQueryCards({ items, connecting, paused, disabled, check, dismiss }: {
  items: readonly SubmittedQuery[];
  connecting: boolean;
  paused: boolean;
  disabled: boolean;
  check: (item: SubmittedQuery) => Promise<void>;
  dismiss: (requestId: string) => void;
}) {
  const [checking, setChecking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");
  const verify = async (item: SubmittedQuery) => {
    if (checking) return;
    setChecking(item.requestId); setError("");
    try { await check(item); }
    catch (error) { setError((error as Error).message || "暂时无法核对，原文已保留。"); }
    finally { setChecking(null); }
  };
  const copy = async (item: SubmittedQuery) => {
    try { await navigator.clipboard.writeText(item.text); setCopied(item.requestId); setError(""); }
    catch { setError("未能复制，可以长按原文选择复制。"); }
  };
  if (!items.length) return null;
  return <section className="submitted-queries" aria-label="已提交的消息">
    {items.map(item => {
      const accepted = item.status === "accepted", waiting = ["submitting", "connecting", "pending", "queued", "not_queued"].includes(item.status);
      const canDismiss = ["rejected", "not_found", "cancelled"].includes(item.status);
      return <article key={item.requestId} className={`submitted-query${item.status === "queued" && !paused && !disabled ? " is-queue-breathing" : ""}`}
        data-submission-id={item.requestId} data-submission-status={item.status} data-feedback-state={accepted ? "accepted" : waiting ? "pending" : item.status}>
        <div className="submitted-query-heading"><strong>你</strong><span role="status">{accepted && <CheckCircle2 size={13} aria-hidden="true" />}{submittedQueryLabel(item, connecting)}</span></div>
        <p className="submitted-query-text">{item.text}</p>
        <div className="submitted-query-actions">
          <small>{accepted ? "原任务已收到，消息出现前会保留在这里。" : item.status === "unknown" ? "原文已保留；核对不会重复发送。" : canDismiss ? "原文已保留，可复制后编辑。" : "原文已保留，状态会继续同步。"}</small>
          <button type="button" aria-label="复制已提交消息" onClick={() => void copy(item)}><Copy size={13} aria-hidden="true" />{copied === item.requestId ? "已复制" : "复制"}</button>
          <button type="button" disabled={disabled || !!checking} onClick={() => void verify(item)}>{checking === item.requestId ? "正在核对…" : accepted ? "刷新历史" : "核对状态"}</button>
          {canDismiss && <button type="button" onClick={() => dismiss(item.requestId)}>收起</button>}
        </div>
      </article>;
    })}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}

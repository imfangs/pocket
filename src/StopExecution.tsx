import { IconButton } from "./ui/IconButton";
import { useEffect, useState } from "react";
import { Square, RefreshCw, LoaderCircle } from "lucide-react";
import { api } from "./api";
import type { History, StopReceipt } from "./conversationFeed";
import { holdReload, useReloadGuard } from "./updateSafety";

const pending = (status?: string) => ["pending", "accepted", "unknown"].includes(status || "");
const resultText = (status: string) => status === "stopped" ? "当前执行已中断，待发消息保留并暂停自动发送。"
  : status === "ended" ? "这一轮已经结束，待发消息已暂停。"
  : status === "rejected" ? "执行状态已变化，未中断新的执行。请刷新后重试。"
  : "已请求中断，正在核对执行状态。";
export default function StopExecution({ threadId, history, disabled, refresh, notify, onInteractionChange }: {
  threadId: string; history: History | null; disabled: boolean;
  refresh: () => Promise<void> | undefined; notify: (text: string) => void;
  onInteractionChange?: (active: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<StopReceipt | null>(null);
  const receipt = attempt && history?.stopRequest?.requestId !== attempt.requestId ? attempt : history?.stopRequest || attempt;
  const waiting = pending(receipt?.status);
  const interacting = busy || waiting;
  useEffect(() => {
    onInteractionChange?.(interacting);
    return () => onInteractionChange?.(false);
  }, [interacting, onInteractionChange]);
  useReloadGuard(() => busy ? "停止操作尚未完成，请稍后更新。"
    : attempt && waiting ? "停止结果尚待核对，请处理后再更新。" : null);
  useEffect(() => {
    const result = history?.stopRequest;
    if (attempt && result?.requestId === attempt.requestId && !pending(result.status)) {
      notify(resultText(result.status)); setAttempt(null);
    }
  }, [history?.stopRequest, attempt, notify]);
  const stop = async () => {
    if (busy || disabled) return;
    const release = holdReload();
    setBusy(true);
    const requestId = waiting && receipt ? receipt.requestId : crypto.randomUUID();
    try {
      if (waiting) {
        await refresh();
        const result = await api<StopReceipt>(`/api/tasks/${threadId}/stop/${requestId}`);
        setAttempt(result.status === "not_found" ? null : result);
        notify(result.status === "not_found" ? "未收到停止请求，可以重新点击停止。" : resultText(result.status));
      } else if (history?.canStop && history.activeTurnId) {
        setAttempt({ requestId, targetTurnId: history.activeTurnId, status: "pending" });
        const result = await api<StopReceipt>(`/api/tasks/${threadId}/stop`, "POST", { requestId, expectedTurnId: history.activeTurnId });
        setAttempt(result); notify(resultText(result.status));
        await refresh();
      }
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      setAttempt(status && status < 500 ? null : { requestId, status: "unknown" });
      notify(status && status < 500 ? (error as Error).message : "停止结果待确认，请核对状态；不会自动重复中断。");
    } finally { release(); setBusy(false); }
  };
  if (!history?.canStop && !waiting && !busy) return null;
  return <IconButton type="button" className="stop-execution" disabled={disabled || busy}
    aria-label={busy ? "正在停止执行" : waiting ? "核对停止状态" : "停止当前执行"}
    aria-busy={busy} data-waiting={waiting || busy || undefined}
    onPointerDown={event => { if (event.button === 0) event.preventDefault(); }}
    title="中断当前执行，保留会话和待发消息" onClick={() => void stop()}>
    <span className="stop-execution-disc">
      {busy ? <LoaderCircle className="stop-spinner" size={16} aria-hidden="true" /> : waiting ? <RefreshCw size={15} aria-hidden="true" /> : <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" />}
    </span>
  </IconButton>;
}

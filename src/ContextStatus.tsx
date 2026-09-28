import { useState } from "react";
import type { History } from "./conversationFeed";
import { api } from "./api";

const labels: Record<string, string> = {
  pending: "正在提交压缩…", accepted: "压缩已提交，等待完成…", unknown: "压缩结果待核对，不会自动重试",
  completed: "上下文压缩已完成", failed: "压缩未完成，请检查原任务", rejected: "未启动压缩，可以稍后重试",
};
export default function ContextStatus({ threadId, history, disabled, refresh }: {
  threadId: string; history: History | null; disabled: boolean; refresh: () => Promise<void> | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [uncertainId, setUncertainId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const usage = history?.contextUsage;
  const status = history?.compactionRequest?.status;
  const pending = !!uncertainId || ["pending", "accepted", "unknown"].includes(status || "");
  const act = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const id = uncertainId || crypto.randomUUID();
    try {
      if (pending) {
        await refresh();
        if (uncertainId) {
          const result = await api<{ status: string }>(`/api/tasks/${threadId}/compact/${id}`);
          if (result.status !== "unknown" && result.status !== "pending") setUncertainId(null);
        }
      } else {
        setUncertainId(id);
        await api(`/api/tasks/${threadId}/compact`, "POST", { requestId: id });
        setUncertainId(null);
        await refresh();
      }
    } catch (e) {
      if ((e as Error & {status?: number}).status && (e as Error & {status:number}).status < 500) setUncertainId(null);
      setError((e as Error).message);
    } finally { setBusy(false); }
  };
  return <div className="context-status">
    <details>
      <summary>{usage ? `上下文 ${Math.round(usage.percent)}%` : "上下文用量暂不可用"}</summary>
      <p>{usage ? `${usage.usedTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens，剩余 ${usage.remainingTokens.toLocaleString()}。与桌面同口径，按最近一次模型用量更新。` : "连接原任务后显示桌面报告的用量，不根据聊天字数估算。"}</p>
      <p>压缩会把较早内容总结为较短上下文，可能省略细节。任务空闲且待发列表为空时可使用。</p>
    </details>
    <button type="button" className="context-compact" disabled={disabled || busy || (!pending && !history?.canCompact)} onClick={() => void act()}>
      {busy ? "处理中…" : pending ? "核对压缩状态" : "压缩上下文"}
    </button>
    {(history?.compaction?.active || status || uncertainId || error) && <p className={error ? "inline-error" : "context-operation"} role="status">
      {error || (history?.compaction?.active ? "正在压缩上下文…" : uncertainId ? "提交结果待核对，不会自动重试" : labels[status || ""])}
    </p>}
  </div>;
}

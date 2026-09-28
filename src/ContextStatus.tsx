import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { History } from "./conversationFeed";
import { api } from "./api";

const labels: Record<string, string> = {
  pending: "正在提交压缩…",
  accepted: "压缩已提交，等待完成…",
  unknown: "压缩结果待核对，不会自动重试",
  failed: "压缩未完成，请检查原任务",
  rejected: "未启动压缩，可以稍后重试",
};
export default function ContextStatus({
  threadId,
  history,
  disabled,
  refresh,
}: {
  threadId: string;
  history: History | null;
  disabled: boolean;
  refresh: () => Promise<void> | undefined;
}) {
  const [busy, setBusy] = useState(false);
  const [uncertainId, setUncertainId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const watchedRequest = useRef<string | null>(null);
  const usage = history?.contextUsage;
  const status = history?.compactionRequest?.status;
  const pending =
    !!uncertainId || ["pending", "accepted", "unknown"].includes(status || "");
  const requestId = history?.compactionRequest?.requestId;
  useEffect(() => {
    if (!requestId) return;
    if (["pending", "accepted", "unknown"].includes(status || "")) watchedRequest.current = requestId;
    if (status === "completed" && watchedRequest.current === requestId) {
      watchedRequest.current = null;
      toast.success("上下文压缩已完成", { id: `compact-${requestId}`, duration: 3500 });
    }
  }, [requestId, status]);
  const act = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    const id = uncertainId || crypto.randomUUID();
    try {
      if (pending) {
        await refresh();
        if (uncertainId) {
          const result = await api<{ status: string }>(
            `/api/tasks/${threadId}/compact/${id}`,
          );
          if (result.status !== "unknown" && result.status !== "pending")
            setUncertainId(null);
        }
      } else {
        setUncertainId(id);
        watchedRequest.current = id;
        await api(`/api/tasks/${threadId}/compact`, "POST", { requestId: id });
        setUncertainId(null);
        await refresh();
      }
    } catch (e) {
      if (
        (e as Error & { status?: number }).status &&
        (e as Error & { status: number }).status < 500
      )
        setUncertainId(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="context-status">
      <Popover.Root>
        <Popover.Trigger className="context-trigger">
          {usage && (
            <svg
              className="context-ring"
              width="15"
              height="15"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <circle cx="10" cy="10" r="7" />
              <circle
                cx="10"
                cy="10"
                r="7"
                pathLength="100"
                strokeDasharray={`${Math.min(100, Math.max(0, usage.percent))} 100`}
              />
            </svg>
          )}
          {history?.compaction?.active
            ? "压缩中…"
            : pending
              ? "压缩待核对"
              : usage
                ? `上下文 ${Math.round(usage.percent)}%`
                : "上下文"}
          <ChevronDown size={12} aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="context-popover"
            sideOffset={8}
            collisionPadding={16}
            align="start"
            aria-label="上下文用量与压缩"
          >
            <p>
              {usage
                ? `${usage.usedTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens，剩余 ${usage.remainingTokens.toLocaleString()}。按最近一次模型用量更新。`
                : "连接原任务后可查看上下文用量。"}
            </p>
            <p>
              压缩会将较早内容总结为较短上下文，可能省略细节。压缩期间会暂停待发消息。
            </p>
            {!pending && history?.runtime === "active" && <p>本轮正在执行，结束后可手动压缩。</p>}
            {!pending && history?.source !== "desktop" && history?.canAttemptCompact && <p>点击后会先连接原任务，核验空闲状态。</p>}
            <button
              type="button"
              className="context-compact"
              disabled={disabled || busy || (!pending && !(history?.canAttemptCompact ?? history?.canCompact))}
              onClick={() => void act()}
            >
              {busy ? "处理中…" : pending ? "核对压缩状态" : "压缩上下文"}
            </button>
            {(history?.compaction?.active ||
              labels[status || ""] ||
              uncertainId ||
              error) && (
              <p
                className={error ? "inline-error" : "context-operation"}
                role="status"
              >
                {error ||
                  (history?.compaction?.active
                    ? "正在压缩上下文…"
                    : uncertainId
                      ? "提交结果待核对，不会自动重试"
                      : labels[status || ""])}
              </p>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

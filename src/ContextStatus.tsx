import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { History } from "./conversationFeed";
import { api } from "./api";
import { holdReload, useReloadGuard } from "./updateSafety";

const labels: Record<string, string> = {
  pending: "正在提交…",
  accepted: "等待完成…",
  unknown: "结果待核对",
  failed: "压缩未完成",
  rejected: "未启动，可重试",
};
export default function ContextStatus({
  threadId,
  history,
  disabled,
  refresh,
  onInteractionChange,
}: {
  threadId: string;
  history: History | null;
  disabled: boolean;
  refresh: () => Promise<void> | undefined;
  onInteractionChange?: (active: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { window.dispatchEvent(new Event("pocket-reading-visibility-change")); }, [open]);
  const [uncertainId, setUncertainId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const watchedRequest = useRef<string | null>(null);
  const pointerOpened = useRef(false);
  const usage = history?.contextUsage;
  const status = history?.compactionRequest?.status;
  const pending =
    !!uncertainId || ["pending", "accepted", "unknown"].includes(status || "");
  const interacting = open || busy || pending || !!history?.compaction?.active;
  useEffect(() => {
    onInteractionChange?.(interacting);
    return () => onInteractionChange?.(false);
  }, [interacting, onInteractionChange]);
  const requestId = history?.compactionRequest?.requestId;
  const usageLabel = usage ? `上下文用量 ${Math.round(usage.percent)}%` : "上下文用量与压缩";
  const triggerLabel = `${usageLabel}${history?.compaction?.active ? "，压缩中" : pending ? "，压缩结果待核对" : ""}`;
  useReloadGuard(() => busy ? "压缩操作尚未完成，请稍后更新。"
    : uncertainId && !(requestId === uncertainId && status && !["pending", "unknown"].includes(status))
      ? "压缩结果尚待核对，请处理后再更新。" : null);
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
    const release = holdReload();
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
      release();
      setBusy(false);
    }
  };
  return (
    <div className="context-status">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger type="button" className="context-trigger" title={triggerLabel} aria-label={triggerLabel}
          onPointerDown={event => {
            // Keep the composer layout stable until click opens the popover.
            // Keyboard focus and activation retain their normal behavior.
            if (event.button === 0) { pointerOpened.current = true; event.preventDefault(); }
          }}>
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
                ? `${Math.round(usage.percent)}%`
                : "上下文"}
          <ChevronDown size={12} aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="context-popover"
            data-reading-overlay=""
            side="top"
            sideOffset={8}
            collisionPadding={16}
            align="start"
            aria-label="上下文用量与压缩"
            onCloseAutoFocus={event => {
              // Pointer readers return to the compact input; keyboard users
              // retain the trigger as their next focus target.
              if (pointerOpened.current) event.preventDefault();
              pointerOpened.current = false;
            }}
          >
            <p className="context-usage">
              {usage
                ? `${usage.usedTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`
                : "用量暂不可用"}
            </p>
            <button
              type="button"
              className="context-compact"
              disabled={disabled || busy || (!pending && !(history?.canAttemptCompact ?? history?.canCompact))}
              onClick={() => void act()}
            >
              {busy ? "处理中…" : pending ? "核对状态" : history?.compaction?.active ? "正在压缩…" : history?.runtime === "active" ? "执行中，稍后压缩" : "压缩上下文"}
            </button>
            {(labels[status || ""] ||
              uncertainId ||
              error) && (
              <p
                className={error ? "inline-error" : "context-operation"}
                role="status"
              >
                {error ||
                  (uncertainId ? "结果待核对" : labels[status || ""])}
              </p>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

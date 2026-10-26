import * as Popover from "@radix-ui/react-popover";
import { Button } from "./ui/Button";
import { PocketPortalTheme } from "./ui/PocketTheme";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { History } from "./conversationFeed";
import { api } from "./api";
import { holdReload, useReloadGuard } from "./updateSafety";
import { controlReceipt, controlUnresolved, useControlRequest, type ControlReceipt } from "./controlRequests";
import { compactionKeepsComposerExpanded } from "./composerStatus";

const labels: Record<string, string> = {
  pending: "正在提交…",
  accepted: "等待完成…",
  unknown: "结果待核对",
  failed: "压缩未完成",
  rejected: "未启动，可重试",
  not_found: "未收到压缩请求，可以重新点击压缩。",
};
export default function ContextStatus({
  threadId,
  history,
  compact = false,
  disabled,
  refresh,
  onInteractionChange,
}: {
  threadId: string;
  history: History | null;
  compact?: boolean;
  disabled: boolean;
  refresh: () => Promise<void> | undefined;
  onInteractionChange?: (active: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { window.dispatchEvent(new Event("pocket-reading-visibility-change")); }, [open]);
  const { owner, state } = useControlRequest(threadId, "compact");
  const [error, setError] = useState("");
  const watchedRequest = useRef<string | null>(null);
  const acting = useRef(false);
  const pointerOpened = useRef(false);
  const usage = history?.contextUsage;
  useEffect(() => { owner.observe(history?.compactionRequest); }, [owner, history?.compactionRequest]);
  const receipt = controlReceipt(state, history?.compactionRequest);
  const status = receipt?.status;
  const pending = controlUnresolved(status);
  const uncertain = status === "unknown";
  const working = busy || !!state?.posting;
  // Opening a control in the reading bar must not move it into a larger editor.
  const interacting = (!compact && (open || working)) || compactionKeepsComposerExpanded(status);
  useEffect(() => {
    onInteractionChange?.(interacting);
    return () => onInteractionChange?.(false);
  }, [interacting, onInteractionChange]);
  const requestId = receipt?.requestId;
  const usageLabel = usage ? `上下文用量 ${Math.round(usage.percent)}%` : "上下文用量与压缩";
  const triggerLabel = `${usageLabel}${uncertain ? "，压缩结果待核对" : history?.compaction?.active ? "，压缩中" : pending ? "，压缩结果待核对" : ""}`;
  useReloadGuard(() => working ? "压缩操作尚未完成，请稍后更新。"
    : pending ? "压缩结果尚待核对，请处理后再更新。" : null);
  useEffect(() => {
    if (!requestId) return;
    if (status && !controlUnresolved(status)) setError("");
    if (["pending", "accepted", "unknown"].includes(status || "")) watchedRequest.current = requestId;
    if (status === "completed" && watchedRequest.current === requestId) {
      watchedRequest.current = null;
      toast.success("上下文压缩已完成", { id: `compact-${requestId}`, duration: 3500 });
    }
  }, [requestId, status]);
  const act = async () => {
    if (disabled || acting.current || owner.getSnapshot()?.posting) return;
    owner.observe(history?.compactionRequest);
    const current = controlReceipt(owner.getSnapshot(), history?.compactionRequest);
    const checking = controlUnresolved(current?.status);
    if (!checking && !(history?.canAttemptCompact ?? history?.canCompact)) return;
    const id = checking && current ? current.requestId : crypto.randomUUID();
    if (!checking && !owner.begin(id)) {
      setError("暂时无法保留操作进度，请重新打开 Pocket 后再试。");
      return;
    }
    acting.current = true;
    const release = holdReload();
    setBusy(true);
    setError("");
    try {
      if (checking) {
        await refresh();
        const result = await api<ControlReceipt>(`/api/tasks/${threadId}/compact/${id}`);
        if (result.requestId !== id) throw new Error("压缩回执编号不匹配，请重新核对。");
        owner.receive(result, "check");
      } else {
        watchedRequest.current = id;
        const result = await api<ControlReceipt>(`/api/tasks/${threadId}/compact`, "POST", { requestId: id });
        if (result.requestId !== id) throw new Error("压缩回执编号不匹配，请重新核对。");
        owner.receive(result, "post");
      }
      await refresh();
    } catch (e) {
      // An HTTP error is not a receipt for the original request. Keep its ID,
      // including when the component that started it has already unmounted.
      owner.receive({ requestId: id, status: "unknown" }, checking ? "check" : "post");
      const current = owner.getSnapshot();
      if (current?.identity.requestId === id && controlUnresolved(current.status)) setError((e as Error).message);
    } finally {
      if (!checking) owner.finishPost(id);
      acting.current = false;
      release();
      setBusy(false);
    }
  };
  return (
    <div ref={root} className="context-status" data-ongoing={history?.compaction?.active || pending || open || working || undefined}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger type="button" className="context-trigger" title={triggerLabel} aria-label={triggerLabel} data-composer-reading-control={compact ? "" : undefined}
          onPointerDown={event => {
            // Keep the composer layout stable until click opens the popover.
            // Keyboard focus and activation retain their normal behavior.
            if (event.button === 0) {
              pointerOpened.current = true;
              if (event.pointerType !== "touch") event.preventDefault();
            }
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
          {uncertain ? "压缩待核对" : history?.compaction?.active
            ? "压缩中…"
            : pending
              ? "压缩待核对"
              : usage
                ? `${Math.round(usage.percent)}%`
                : "上下文"}
          <ChevronDown size={12} aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <PocketPortalTheme>
          <Popover.Content
            className="context-popover"
            data-reading-overlay=""
            side="top"
            sideOffset={8}
            collisionPadding={16}
            align="start"
            aria-label="上下文用量与压缩"
            onCloseAutoFocus={event => {
              // Preserve outside pointer focus; keyboard dismissal needs a
              // visible destination even if compaction just finished.
              const trigger = root.current?.querySelector(".context-trigger");
              if (trigger && !trigger.getClientRects().length) {
                // Completion can remove this reading-bar trigger. Preserve an
                // outside click's destination; otherwise return to the reader.
                event.preventDefault();
                const active = document.activeElement;
                if (active === document.body || active === trigger || !active?.isConnected ||
                    event.target instanceof Element && event.target.contains(active))
                  root.current?.closest(".conversation")?.querySelector<HTMLElement>(".conversation-messages")?.focus({ preventScroll: true });
              } else if (pointerOpened.current) event.preventDefault();
              pointerOpened.current = false;
            }}
          >
            <p className="context-usage">
              {usage
                ? `${usage.usedTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`
                : "用量暂不可用"}
            </p>
            <Button variant="soft"
              type="button"
              className="context-compact"
              disabled={disabled || working || (!pending && !(history?.canAttemptCompact ?? history?.canCompact))}
              onClick={() => void act()}
            >
              {working ? "处理中…" : pending ? "核对状态" : history?.compaction?.active ? "正在压缩…" : history?.runtime === "active" ? "执行中，稍后压缩" : "压缩上下文"}
            </Button>
            {(labels[status || ""] ||
              error) && (
              <p
                className={error ? "inline-error" : "context-operation"}
                role="status"
              >
                {error || labels[status || ""]}
              </p>
            )}
          </Popover.Content>
          </PocketPortalTheme>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

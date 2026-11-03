import { t, useLocale } from "./i18n";
import { IconButton } from "./ui/IconButton";
import { useEffect, useRef, useState } from "react";
import { Square, RefreshCw, LoaderCircle } from "lucide-react";
import { api } from "./api";
import type { History, StopReceipt } from "./conversationFeed";
import { holdReload, useReloadGuard } from "./updateSafety";
import { controlReceipt, controlUnresolved, useControlRequest } from "./controlRequests";

const resultText = (status: string) => status === "stopped" ? "当前执行已中断，待发消息保留并暂停自动发送。"
  : status === "ended" ? "这一轮已经结束，待发消息已暂停。"
  : status === "rejected" ? "执行状态已变化，未中断新的执行。请刷新后重试。"
  : status === "not_found" ? "未收到停止请求，可以重新点击停止。"
  : "已请求中断，正在核对执行状态。";
export default function StopExecution({ threadId, history, disabled, refresh, notify, onInteractionChange }: {
  threadId: string; history: History | null; disabled: boolean;
  refresh: () => Promise<void> | undefined; notify: (text: string) => void;
  onInteractionChange?: (active: boolean) => void;
}) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const { owner, state } = useControlRequest(threadId, "stop");
  const acting = useRef(false), watched = useRef<string | null>(null);
  useEffect(() => { owner.observe(history?.stopRequest); }, [owner, history?.stopRequest]);
  const receipt = controlReceipt(state, history?.stopRequest);
  const waiting = controlUnresolved(receipt?.status);
  const working = busy || !!state?.posting;
  const interacting = working || waiting;
  useEffect(() => {
    onInteractionChange?.(interacting);
    return () => onInteractionChange?.(false);
  }, [interacting, onInteractionChange]);
  useReloadGuard(() => working ? "停止操作尚未完成，请稍后更新。"
    : waiting ? "停止结果尚待核对，请处理后再更新。" : null);
  useEffect(() => {
    if (state?.posting || state && controlUnresolved(state.status)) watched.current = state.identity.requestId;
    else if (state && watched.current === state.identity.requestId) {
      watched.current = null;
      notify(resultText(state.status));
    }
  }, [state, notify]);
  const stop = async () => {
    if (disabled || acting.current || owner.getSnapshot()?.posting) return;
    owner.observe(history?.stopRequest);
    const current = controlReceipt(owner.getSnapshot(), history?.stopRequest);
    const checking = controlUnresolved(current?.status);
    if (!checking && !(history?.canStop && history.activeTurnId)) return;
    const requestId = checking && current ? current.requestId : crypto.randomUUID();
    if (!checking && !owner.begin(requestId, history?.activeTurnId || undefined)) {
      notify("暂时无法保留操作进度，请重新打开 Pocket 后再试。");
      return;
    }
    watched.current = requestId;
    acting.current = true;
    const release = holdReload();
    setBusy(true);
    try {
      if (checking) {
        await refresh();
        const result = await api<StopReceipt>(`/api/tasks/${threadId}/stop/${requestId}`);
        if (result.requestId !== requestId) throw new Error("停止回执编号不匹配，请重新核对。");
        owner.receive(result, "check");
        const current = owner.getSnapshot();
        if (current?.identity.requestId === requestId && controlUnresolved(current.status)) notify(resultText(current.status));
      } else if (history?.canStop && history.activeTurnId) {
        const result = await api<StopReceipt>(`/api/tasks/${threadId}/stop`, "POST", { requestId, expectedTurnId: history.activeTurnId });
        if (result.requestId !== requestId) throw new Error("停止回执编号不匹配，请重新核对。");
        owner.receive(result, "post");
        const current = owner.getSnapshot();
        if (current?.identity.requestId === requestId && controlUnresolved(current.status)) notify(resultText(current.status));
      }
      await refresh();
    } catch {
      owner.receive({ requestId, status: "unknown" }, checking ? "check" : "post");
      const current = owner.getSnapshot();
      if (current?.identity.requestId === requestId && controlUnresolved(current.status)) notify("停止结果待确认，请核对状态；不会自动重复中断。");
    } finally { if (!checking) owner.finishPost(requestId); acting.current = false; release(); setBusy(false); }
  };
  if (!history?.canStop && !waiting && !working) return null;
  return <IconButton type="button" className="stop-execution" data-composer-reading-control="" disabled={disabled || working}
    aria-label={working ? t("正在停止执行") : waiting ? t("核对停止状态") : t("停止当前执行")}
    aria-busy={working} data-waiting={waiting || working || undefined}
    onPointerDown={event => { if (event.button === 0 && event.pointerType !== "touch") event.preventDefault(); }}
    title={t("中断当前执行，保留会话和待发消息")} onClick={() => void stop()}>
    <span className="stop-execution-disc">
      {working ? <LoaderCircle className="stop-spinner" size={16} aria-hidden="true" /> : waiting ? <RefreshCw size={15} aria-hidden="true" /> : <Square size={11} strokeWidth={0} fill="currentColor" aria-hidden="true" />}
    </span>
  </IconButton>;
}

import AutoTextarea from "./AutoTextarea";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QueuedMessage } from "./conversationFeed";
import type { QueryDraft } from "./Conversation";
import { api } from "./api";
import { waitForSubmission, type SubmissionReceipt } from "./submissionReceipt";
import { holdReload, useReloadGuard } from "./updateSafety";
import { captureDraft } from "./draftTransaction";

type Action = "edit" | "save" | "cancel" | "send" | "check" | "resume";
export default function Outbox({ threadId, items, paused, disabled, allowSend, connectionPending, refresh, drafts, onActivity }: {
  threadId: string;
  items: QueuedMessage[];
  paused?: { stopId: string } | null;
  disabled: boolean;
  allowSend: boolean;
  connectionPending?: boolean;
  onActivity?: () => void;
  refresh: () => Promise<void> | undefined;
  drafts: Map<string, QueryDraft>;
}) {
  const [editing, setEditing] = useState<{ id: string; revision: number } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const key = (id: string) => `${threadId}/outbox/${id}`;
  const receiptRead = useRef<AbortController | null>(null);
  const viewGeneration = useRef(0);
  const section = useRef<HTMLElement>(null);
  const focusNext = useRef<{ id: string; target: "editor" | "action" } | null>(null);
  useReloadGuard(() => busy ? "待发消息的操作尚未完成，请稍后更新。"
    : editing ? "待发消息还在编辑，请保存或取消编辑后再更新。" : null);
  useEffect(() => () => { viewGeneration.current++; receiptRead.current?.abort(); }, [threadId]);
  useLayoutEffect(() => {
    if (busy || disabled || !focusNext.current) return;
    const desired = focusNext.current;
    const row = [...(section.current?.querySelectorAll<HTMLElement>("[data-outbox-id]") ?? [])]
      .find(element => element.dataset.outboxId === desired.id);
    const target = row?.querySelector<HTMLElement>(desired.target === "editor" ? "textarea" : '[data-outbox-action="edit"]');
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    }
    focusNext.current = null;
  }, [editing, busy, disabled, items]);
  useEffect(() => {
    const leave = (event: FocusEvent) => {
      if (focusNext.current?.target === "action" && event.target instanceof Node && !section.current?.contains(event.target)) focusNext.current = null;
    };
    document.addEventListener("focusin", leave);
    return () => document.removeEventListener("focusin", leave);
  }, []);
  useEffect(() => {
    if (!editing) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing]);
  const act = async (item: QueuedMessage, action: Action) => {
    if (busy) return;
    const release = holdReload();
    const generation = viewGeneration.current;
    const currentView = () => viewGeneration.current === generation;
    const saved = captureDraft(drafts, key(item.id));
    const controller = action === "send" ? new AbortController() : null;
    if (controller) receiptRead.current = controller;
    setBusy(item.id); setError("");
    try {
      const base = `/api/tasks/${threadId}/outbox/${item.id}`;
      const expectedRevision = editing?.id === item.id ? editing.revision : item.revision;
      if (action === "check") await refresh();
      else if (action === "edit") {
        const updated = item.status === "editing" ? item :
          (await api<{ outbox: QueuedMessage[] }>(`${base}/edit`, "POST", { expectedRevision })).outbox.find(row => row.id === item.id)!;
        if (!currentView() || !saved.current()) return;
        const value = drafts.get(key(item.id))?.text ?? updated.text;
        focusNext.current = { id: item.id, target: "editor" };
        setEditing({ id: item.id, revision: updated.revision }); setText(value);
        saved.set({ text: value, revision: updated.revision });
        // The pause response already owns this revision. A slow history read
        // should not hold the editor disabled after that acknowledgement.
        void refresh()?.catch(() => {});
      } else {
        let result = await api<SubmissionReceipt>(action === "send" ? `${base}/send` : action === "resume" ? `${base}/resume` : base,
          action === "save" ? "PATCH" : action === "cancel" ? "DELETE" : "POST",
          { expectedRevision, ...(action === "save" ? { text } : {}) });
        if (controller) {
          if (!currentView() || controller.signal.aborted) return;
          result = await waitForSubmission(result, signal => api<SubmissionReceipt>(`/api/tasks/${threadId}/messages/${item.id}`, "GET", undefined, { signal }), controller.signal);
          if (!currentView() || controller.signal.aborted) return;
        }
        if (action === "send" && result.status === "accepted") onActivity?.();
        // Settled saves can release their unchanged draft after leaving, but
        // must never discard a newer edit made in a reopened view.
        if (saved.clear() && currentView()) {
          if (editing?.id === item.id) focusNext.current = { id: item.id, target: "action" };
          setEditing(null);
        }
        if (currentView()) await refresh();
      }
    } catch (e) { if (currentView()) setError((e as Error).message); }
    finally {
      release();
      if (controller && receiptRead.current === controller) receiptRead.current = null;
      if (currentView()) setBusy(null);
    }
  };
  const resumeQueue = async () => {
    if (!paused || busy) return;
    const release = holdReload();
    setBusy("queue"); setError("");
    try {
      await api(`/api/tasks/${threadId}/queue/resume`, "POST", { expectedStopId: paused.stopId });
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { release(); setBusy(null); }
  };
  if (!items.length) return null;
  return (
    <section ref={section} className="outbox" aria-label="Pocket 待发消息">
      <div className="outbox-heading"><strong>待发送 · {items.length}</strong><span>{items[0]?.status === "unknown" ? "等待核对首条消息，自动发送已暂停" : paused ? "自动发送已暂停" : connectionPending ? "已保存在 Mac，连接恢复后依次发送" : "当前轮完成后依次发送"}</span>
        {paused && <button className="resume-queue" disabled={disabled || !!busy || !allowSend} onClick={() => void resumeQueue()}>恢复排队</button>}
      </div>
      {items.map((item, index) => {
        const mutable = ["queued", "rejected", "editing"].includes(item.status);
        return <div className="outbox-item" key={item.id} data-outbox-id={item.id} role="group" aria-label={`待发消息 ${index + 1}`} aria-busy={busy === item.id}>
          {editing?.id === item.id ? <AutoTextarea aria-label="编辑待发消息" value={text} maxLength={16000} disabled={!!busy || disabled}
            onChange={e => { setText(e.target.value); drafts.set(key(item.id), { text: e.target.value, revision: editing.revision }); }} />
            : <p className="outbox-text">{drafts.get(key(item.id))?.text ?? item.text}</p>}
          <div className="outbox-actions">
            <small>{busy === item.id || item.status === "pending" ? "正在提交…" :
              item.status === "unknown" ? "结果待确认，不会自动重发" :
              item.status === "editing" ? "编辑中，已暂停发送" :
              item.status === "rejected" ? "发送未完成，可编辑后重试" : paused ? "已暂停" : "排队中"}</small>
            {editing?.id === item.id ? <>
              <button disabled={!!busy || disabled || !text.trim()} onClick={() => void act(item, "save")}>保存</button>
              <button disabled={!!busy || disabled} onClick={() => void act(item, "resume")}>取消编辑</button>
            </> : mutable ? <>
              <button data-outbox-action="edit" aria-label={`${item.status === "editing" ? "继续编辑" : "编辑"}第 ${index + 1} 条待发消息`} disabled={!!busy || disabled} onClick={() => void act(item, "edit")}>{item.status === "editing" ? "继续编辑" : "编辑"}</button>
              <button aria-label={`删除第 ${index + 1} 条待发消息`} disabled={!!busy || disabled} onClick={() => void act(item, "cancel")}>删除</button>
              <button aria-label={`${item.status === "editing" ? "恢复排队" : "直接发送"}第 ${index + 1} 条消息`} disabled={!!busy || disabled || (!allowSend && item.status !== "editing")} onClick={() => void act(item, item.status === "editing" ? "resume" : "send")}>{item.status === "editing" ? "恢复排队" : "直接发送"}</button>
            </> : <button disabled={!!busy || disabled} onClick={() => void act(item, "check")}>核对状态</button>}
          </div>
        </div>;
      })}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section>
  );
}

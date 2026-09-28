import AutoTextarea from "./AutoTextarea";
import { useEffect, useState } from "react";
import type { QueuedMessage } from "./conversationFeed";
import type { QueryDraft } from "./Conversation";
import { api } from "./api";

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
  useEffect(() => {
    if (!editing) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editing]);
  const act = async (item: QueuedMessage, action: Action) => {
    if (busy) return;
    setBusy(item.id); setError("");
    try {
      const base = `/api/tasks/${threadId}/outbox/${item.id}`;
      const expectedRevision = editing?.id === item.id ? editing.revision : item.revision;
      if (action === "check") await refresh();
      else if (action === "edit") {
        const updated = item.status === "editing" ? item :
          (await api<{ outbox: QueuedMessage[] }>(`${base}/edit`, "POST", { expectedRevision })).outbox.find(row => row.id === item.id)!;
        const value = drafts.get(key(item.id))?.text ?? updated.text;
        setEditing({ id: item.id, revision: updated.revision }); setText(value);
        drafts.set(key(item.id), { text: value, revision: updated.revision });
        await refresh();
      } else {
        const result = await api<{status?: string}>(action === "send" ? `${base}/send` : action === "resume" ? `${base}/resume` : base,
          action === "save" ? "PATCH" : action === "cancel" ? "DELETE" : "POST",
          { expectedRevision, ...(action === "save" ? { text } : {}) });
        if (action === "send" && result.status === "accepted") onActivity?.();
        drafts.delete(key(item.id)); setEditing(null);
        await refresh();
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  const resumeQueue = async () => {
    if (!paused || busy) return;
    setBusy("queue"); setError("");
    try {
      await api(`/api/tasks/${threadId}/queue/resume`, "POST", { expectedStopId: paused.stopId });
      await refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  };
  if (!items.length) return null;
  return (
    <section className="outbox" aria-label="Pocket 待发消息">
      <div className="outbox-heading"><strong>待发送 · {items.length}</strong><span>{paused ? "自动发送已暂停" : connectionPending ? "已保存在 Mac，连接恢复后依次发送" : "当前轮完成后依次发送"}</span>
        {paused && <button className="resume-queue" disabled={disabled || !!busy || !allowSend} onClick={() => void resumeQueue()}>恢复排队</button>}
      </div>
      {items.map(item => {
        const mutable = ["queued", "rejected", "editing"].includes(item.status);
        return <div className="outbox-item" key={item.id}>
          {editing?.id === item.id ? <AutoTextarea aria-label="编辑待发消息" value={text} maxLength={16000}
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
              <button disabled={!!busy || disabled} onClick={() => void act(item, "edit")}>{item.status === "editing" ? "继续编辑" : "编辑"}</button>
              <button disabled={!!busy || disabled} onClick={() => void act(item, "cancel")}>删除</button>
              <button disabled={!!busy || disabled || (!allowSend && item.status !== "editing")} onClick={() => void act(item, item.status === "editing" ? "resume" : "send")}>{item.status === "editing" ? "恢复排队" : "直接发送"}</button>
            </> : <button disabled={!!busy || disabled} onClick={() => void act(item, "check")}>核对状态</button>}
          </div>
        </div>;
      })}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </section>
  );
}

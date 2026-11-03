import { t, useLocale } from "./i18n";
import AutoTextarea from "./AutoTextarea";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { QueuedMessage } from "./conversationFeed";
import type { QueryDraft } from "./Conversation";
import { api } from "./api";
import { waitForSubmission, type SubmissionReceipt } from "./submissionReceipt";
import { holdReload, useReloadGuard } from "./updateSafety";
import { captureDraft } from "./draftTransaction";
import { queueFeedbackState, queueHeadState } from "./submissionFeedback";
import type { SubmittedQueryReceipt, SubmittedQueryStore } from "./submittedQueries";
import { withSubmittedQueryPost } from "./submittedQueries";
import AttachmentList from "./AttachmentList";
import { attachmentDraftController } from "./attachments";
import "./submission-feedback.css";
import "./submitted-queries.css";
import { NO_HANDOFF_IDS, useHandoffRows } from "./useReceiptHandoff";
import { isNetworkError, readableRequestError } from "./requestError";

type Action = "edit" | "save" | "cancel" | "send" | "check" | "resume";
type OutboxError = { status: QueuedMessage["status"]; revision: number; failure: unknown };
const matchesError = (error: OutboxError, item: QueuedMessage) => error.status === item.status && error.revision === item.revision;
const outboxKey = (item: QueuedMessage) => item.id;
export default function Outbox({ threadId, items, paused, disabled, allowSend, connectionPending, refresh, drafts, submissions, onActivity, onAccepted, onAttachmentRecovery, suppressNetworkErrors = false, exitIds = NO_HANDOFF_IDS, explicitExitIds = NO_HANDOFF_IDS, inlineTargets, focusRoot }: {
  threadId: string;
  items: QueuedMessage[];
  paused?: { stopId: string } | null;
  disabled: boolean;
  allowSend: boolean;
  connectionPending?: boolean;
  onActivity?: () => void;
  onAccepted?: (receipt: SubmissionReceipt) => void;
  onAttachmentRecovery?: (recovered: number, error?: string) => void;
  refresh: () => Promise<void> | undefined;
  drafts: Map<string, QueryDraft>;
  submissions?: SubmittedQueryStore;
  suppressNetworkErrors?: boolean;
  exitIds?: ReadonlySet<string>;
  explicitExitIds?: ReadonlySet<string>;
  inlineTargets?: ReadonlyMap<string, HTMLElement>;
  focusRoot?: RefObject<HTMLElement | null>;
}) {
  useLocale();
  const presence = useHandoffRows(items, outboxKey, inlineTargets ? NO_HANDOFF_IDS : exitIds, explicitExitIds);
  const inlineNodes = useRef(new Map<string, HTMLElement>());
  const inlineRefs = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const inlineRef = (id: string) => {
    let bind = inlineRefs.current.get(id);
    if (!bind) {
      bind = node => {
        const previous = inlineNodes.current.get(id);
        if (!node && previous?.contains(previous.ownerDocument.activeElement))
          previous.closest<HTMLElement>("article[data-message-id]")?.focus({ preventScroll: true });
        if (node) inlineNodes.current.set(id, node); else inlineNodes.current.delete(id);
      };
      inlineRefs.current.set(id, bind);
    }
    return bind;
  };
  const focusedInline = inlineTargets ? [...inlineNodes.current.values()].find(node => node.contains(node.ownerDocument.activeElement)) : undefined;
  const focusedControl = focusedInline?.ownerDocument.activeElement;
  const focusedMessage = focusedInline?.closest<HTMLElement>("article[data-message-id]");
  useLayoutEffect(() => {
    // A state change may remove a button without replacing the portal wrapper.
    // Restore only focus lost by that removal; a user's new destination wins.
    const doc = focusedInline?.ownerDocument;
    if (focusedControl && !focusedControl.isConnected && focusedMessage?.isConnected &&
        (!doc?.activeElement || doc.activeElement === doc.body)) focusedMessage.focus({ preventScroll: true });
  });
  const [editing, setEditing] = useState<{ id: string; revision: number } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState(new Map<string, OutboxError>());
  const [queueError, setQueueError] = useState<{ stopId: string; failure: unknown } | null>(null);
  const [acceptedItems, setAcceptedItems] = useState(new Set<string>());
  const currentItems = useRef(items);
  currentItems.current = items;
  const clearError = (id: string) => setErrors(previous => {
    if (!previous.has(id)) return previous;
    const next = new Map(previous); next.delete(id); return next;
  });
  const recordError = (item: QueuedMessage, failure: unknown) => {
    const current = currentItems.current.find(value => value.id === item.id && value.revision === item.revision);
    if (!current) return;
    const receipt = submissions?.getThread(threadId).find(value => value.requestId === item.id);
    const status = receipt?.queueRevision === item.revision ? receipt.status : current.status;
    if (!["queued", "editing", "pending", "unknown", "rejected"].includes(status)) return;
    // Sending may have just advanced the shared receipt to unknown before the
    // parent render. Bind the error to that current receipt, not its old button.
    if (item.status !== current.status && status !== "unknown") return;
    setErrors(previous => new Map(previous).set(item.id, { status: status as QueuedMessage["status"], revision: item.revision, failure }));
  };
  useEffect(() => {
    setErrors(previous => {
      const next = new Map([...previous].filter(([id, error]) => items.some(item => item.id === id && !acceptedItems.has(id) && matchesError(error, item))));
      return next.size === previous.size ? previous : next;
    });
  }, [items, acceptedItems]);
  useEffect(() => { setQueueError(previous => previous && previous.stopId !== paused?.stopId ? null : previous); }, [paused?.stopId]);
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
    const row = [...((focusRoot?.current ?? section.current)?.querySelectorAll<HTMLElement>("[data-outbox-id]") ?? [])]
      .find(element => element.dataset.outboxId === desired.id);
    const target = row?.querySelector<HTMLElement>(desired.target === "editor" ? "textarea" : '[data-outbox-action="edit"]');
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    }
    focusNext.current = null;
  }, [editing, busy, disabled, items, focusRoot]);
  useEffect(() => {
    const leave = (event: FocusEvent) => {
      if (focusNext.current?.target === "action" && event.target instanceof Node && !(focusRoot?.current ?? section.current)?.contains(event.target)) focusNext.current = null;
    };
    document.addEventListener("focusin", leave);
    return () => document.removeEventListener("focusin", leave);
  }, [focusRoot]);
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
    submissions?.observeQueue(threadId, [item]);
    if (action === "send") submissions?.receipt(threadId, { requestId: item.id, status: "pending" });
    if (controller) receiptRead.current = controller;
    setBusy(item.id); clearError(item.id);
    try {
      const base = `/api/tasks/${threadId}/outbox/${item.id}`;
      const expectedRevision = editing?.id === item.id ? editing.revision : item.revision;
      if (action === "check") {
        const result = await api<SubmittedQueryReceipt>(`/api/tasks/${threadId}/messages/${item.id}`);
        if (result.requestId !== item.id) throw new Error("回执与这条待发消息不匹配，请核对状态。");
        submissions?.receipt(threadId, result);
        if (currentView() && result.status === "accepted") {
          setAcceptedItems(previous => new Set(previous).add(item.id));
          onActivity?.(); onAccepted?.({ requestId: item.id, status: "accepted" });
        }
        if (currentView()) await refresh();
      }
      else if (action === "edit") {
        const updated = item.status === "editing" ? item :
          (await api<{ outbox: QueuedMessage[] }>(`${base}/edit`, "POST", { expectedRevision })).outbox.find(row => row.id === item.id)!;
        submissions?.observeQueue(threadId, [updated]);
        if (!currentView() || !saved.current()) return;
        const value = drafts.get(key(item.id))?.text ?? updated.text;
        focusNext.current = { id: item.id, target: "editor" };
        setEditing({ id: item.id, revision: updated.revision }); setText(value);
        saved.set({ text: value, revision: updated.revision });
        // The pause response already owns this revision. A slow history read
        // should not hold the editor disabled after that acknowledgement.
        void refresh()?.catch(() => {});
      } else {
        let result = await withSubmittedQueryPost(action === "send" ? submissions : undefined, threadId, item.id,
          () => api<SubmissionReceipt & { outbox?: QueuedMessage[] }>(action === "send" ? `${base}/send` : action === "resume" ? `${base}/resume` : base,
          action === "save" ? "PATCH" : action === "cancel" ? "DELETE" : "POST",
          { expectedRevision, ...(action === "save" ? { text } : {}) }));
        if (result.outbox) submissions?.observeQueue(threadId, result.outbox);
        if (action === "cancel") {
          submissions?.receipt(threadId, { requestId: item.id, status: "cancelled" });
          submissions?.dismiss(threadId, item.id);
          if (item.attachments?.length) {
            try {
              const recovered = await attachmentDraftController(drafts).releaseQueued(threadId, item.attachments.map(file => file.id));
              if (currentView()) onAttachmentRecovery?.(recovered);
            } catch (failure) {
              if (currentView()) onAttachmentRecovery?.(0, (failure as Error).message || "暂时无法载入附件，请重试。");
            }
          }
        }
        if (result.requestId === item.id) submissions?.receipt(threadId, result);
        if (controller) {
          if (!currentView() || controller.signal.aborted) return;
          if (result.requestId !== item.id) throw new Error("回执与这条待发消息不匹配，请核对状态。");
          result = await waitForSubmission(result, signal => api<SubmissionReceipt>(`/api/tasks/${threadId}/messages/${item.id}`, "GET", undefined, { signal }), controller.signal);
          submissions?.receipt(threadId, result);
          if (!currentView() || controller.signal.aborted) return;
        }
        if (action === "send" && result.status === "accepted") {
          setAcceptedItems(previous => new Set(previous).add(item.id));
          onActivity?.(); onAccepted?.(result);
        }
        // Settled saves can release their unchanged draft after leaving, but
        // must never discard a newer edit made in a reopened view.
        if (saved.clear() && currentView()) {
          if (editing?.id === item.id) focusNext.current = { id: item.id, target: "action" };
          setEditing(null);
        }
        if (currentView()) await refresh();
      }
    } catch (e) {
      if (action === "send") submissions?.receipt(threadId, { requestId: item.id, status: "unknown" });
      if (currentView()) recordError(item, e);
    }
    finally {
      release();
      if (controller && receiptRead.current === controller) receiptRead.current = null;
      if (currentView()) setBusy(null);
    }
  };
  const resumeQueue = async () => {
    if (!paused || busy) return;
    const release = holdReload();
    const generation = viewGeneration.current;
    setBusy("queue"); setQueueError(null);
    try {
      await api(`/api/tasks/${threadId}/queue/resume`, "POST", { expectedStopId: paused.stopId });
      await refresh();
    } catch (failure) { if (viewGeneration.current === generation) setQueueError({ stopId: paused.stopId, failure }); }
    finally { release(); if (viewGeneration.current === generation) setBusy(null); }
  };
  const discardEdit = (item: QueuedMessage) => {
    if (busy || editing?.id !== item.id) return;
    // The server acknowledgement already paused this item. Leaving the editor
    // discards only local changes; restoring delivery remains a separate action.
    drafts.delete(key(item.id));
    focusNext.current = { id: item.id, target: "action" };
    setEditing(null); setText(""); clearError(item.id);
  };
  const rows = inlineTargets ? items.map(item => ({ item, leaving: false })) : presence.rows;
  if (!rows.length) return null;
  const { editing: headEditing, blocked: headBlocked } = queueHeadState(items[0] ?? rows[0].item, editing?.id);
  const remainingCount = items.filter(item => item.status !== "accepted" && !acceptedItems.has(item.id)).length;
  const firstInline = inlineTargets ? rows.find(({ item }) => inlineTargets.has(item.id))?.item.id : undefined;
  const queueErrorVisible = queueError && queueError.stopId === paused?.stopId && !(suppressNetworkErrors && isNetworkError(queueError.failure));
  const renderedRows = rows.map(({ item, leaving }, index) => {
        const target = inlineTargets?.get(item.id);
        if (inlineTargets && !target) return null;
        const accepted = item.status === "accepted" || acceptedItems.has(item.id);
        const mutable = !accepted && ["queued", "rejected", "editing"].includes(item.status);
        const error = errors.get(item.id);
        const showError = !accepted && error && matchesError(error, item) && items.some(current => current.id === item.id) &&
          !(suppressNetworkErrors && isNetworkError(error.failure));
        const feedback = queueFeedbackState(item, { accepted, paused: !!paused, editing: editing?.id === item.id, busy: busy === item.id, disabled, headBlocked });
        const row = <div className={`${inlineTargets ? "query-inline-actions outbox-inline-actions" : "outbox-item queue-feedback"}${feedback.breathing && !leaving && !inlineTargets ? " is-queue-breathing" : ""}`} key={item.id} ref={inlineTargets ? inlineRef(item.id) : node => presence.bind(item.id, node)} data-feedback-state={feedback.state} data-query-breathing={inlineTargets && feedback.breathing || undefined} data-outbox-id={item.id} data-query-editing={inlineTargets && editing?.id === item.id || undefined} role="group" aria-label={t("待发消息 {{value1}}", { value1: index + 1 })} aria-busy={busy === item.id}
          onClickCapture={event => { if (leaving) { event.preventDefault(); event.stopPropagation(); } }}>
          {editing?.id === item.id ? <AutoTextarea aria-label={t("编辑待发消息")} value={text} maxLength={16000} disabled={!!busy || disabled}
            onChange={e => { setText(e.target.value); drafts.set(key(item.id), { text: e.target.value, revision: editing.revision }); }} />
            : !inlineTargets && <p className="outbox-text">{drafts.get(key(item.id))?.text ?? item.text}</p>}
          {!inlineTargets && <AttachmentList attachments={item.attachments} />}
          <div className="outbox-actions">
            <small>{accepted ? t("已发送") : busy === item.id || item.status === "pending" ? t("正在提交…") :
              item.status === "unknown" ? t("结果待确认，不会自动重发") :
              item.status === "editing" ? editing?.id === item.id ? t("编辑中，已暂停发送") : t("已暂停") :
              item.status === "rejected" ? t("发送未完成，可编辑后重试") : paused ? t("已暂停") : t("排队中")}</small>
            {editing?.id === item.id ? <>
              <button disabled={!!busy || disabled || (!text.trim() && !item.attachments?.length)} onClick={() => void act(item, "save")}>{paused ? t("保存并保持暂停") : t("保存并排队")}</button>
              <button disabled={!!busy} onClick={() => discardEdit(item)}>{t("放弃修改")}</button>
            </> : mutable ? <>
              <button data-outbox-action="edit" aria-label={t(item.status === "editing" ? "继续编辑第 {{index}} 条待发消息" : "编辑第 {{index}} 条待发消息", { index: index + 1 })} disabled={!!busy || disabled} onClick={() => void act(item, "edit")}>{item.status === "editing" ? t("继续编辑") : t("编辑")}</button>
              <button aria-label={t("删除第 {{value1}} 条待发消息", { value1: index + 1 })} disabled={!!busy || disabled} onClick={() => void act(item, "cancel")}>{t("删除")}</button>
              <button aria-label={t(item.status === "editing" ? "恢复排队第 {{index}} 条消息" : "直接发送第 {{index}} 条消息", { index: index + 1 })} disabled={!!busy || disabled || (!allowSend && item.status !== "editing")} onClick={() => void act(item, item.status === "editing" ? "resume" : "send")}>{item.status === "editing" ? t("恢复排队") : t("直接发送")}</button>
            </> : <button disabled={!!busy || disabled} onClick={() => void act(item, "check")}>{t("核对状态")}</button>}
          </div>
          {inlineTargets && item.id === firstInline && paused && <button className="resume-queue" disabled={disabled || !!busy || !allowSend} onClick={() => void resumeQueue()}>{t("恢复排队")}</button>}
          {showError && <p className="receipt-action-error" role="alert">{t(readableRequestError(error.failure))}</p>}
          {inlineTargets && item.id === firstInline && queueErrorVisible && <p className="receipt-action-error" role="alert">{t(readableRequestError(queueError!.failure))}</p>}
        </div>;
        return target ? createPortal(row, target, item.id) : row;
      });
  if (inlineTargets) return <>{renderedRows}</>;
  return (
    <section ref={section} className="outbox" aria-label={t("Pocket 待发消息")}>
      <div className="outbox-heading" aria-hidden={!items.length || undefined} style={!items.length ? { visibility: "hidden" } : undefined}><strong>{remainingCount ? t("待发送 · {{value1}}", { value1: remainingCount }) : t("已发送")}</strong>{remainingCount > 0 && <span>{items[0]?.status === "unknown" ? t("首条结果待核对，队列已暂停") : paused ? t("队列已暂停") : headEditing ? editing?.id === items[0]?.id ? t("首条编辑中，队列已暂停") : t("首条已暂停") : items[0]?.status === "rejected" ? t("首条发送未完成，请先处理") : connectionPending ? t("连接恢复后依次发送") : items[0]?.autoDirect === true ? t("可接收时依次发送") : t("本轮结束后依次发送")}</span>}
        {paused && <button className="resume-queue" disabled={disabled || !!busy || !allowSend} onClick={() => void resumeQueue()}>{t("恢复排队")}</button>}
      </div>
      {renderedRows}
      {queueErrorVisible &&
        <p className="receipt-action-error" role="alert">{t(readableRequestError(queueError.failure))}</p>}
    </section>
  );
}

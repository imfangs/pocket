import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Copy } from "lucide-react";
import { expectedSubmittedAttachmentCount, pendingSubmittedUpload, submittedQueryDisplayStatus, submittedQueryLabel, submittedUploadCanRetry, submittedUploadNeedsCheck, type SubmittedQuery, type SubmittedUploadActions } from "./submittedQueries";
import "./submitted-queries.css";
import AttachmentList from "./AttachmentList";
import { NO_HANDOFF_IDS, useHandoffRows } from "./useReceiptHandoff";
import { isNetworkError, readableRequestError } from "./requestError";
import SubmittedUploadDetails from "./SubmittedUploadDetails";
const submissionKey = (item: SubmittedQuery) => item.requestId;
type CardError = { status: SubmittedQuery["status"]; revision?: number; failure: unknown };
const matchesError = (error: CardError, item: SubmittedQuery) => error.status === item.status && error.revision === item.queueRevision;

function SubmittedQueryText({ text }: { text: string }) {
  useLocale();
  const id = useId(), body = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false), [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () => setOverflows(element.getBoundingClientRect().height > parseFloat(getComputedStyle(element).lineHeight) * 2 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  return <div className="submitted-query-preview" data-overflows={overflows || undefined}>
    <div id={id} className="submitted-query-body" data-expanded={expanded}>
      <p ref={body} className="submitted-query-text">{text}</p>
    </div>
    {overflows && <button type="button" className="submitted-query-disclosure" aria-expanded={expanded} aria-controls={id} aria-label={expanded ? t("收起原文") : t("展开原文")}
      onPointerDown={event => { if (event.button === 0 && event.pointerType !== "touch") event.preventDefault(); }}
      onClick={() => setExpanded(value => !value)}>{expanded ? t("收起") : t("展开")}</button>}
  </div>;
}

export default function SubmittedQueryCards({ items, connecting, paused, disabled, check, dismiss, restore, uploadActions, suppressNetworkErrors = false, exitIds = NO_HANDOFF_IDS, explicitExitIds = NO_HANDOFF_IDS, inlineTargets }: {
  items: readonly SubmittedQuery[];
  connecting: boolean;
  paused: boolean;
  disabled: boolean;
  check: (item: SubmittedQuery) => Promise<void>;
  dismiss: (requestId: string) => void;
  restore?: (item: SubmittedQuery) => Promise<void>;
  uploadActions?: SubmittedUploadActions;
  suppressNetworkErrors?: boolean;
  exitIds?: ReadonlySet<string>;
  explicitExitIds?: ReadonlySet<string>;
  inlineTargets?: ReadonlyMap<string, HTMLElement>;
}) {
  useLocale();
  const presence = useHandoffRows(items, submissionKey, inlineTargets ? NO_HANDOFF_IDS : exitIds, explicitExitIds);
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
    const doc = focusedInline?.ownerDocument;
    if (focusedControl && !focusedControl.isConnected && focusedMessage?.isConnected &&
        (!doc?.activeElement || doc.activeElement === doc.body)) focusedMessage.focus({ preventScroll: true });
  });
  const [checking, setChecking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const [errors, setErrors] = useState(new Map<string, CardError>());
  const [restoring, setRestoring] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState<string | null>(null);
  const currentItems = useRef(items);
  currentItems.current = items;
  const clearError = (requestId: string) => setErrors(previous => {
    if (!previous.has(requestId)) return previous;
    const next = new Map(previous); next.delete(requestId); return next;
  });
  const recordError = (item: SubmittedQuery, failure: unknown) => {
    const error = { status: item.status, revision: item.queueRevision, failure };
    if (currentItems.current.some(current => current.requestId === item.requestId && matchesError(error, current)))
      setErrors(previous => new Map(previous).set(item.requestId, error));
  };
  useEffect(() => {
    setErrors(previous => {
      const next = new Map([...previous].filter(([requestId, error]) => items.some(item => item.requestId === requestId && matchesError(error, item))));
      return next.size === previous.size ? previous : next;
    });
  }, [items]);
  const editAgain = async (item: SubmittedQuery) => {
    if (!restore || restoring) return;
    setRestoring(item.requestId); clearError(item.requestId);
    try { await restore(item); } catch (error) { recordError(item, error); }
    finally { setRestoring(null); }
  };
  const verify = async (item: SubmittedQuery) => {
    if (checking) return;
    setChecking(item.requestId); clearError(item.requestId);
    try { if (uploadActions && pendingSubmittedUpload(item)) await uploadActions.check(item.requestId); else await check(item); }
    catch (error) { recordError(item, error); }
    finally { setChecking(null); }
  };
  const actOnUpload = async (item: SubmittedQuery, action: "retry" | "cancel") => {
    if (!uploadActions || uploadBusy || checking) return;
    setUploadBusy(item.requestId); clearError(item.requestId);
    try { await uploadActions[action](item.requestId); }
    catch (error) { recordError(item, error); }
    finally { setUploadBusy(null); }
  };
  const copy = async (item: SubmittedQuery) => {
    try { await navigator.clipboard.writeText(item.text); setCopied(item.requestId); clearError(item.requestId); }
    catch { recordError(item, new Error("未能复制，可长按文字复制。")); }
  };
  const rows = inlineTargets ? items.map(item => ({ item, leaving: false })) : presence.rows;
  if (!rows.length) return null;
  const Row = inlineTargets ? "div" : "article";
  const renderedRows = rows.map(({ item, leaving }) => {
      const target = inlineTargets?.get(item.requestId);
      if (inlineTargets && !target) return null;
      const status = submittedQueryDisplayStatus(item), uploadPending = pendingSubmittedUpload(item), uploadUnknown = uploadPending && submittedUploadNeedsCheck(item);
      const accepted = item.status === "accepted", waiting = ["uploading", "submitting", "connecting", "pending", "queued", "not_queued"].includes(status);
      const breathing = ["uploading", "queued"].includes(status) && !uploadUnknown && !paused && !disabled && !leaving;
      const canDismiss = ["rejected", "not_found", "cancelled"].includes(item.status);
      const error = errors.get(item.requestId);
      const showError = error && matchesError(error, item) && items.some(current => current.requestId === item.requestId) &&
        !(suppressNetworkErrors && isNetworkError(error.failure));
      const row = <Row key={item.requestId} ref={inlineTargets ? inlineRef(item.requestId) : node => presence.bind(item.requestId, node)} className={`${inlineTargets ? "query-inline-actions submission-inline-actions" : "submitted-query"}${breathing && !inlineTargets ? " is-queue-breathing" : ""}`}
        onClickCapture={event => { if (leaving) { event.preventDefault(); event.stopPropagation(); } }}
        data-submission-id={item.requestId} data-submission-status={status} data-feedback-state={accepted ? "accepted" : uploadUnknown ? "unknown" : paused && ["uploading", "queued"].includes(status) ? "paused" : waiting ? "pending" : status}
        data-query-breathing={inlineTargets && breathing || undefined}>
        <div className="submitted-query-heading">
          <span role="status">{accepted && <AppIcon icon={CheckCircle2} kind="marker" aria-hidden="true" />}{t(submittedQueryLabel(item, connecting), { uploaded: item.uploadProgress?.uploaded ?? 0, total: expectedSubmittedAttachmentCount(item) })}</span>
          <div className="submitted-query-primary-actions">
            {!inlineTargets && item.text.trim() && <button type="button" className="submitted-query-copy" aria-label={copied === item.requestId ? t("已复制已提交消息") : t("复制已提交消息")}
              title={copied === item.requestId ? t("已复制") : t("复制已提交消息")} onClick={() => void copy(item)}>
              {copied === item.requestId ? <span>{t("已复制")}</span> : <AppIcon icon={Copy} kind="action" aria-hidden="true" />}
            </button>}
            <button type="button" disabled={disabled || !!checking || !!uploadBusy} title={item.status === "unknown" || uploadUnknown ? t("核对不会重复发送") : undefined}
              onClick={() => void verify(item)}>{checking === item.requestId ? t("正在核对…") : accepted ? t("刷新历史") : t("核对状态")}</button>
          </div>
          {item.status === "unknown" && <span className="sr-only">{t("核对不会重复发送。")}</span>}
        </div>
        {!inlineTargets && item.text.trim() && <SubmittedQueryText text={item.text} />}
        {!inlineTargets && <AttachmentList attachments={item.attachments} />}
        {uploadPending && <SubmittedUploadDetails items={item.attachmentUploads} />}
        {uploadPending && uploadActions && <div className="submitted-query-actions">
          {submittedUploadCanRetry(item) && <button type="button" disabled={disabled || !!checking || !!uploadBusy} onClick={() => void actOnUpload(item, "retry")}>{t("重试失败附件")}</button>}
          <button type="button" disabled={disabled || !!checking || !!uploadBusy} onClick={() => void actOnUpload(item, "cancel")}>{t("取消发送")}</button>
        </div>}
        {(canDismiss || restore && ["rejected", "not_found"].includes(item.status)) && <div className="submitted-query-actions">
          {restore && ["rejected", "not_found"].includes(item.status) && <button type="button" disabled={disabled || !!checking || !!restoring} onClick={() => void editAgain(item)}>{restoring === item.requestId ? t("正在取回…") : t("重新编辑")}</button>}
          {canDismiss && <button type="button" onClick={() => dismiss(item.requestId)}>{t("收起")}</button>}
        </div>}
        {showError && <p className="receipt-action-error submitted-query-error" role="alert">{t(readableRequestError(error.failure, "暂时无法核对，请稍后再试。"))}</p>}
      </Row>;
      return target ? createPortal(row, target, item.requestId) : row;
    });
  return inlineTargets ? <>{renderedRows}</> : <section className="submitted-queries" aria-label={t("已提交的消息")}>{renderedRows}</section>;
}

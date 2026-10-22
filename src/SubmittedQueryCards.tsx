import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CheckCircle2, Copy } from "lucide-react";
import { submittedQueryLabel, type SubmittedQuery } from "./submittedQueries";
import "./submitted-queries.css";
import AttachmentList from "./AttachmentList";
import { NO_HANDOFF_IDS, useHandoffRows } from "./useReceiptHandoff";
import { isNetworkError, readableRequestError } from "./requestError";
const submissionKey = (item: SubmittedQuery) => item.requestId;
type CardError = { status: SubmittedQuery["status"]; revision?: number; failure: unknown };
const matchesError = (error: CardError, item: SubmittedQuery) => error.status === item.status && error.revision === item.queueRevision;

function SubmittedQueryText({ text }: { text: string }) {
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
    {overflows && <button type="button" className="submitted-query-disclosure" aria-expanded={expanded} aria-controls={id} aria-label={expanded ? "收起原文" : "展开原文"}
      onPointerDown={event => { if (event.button === 0 && event.pointerType !== "touch") event.preventDefault(); }}
      onClick={() => setExpanded(value => !value)}>{expanded ? "收起" : "展开"}</button>}
  </div>;
}

export default function SubmittedQueryCards({ items, connecting, paused, disabled, check, dismiss, restore, suppressNetworkErrors = false, exitIds = NO_HANDOFF_IDS, explicitExitIds = NO_HANDOFF_IDS }: {
  items: readonly SubmittedQuery[];
  connecting: boolean;
  paused: boolean;
  disabled: boolean;
  check: (item: SubmittedQuery) => Promise<void>;
  dismiss: (requestId: string) => void;
  restore?: (item: SubmittedQuery) => Promise<void>;
  suppressNetworkErrors?: boolean;
  exitIds?: ReadonlySet<string>;
  explicitExitIds?: ReadonlySet<string>;
}) {
  const presence = useHandoffRows(items, submissionKey, exitIds, explicitExitIds);
  const [checking, setChecking] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  const [errors, setErrors] = useState(new Map<string, CardError>());
  const [restoring, setRestoring] = useState<string | null>(null);
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
    try { await check(item); }
    catch (error) { recordError(item, error); }
    finally { setChecking(null); }
  };
  const copy = async (item: SubmittedQuery) => {
    try { await navigator.clipboard.writeText(item.text); setCopied(item.requestId); clearError(item.requestId); }
    catch { recordError(item, new Error("未能复制，可长按文字复制。")); }
  };
  if (!presence.rows.length) return null;
  return <section className="submitted-queries" aria-label="已提交的消息">
    {presence.rows.map(({ item, leaving }) => {
      const accepted = item.status === "accepted", waiting = ["submitting", "connecting", "pending", "queued", "not_queued"].includes(item.status);
      const canDismiss = ["rejected", "not_found", "cancelled"].includes(item.status);
      const error = errors.get(item.requestId);
      const showError = error && matchesError(error, item) && items.some(current => current.requestId === item.requestId) &&
        !(suppressNetworkErrors && isNetworkError(error.failure));
      return <article key={item.requestId} ref={node => presence.bind(item.requestId, node)} className={`submitted-query${item.status === "queued" && !paused && !disabled && !leaving ? " is-queue-breathing" : ""}`}
        onClickCapture={event => { if (leaving) { event.preventDefault(); event.stopPropagation(); } }}
        data-submission-id={item.requestId} data-submission-status={item.status} data-feedback-state={accepted ? "accepted" : waiting ? "pending" : item.status}>
        <div className="submitted-query-heading">
          <span role="status">{accepted && <CheckCircle2 size={13} aria-hidden="true" />}{submittedQueryLabel(item, connecting)}</span>
          <div className="submitted-query-primary-actions">
            {item.text.trim() && <button type="button" className="submitted-query-copy" aria-label={copied === item.requestId ? "已复制已提交消息" : "复制已提交消息"}
              title={copied === item.requestId ? "已复制" : "复制已提交消息"} onClick={() => void copy(item)}>
              {copied === item.requestId ? <span>已复制</span> : <Copy size={15} aria-hidden="true" />}
            </button>}
            <button type="button" disabled={disabled || !!checking} title={item.status === "unknown" ? "核对不会重复发送" : undefined}
              onClick={() => void verify(item)}>{checking === item.requestId ? "正在核对…" : accepted ? "刷新历史" : "核对状态"}</button>
          </div>
          {item.status === "unknown" && <span className="sr-only">核对不会重复发送。</span>}
        </div>
        {item.text.trim() && <SubmittedQueryText text={item.text} />}
        <AttachmentList attachments={item.attachments} />
        {(canDismiss || restore && ["rejected", "not_found"].includes(item.status)) && <div className="submitted-query-actions">
          {restore && ["rejected", "not_found"].includes(item.status) && <button type="button" disabled={disabled || !!checking || !!restoring} onClick={() => void editAgain(item)}>{restoring === item.requestId ? "正在取回…" : "重新编辑"}</button>}
          {canDismiss && <button type="button" onClick={() => dismiss(item.requestId)}>收起</button>}
        </div>}
        {showError && <p className="receipt-action-error submitted-query-error" role="alert">{readableRequestError(error.failure, "暂时无法核对，请稍后再试。")}</p>}
      </article>;
    })}
  </section>;
}

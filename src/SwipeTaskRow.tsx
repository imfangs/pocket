import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { LoaderCircle, Star, StarOff, X } from "lucide-react";
import { bindRowSwipe, ROW_ACTION_WIDTH } from "./rowSwipe";
import "./row-swipe.css";

export default function SwipeTaskRow({ threadId, title, prioritized, className, children, open, disabled, pending, error, onPriority, onOpenChange, onClaim, onDismissError }: {
  threadId: string; title: string; prioritized: boolean; className: string; children: ReactNode;
  open: boolean; disabled: boolean; pending: boolean; error?: string;
  onPriority?: (animate: boolean) => void; onOpenChange: (open: boolean) => void; onClaim: () => void; onDismissError: () => void;
}) {
  const track = useRef<HTMLDivElement>(null), moving = useRef<HTMLDivElement>(null), shortcut = useRef<HTMLButtonElement>(null), action = useRef<HTMLButtonElement>(null);
  const restoreKeyboardFocus = useRef(false), wasPending = useRef(false);
  const actionId = useId(), errorId = useId();
  const latest = useRef({ open, disabled, onOpenChange, onClaim });
  latest.current = { open, disabled, onOpenChange, onClaim };
  useLayoutEffect(() => {
    if (!track.current || !onPriority) return;
    return bindRowSwipe(track.current, {
      enabled: () => !latest.current.disabled,
      isOpen: () => latest.current.open,
      onClaim: () => latest.current.onClaim(),
      onOpenChange: value => latest.current.onOpenChange(value),
      onTranslate(offset, dragging) {
        moving.current?.style.setProperty("--row-swipe-x", `${offset}px`);
        track.current?.toggleAttribute("data-swiping", dragging);
      },
    });
  }, [!!onPriority]);
  useLayoutEffect(() => {
    moving.current?.style.setProperty("--row-swipe-x", `${open ? -ROW_ACTION_WIDTH : 0}px`);
    if (!open && track.current?.querySelector(".row-priority-action") === document.activeElement) shortcut.current?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    if (!pending && wasPending.current && restoreKeyboardFocus.current) {
      const active = document.activeElement;
      if (!active || active === document.body || active === shortcut.current || active === action.current)
        (open ? action.current : shortcut.current)?.focus({ preventScroll: true });
      restoreKeyboardFocus.current = false;
    }
    wasPending.current = pending;
    if (!pending || !restoreKeyboardFocus.current) return;
    const pointer = () => { restoreKeyboardFocus.current = false; };
    const focus = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== shortcut.current && event.target !== action.current) restoreKeyboardFocus.current = false;
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus, true);
    return () => { document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("focusin", focus, true); };
  }, [pending, open]);
  const changePriority = (event: React.MouseEvent<HTMLButtonElement>) => {
    restoreKeyboardFocus.current = event.detail === 0;
    onPriority?.(event.detail !== 0);
  };
  const row = <div ref={moving} className={className}>
    {children}
    {onPriority && <button ref={shortcut} type="button" data-row-action="priority" className="row-priority-shortcut icon-button"
      aria-label={`${prioritized ? "取消关注" : "优先关注"} ${title}`} title={prioritized ? "取消关注" : "优先关注"}
      aria-hidden={open && !pending || undefined} tabIndex={open ? -1 : 0} disabled={disabled} onClick={changePriority}>
      {pending ? <LoaderCircle size={16} className="row-priority-spinner" aria-hidden="true" /> : prioritized ? <StarOff size={16} aria-hidden="true" /> : <Star size={16} aria-hidden="true" />}
    </button>}
  </div>;
  if (!onPriority) return <div role="listitem" data-row-motion-id={threadId} data-row-priority={prioritized}>{row}</div>;
  return <div className="task-row-swipe" role="listitem" data-row-motion-id={threadId} data-row-priority={prioritized} data-swipe-row-id={threadId} data-swipe-open={open || undefined} aria-busy={pending || undefined}
    onKeyDown={event => {
      if (event.key === "Escape" && open) { event.stopPropagation(); onOpenChange(false); shortcut.current?.focus({ preventScroll: true }); }
    }}>
    <div className="row-swipe-track" ref={track} data-swipe-enabled={!disabled}>
      <button ref={action} type="button" id={actionId} data-row-action="priority" className="row-priority-action" aria-hidden={!open} tabIndex={open ? 0 : -1}
        aria-label={`${prioritized ? "取消关注" : "优先关注"} ${title}`} aria-describedby={error ? errorId : undefined} disabled={disabled || !open} onClick={changePriority}>
        {pending && <LoaderCircle size={18} className="row-priority-spinner" aria-hidden="true" />}
        <span>{pending ? "处理中…" : prioritized ? "取消关注" : "优先关注"}</span>
      </button>
      {row}
    </div>
    {error && <div className="row-priority-error" id={errorId} role="alert"><span>{error}</span>
      <button type="button" data-row-action="dismiss" className="icon-button" aria-label="关闭优先关注错误提示" onClick={onDismissError}><X size={14} aria-hidden="true" /></button>
    </div>}
  </div>;
}

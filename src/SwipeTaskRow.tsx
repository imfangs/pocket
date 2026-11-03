import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Eye, EyeOff, LoaderCircle, Star, StarOff, X } from "lucide-react";
import { bindRowSwipe, ROW_ACTION_WIDTH } from "./rowSwipe";
import "./row-swipe.css";

type RowAction = "priority" | "hidden";
export default function SwipeTaskRow({ threadId, title, prioritized, hidden = false, className, children, open, disabled, pending, pendingAction = "priority", error, onPriority, onHidden, onOpenChange, onClaim, onDismissError }: {
  threadId: string; title: string; prioritized: boolean; hidden?: boolean; className: string; children: ReactNode;
  open: boolean; disabled: boolean; pending: boolean; pendingAction?: RowAction; error?: string;
  onPriority?: (animate: boolean) => void; onHidden?: (animate: boolean) => void;
  onOpenChange: (open: boolean) => void; onClaim: () => void; onDismissError: () => void;
}) {
  const track = useRef<HTMLDivElement>(null), moving = useRef<HTMLDivElement>(null);
  const shortcuts = useRef<Partial<Record<RowAction, HTMLButtonElement | null>>>({});
  const actions = useRef<Partial<Record<RowAction, HTMLButtonElement | null>>>({});
  const restoreKeyboardFocus = useRef<RowAction | null>(null), wasPending = useRef(false);
  const errorId = useId();
  const actionTypes: RowAction[] = [...(onPriority ? ["priority" as const] : []), ...(onHidden ? ["hidden" as const] : [])];
  const width = actionTypes.length * ROW_ACTION_WIDTH;
  const latest = useRef({ open, disabled, onOpenChange, onClaim });
  latest.current = { open, disabled, onOpenChange, onClaim };
  useLayoutEffect(() => {
    if (!track.current || !width) return;
    return bindRowSwipe(track.current, {
      width,
      enabled: () => !latest.current.disabled,
      isOpen: () => latest.current.open,
      onClaim: () => latest.current.onClaim(),
      onOpenChange: value => latest.current.onOpenChange(value),
      onTranslate(offset, dragging) {
        moving.current?.style.setProperty("--row-swipe-x", `${offset}px`);
        track.current?.toggleAttribute("data-swiping", dragging);
      },
    });
  }, [width]);
  useLayoutEffect(() => {
    moving.current?.style.setProperty("--row-swipe-x", `${open ? -width : 0}px`);
    if (!open) for (const kind of ["priority", "hidden"] as const) {
      if (actions.current[kind] === document.activeElement) shortcuts.current[kind]?.focus({ preventScroll: true });
    }
  }, [open, width]);
  useLayoutEffect(() => {
    const kind = restoreKeyboardFocus.current;
    if (!pending && wasPending.current && kind) {
      const active = document.activeElement;
      if (!active || active === document.body || active === shortcuts.current[kind] || active === actions.current[kind])
        (open ? actions.current[kind] : shortcuts.current[kind])?.focus({ preventScroll: true });
      restoreKeyboardFocus.current = null;
    }
    wasPending.current = pending;
    if (!pending || !kind) return;
    const pointer = () => { restoreKeyboardFocus.current = null; };
    const focus = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== shortcuts.current[kind] && event.target !== actions.current[kind]) restoreKeyboardFocus.current = null;
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("focusin", focus, true);
    return () => { document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("focusin", focus, true); };
  }, [pending, open]);
  const change = (kind: RowAction, event: React.MouseEvent<HTMLButtonElement>) => {
    restoreKeyboardFocus.current = event.detail === 0 ? kind : null;
    (kind === "priority" ? onPriority : onHidden)?.(event.detail !== 0);
  };
  const label = (kind: RowAction) => kind === "priority" ? prioritized ? "取消关注" : "优先关注" : hidden ? "取消隐藏" : "隐藏";
  const icon = (kind: RowAction) => pending && pendingAction === kind ? <LoaderCircle size={16} className="row-priority-spinner" aria-hidden="true" />
    : kind === "priority" ? prioritized ? <StarOff size={16} aria-hidden="true" /> : <Star size={16} aria-hidden="true" />
      : hidden ? <Eye size={16} aria-hidden="true" /> : <EyeOff size={16} aria-hidden="true" />;
  const row = <div ref={moving} className={className}>
    {children}
    {actionTypes.map(kind => <button key={kind} ref={element => { shortcuts.current[kind] = element; }} type="button" data-row-action={kind}
      className={`${kind === "priority" ? "row-priority-shortcut" : "row-hidden-shortcut"} icon-button`}
      aria-label={`${label(kind)} ${title}`} title={label(kind)}
      aria-hidden={open && !pending || undefined} tabIndex={open ? -1 : 0} disabled={disabled} onClick={event => change(kind, event)}>
      {icon(kind)}
    </button>)}
  </div>;
  if (!width) return <div role="listitem" data-row-motion-id={threadId} data-row-priority={prioritized}>{row}</div>;
  return <div className="task-row-swipe" role="listitem" data-row-motion-id={threadId} data-row-priority={prioritized} data-swipe-row-id={threadId} data-swipe-open={open || undefined} aria-busy={pending || undefined}
    onKeyDown={event => {
      if (event.key === "Escape" && open) {
        event.stopPropagation(); onOpenChange(false);
        const kind = actionTypes.find(kind => actions.current[kind] === document.activeElement) ?? actionTypes[0];
        shortcuts.current[kind]?.focus({ preventScroll: true });
      }
    }}>
    <div className="row-swipe-track" ref={track} data-swipe-enabled={!disabled}>
      <div className="row-swipe-actions" style={{ width }}>
        {actionTypes.map(kind => <button key={kind} ref={element => { actions.current[kind] = element; }} type="button" data-row-action={kind}
          className={kind === "priority" ? "row-priority-action" : "row-hidden-action"} aria-hidden={!open} tabIndex={open ? 0 : -1}
          aria-label={`${label(kind)} ${title}`} aria-describedby={error ? errorId : undefined} disabled={disabled || !open} onClick={event => change(kind, event)}>
          {pending && pendingAction === kind ? <LoaderCircle size={18} className="row-priority-spinner" aria-hidden="true" /> : <span>{label(kind)}</span>}
        </button>)}
      </div>
      {row}
    </div>
    {error && <div className="row-priority-error" id={errorId} role="alert"><span>{error}</span>
      <button type="button" data-row-action="dismiss" className="icon-button" aria-label="关闭会话操作错误提示" onClick={onDismissError}><X size={14} aria-hidden="true" /></button>
    </div>}
  </div>;
}

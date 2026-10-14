import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import NotificationSettings from "./NotificationSettings";
import { modalCloseDecision } from "./modalInteraction";
import { MOTION_EASE, MOTION_MS, holdReadingMotion, prefersReducedMotion } from "./motion";
export function Modal({
  title,
  onClose,
  children,
  busy = false,
  dirty = false,
  closeRequested = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  busy?: boolean;
  dirty?: boolean;
  closeRequested?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [opener] = useState(() => typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [confirmClose, setConfirmClose] = useState(false);
  const continueEditing = useRef<HTMLButtonElement>(null);
  const animation = useRef<Animation | null>(null), releaseReading = useRef<(() => void) | null>(null);
  const closing = useRef(false), mounted = useRef(false), close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  const stopMotion = (release = true) => {
    const previous = animation.current; animation.current = null;
    if (previous) { previous.onfinish = previous.oncancel = null; previous.cancel(); }
    if (release) { releaseReading.current?.(); releaseReading.current = null; }
  };
  const finishClose = () => {
    stopMotion(false);
    ref.current?.close();
    stopMotion();
    if (mounted.current) close.current();
    queueMicrotask(() => window.dispatchEvent(new Event("pocket-reading-visibility-change")));
  };
  const beginClose = (animate = true) => {
    const dialog = ref.current;
    if (!dialog || closing.current) return;
    closing.current = true;
    const opacity = getComputedStyle(dialog).opacity;
    stopMotion();
    dialog.inert = true;
    dialog.setAttribute("data-modal-closing", "");
    if (!animate || prefersReducedMotion() || typeof dialog.animate !== "function") { finishClose(); return; }
    releaseReading.current = holdReadingMotion(dialog.ownerDocument);
    const effect = dialog.animate([{ opacity }, { opacity: 0 }], { duration: MOTION_MS.feedback, easing: MOTION_EASE.out, fill: "forwards" });
    animation.current = effect;
    effect.onfinish = finishClose;
    effect.oncancel = finishClose;
  };
  useEffect(() => {
    const dialog = ref.current;
    mounted.current = true; closing.current = false;
    if (dialog) { dialog.inert = false; dialog.removeAttribute("data-modal-closing"); }
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    if (dialog && !prefersReducedMotion() && typeof dialog.animate === "function") {
      releaseReading.current = holdReadingMotion(dialog.ownerDocument);
      // The input gets focus immediately. Opacity never competes with the
      // software keyboard's own viewport and hit-target movement.
      const effect = dialog.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_MS.content, easing: MOTION_EASE.out });
      animation.current = effect;
      effect.onfinish = () => { if (animation.current === effect) stopMotion(); };
      effect.oncancel = () => { if (animation.current === effect) stopMotion(); };
    }
    return () => {
      mounted.current = false; stopMotion(false);
      dialog?.close();
      stopMotion();
      queueMicrotask(() => {
        window.dispatchEvent(new Event("pocket-reading-visibility-change"));
        if (!dialog?.open && opener?.isConnected && !opener.closest("[inert]") &&
            (document.activeElement === document.body || !!dialog?.contains(document.activeElement))) opener.focus({ preventScroll: true });
      });
    };
  }, [opener]);
  useEffect(() => { if (closeRequested) beginClose(); }, [closeRequested]);
  useEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const settle = () => { if (closing.current) finishClose(); else stopMotion(); };
    const background = () => { if (document.visibilityState === "hidden") settle(); };
    const preference = () => { if (reduce.matches) settle(); };
    document.addEventListener("visibilitychange", background);
    window.addEventListener("pagehide", settle);
    reduce.addEventListener("change", preference);
    return () => { document.removeEventListener("visibilitychange", background); window.removeEventListener("pagehide", settle); reduce.removeEventListener("change", preference); };
  }, []);
  useEffect(() => { if (confirmClose) continueEditing.current?.focus(); }, [confirmClose]);
  const requestClose = (fromBackdrop = false, animate = true) => {
    const decision = modalCloseDecision(busy, dirty, fromBackdrop);
    if (decision === "confirm") setConfirmClose(true);
    else if (decision === "close") beginClose(animate);
  };
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        requestClose(false, false);
      }}
      onClick={(e) => {
        if (e.target === ref.current) requestClose(true, e.detail !== 0);
      }}
      aria-label={title}
      aria-busy={busy || undefined}
    >
      <header>
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={event => requestClose(false, event.detail !== 0)}
          disabled={busy}
          aria-label="关闭对话框"
        >
          <X size={19} />
        </button>
      </header>
      {confirmClose && <div className="modal-close-confirm" role="alert">
        <p>还有未提交的内容。</p>
        <button ref={continueEditing} type="button" className="secondary" disabled={busy} onClick={() => {
          setConfirmClose(false);
          ref.current?.querySelector<HTMLElement>("[data-autofocus], input:not([type='hidden']), textarea, select")?.focus();
        }}>继续编辑</button>
        <button type="button" className="danger-button" disabled={busy} onClick={event => beginClose(event.detail !== 0)}>放弃并关闭</button>
      </div>}
      {children}
    </dialog>
  );
}
export function SettingsDialog(p: {
  appearanceActions?: React.ReactNode;
  logoutAction?: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <Modal title="设置" onClose={p.onClose}>
      <div className="settings-content">
        {p.appearanceActions && <section className="settings-appearance" aria-label="外观与安装">{p.appearanceActions}</section>}
        <NotificationSettings />
        {p.logoutAction && <div className="settings-logout">{p.logoutAction}</div>}
      </div>
    </Modal>
  );
}

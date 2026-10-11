import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import NotificationSettings from "./NotificationSettings";
import type { Catalog } from "./types";
import { modalCloseDecision } from "./modalInteraction";
export function Modal({
  title,
  onClose,
  children,
  busy = false,
  dirty = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  busy?: boolean;
  dirty?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [opener] = useState(() => typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [confirmClose, setConfirmClose] = useState(false);
  const continueEditing = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      dialog?.close();
      queueMicrotask(() => {
        if (opener?.isConnected && (document.activeElement === document.body || !!dialog?.contains(document.activeElement))) opener.focus({ preventScroll: true });
      });
    };
  }, [opener]);
  useEffect(() => { if (confirmClose) continueEditing.current?.focus(); }, [confirmClose]);
  const requestClose = (fromBackdrop = false) => {
    const decision = modalCloseDecision(busy, dirty, fromBackdrop);
    if (decision === "confirm") setConfirmClose(true);
    else if (decision === "close") onClose();
  };
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) requestClose(true);
      }}
      aria-label={title}
      aria-busy={busy || undefined}
    >
      <header>
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={() => requestClose()}
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
        <button type="button" className="danger-button" disabled={busy} onClick={onClose}>放弃并关闭</button>
      </div>}
      {children}
    </dialog>
  );
}
export function SettingsDialog(p: {
  appearanceActions?: React.ReactNode;
  logoutAction?: React.ReactNode;
  catalog: Catalog;
  showSeparators: boolean;
  onSeparators: (b: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="设置" onClose={p.onClose}>
      <div className="settings-content">
        {p.appearanceActions && <section className="settings-appearance" aria-label="外观与安装">{p.appearanceActions}</section>}
        <NotificationSettings />
        <details className="settings-source"><summary>连接与来源</summary><div className="data-summary">
          <span>最近成功同步</span>
          <strong>
            {p.catalog.sourceInfo
              ? new Date(p.catalog.sourceInfo.syncedAt).toLocaleString("zh-CN")
              : "尚未同步"}
          </strong>
          <span>来源范围</span>
          <p>{p.catalog.sourceInfo?.scope || "等待 Codex 来源"}</p>
        </div></details>
        <label className="setting-switch">
          <span>
            显示横线分隔符会话
            <small>默认在 Pocket 隐藏，原版记录保持原样。</small>
          </span>
          <input
            type="checkbox"
            checked={p.showSeparators}
            onChange={(e) => p.onSeparators(e.target.checked)}
          />
        </label>
        {p.logoutAction && <div className="settings-logout">{p.logoutAction}</div>}
      </div>
    </Modal>
  );
}

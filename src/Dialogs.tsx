import { Download, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import NotificationSettings from "./NotificationSettings";
import type { Catalog } from "./types";
import { holdReload, useReloadGuard } from "./updateSafety";
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
  accountActions?: React.ReactNode;
  catalog: Catalog;
  showSeparators: boolean;
  onSeparators: (b: boolean) => void;
  onClose: () => void;
  onImport: (data: unknown) => Promise<void>;
}) {
  const [pending, setPending] = useState<{
      data: unknown;
      name: string;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useReloadGuard(() => busy ? "备份正在恢复，请稍后更新。"
    : pending ? "已选的备份尚未处理，请恢复或取消后再更新。" : null);
  const file = useRef<HTMLInputElement>(null);
  return (
    <Modal title="设置" onClose={() => !busy && p.onClose()} busy={busy} dirty={!!pending}>
      <div className="settings-content">
        {p.accountActions && <fieldset className="settings-account" disabled={busy} aria-label="外观与账户">{p.accountActions}</fieldset>}
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
        <hr />
        <h3>备份</h3>
        <p className="field-help">
          导出置顶、接续说明及历史整理数据，不包含完整聊天记录。导入会替换整理数据，导入前会自动备份。
        </p>
        <div className="backup-actions">
          <a className="secondary" href="/api/export" download>
            <Download size={16} />
            导出备份
          </a>
          <button className="secondary" onClick={() => file.current?.click()}>
            <Upload size={16} />
            导入备份
          </button>
          <input
            ref={file}
            type="file"
            hidden
            accept="application/json,.json"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const release = holdReload();
              setError("");
              try {
                if (f.size > 4 * 1024 * 1024)
                  throw new Error("备份不能超过 4 MB");
                const data = JSON.parse(await f.text());
                if (data.format !== "codex-navigator")
                  throw new Error("请选择 Pocket 导出的 JSON 备份");
                setPending({ data, name: f.name });
              } catch (e) {
                setError((e as Error).message);
              } finally {
                release();
              }
              e.target.value = "";
            }}
          />
        </div>
        {pending && (
          <div className="import-confirm">
            <p>用「{pending.name}」恢复置顶、接续说明及历史整理数据？原会话不会被修改，旧备份未包含的置顶会保留。</p>
            <button
              className="secondary"
              onClick={() => setPending(null)}
              disabled={busy}
            >
              取消
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                if (busy) return;
                const release = holdReload();
                setBusy(true);
                try {
                  await p.onImport(pending.data);
                  setPending(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  release();
                  setBusy(false);
                }
              }}
            >
              {busy ? "恢复中…" : "确认恢复"}
            </button>
          </div>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

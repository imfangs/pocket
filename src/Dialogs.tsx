import { Download, FolderPlus, ShieldCheck, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Catalog, Group } from "./types";
import { descendantIds, groupPath } from "./model";
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    ref.current?.querySelector<HTMLInputElement>("[data-autofocus]")?.focus();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="关闭对话框"
        >
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function GroupDialog(p: {
  group?: Group;
  groups: Group[];
  onClose: () => void;
  onSave: (g: Partial<Group>, id?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [name, setName] = useState(p.group?.name || ""),
    [parentId, setParentId] = useState(p.group?.parentId || ""),
    [color, setColor] = useState(p.group?.color || "#547569"),
    [position, setPosition] = useState(p.group?.position ?? p.groups.length),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false);
  const unavailable = p.group ? descendantIds(p.groups, p.group.id) : new Set();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await p.onSave(
        { name, parentId: parentId || null, color, position },
        p.group?.id,
      );
      p.onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={p.group ? "编辑分组" : "新建分组"}
      onClose={() => !busy && p.onClose()}
    >
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="group-name">
          分组名称
        </label>
        <input
          id="group-name"
          data-autofocus
          autoFocus
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          placeholder="例如：游戏、语音交互"
          required
          disabled={busy}
        />
        <label className="field-label" htmlFor="parent-group">
          放在哪一层
        </label>
        <select
          id="parent-group"
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          disabled={busy}
        >
          <option value="">顶层分组</option>
          {p.groups
            .filter((g) => !unavailable.has(g.id))
            .map((g) => (
              <option key={g.id} value={g.id}>
                {groupPath(p.groups, g.id)}
              </option>
            ))}
        </select>
        <div className="group-options">
          <label>
            分组颜色
            <input
              type="color"
              aria-label="分组颜色"
              value={color}
              onChange={(e) => setColor(e.target.value)}
            />
          </label>
          <label>
            排序位置
            <input
              type="number"
              aria-label="排序位置"
              min={0}
              max={10000}
              value={position}
              onInput={(e) => setPosition(Number(e.currentTarget.value))}
              onChange={(e) => setPosition(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="field-help">只整理 Pocket 的导航，不移动文件或原会话。</p>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <footer>
          {p.group && (
            <button
              type="button"
              className="danger text-button"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              删除分组
            </button>
          )}
          <button
            type="button"
            className="secondary"
            onClick={p.onClose}
            disabled={busy}
          >
            取消
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            <FolderPlus size={15} />
            {busy ? "保存中…" : "保存分组"}
          </button>
        </footer>
        {confirmDelete && (
          <div className="delete-confirm">
            <p>
              删除「{p.group?.name}」？任务和说明都会保留，子分组移到上一层。
            </p>
            <button
              type="button"
              className="secondary"
              onClick={() => setConfirmDelete(false)}
            >
              保留分组
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await p.onDelete(p.group!.id);
                  p.onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认删除分组
            </button>
          </div>
        )}
      </form>
    </Modal>
  );
}
export function SettingsDialog(p: {
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
  const file = useRef<HTMLInputElement>(null);
  return (
    <Modal title="数据与备份" onClose={() => !busy && p.onClose()}>
      <div className="settings-content">
        <div className="privacy-note">
          <ShieldCheck size={23} />
          <div>
            <strong>你的整理，保存在这台 Mac</strong>
            <p>
              原版数据只读。分组、接续说明和稍后状态独立保存，修改后自动保留备份。
            </p>
          </div>
        </div>
        <div className="data-summary">
          <span>最近成功同步</span>
          <strong>
            {p.catalog.sourceInfo
              ? new Date(p.catalog.sourceInfo.syncedAt).toLocaleString("zh-CN")
              : "尚未同步"}
          </strong>
          <span>来源范围</span>
          <p>{p.catalog.sourceInfo?.scope || "等待 Codex 来源"}</p>
        </div>
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
        <h3>带走或恢复整理结果</h3>
        <p className="field-help">
          导出分组和接续说明，不包含完整聊天记录。导入会替换当前整理，导入前会自动备份。
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
              }
              e.target.value = "";
            }}
          />
        </div>
        {pending && (
          <div className="import-confirm">
            <p>用「{pending.name}」恢复分组和说明？现有原会话不会被修改。</p>
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
                setBusy(true);
                try {
                  await p.onImport(pending.data);
                  setPending(null);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
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

import { AppIcon } from "./ui/AppIcon";
import { t as tr, useLocale } from "./i18n";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { Modal } from "./Dialogs";
import { api } from "./api";
import type { Thread } from "./types";
import { useReloadGuard } from "./updateSafety";
import { mergeRenameOperation, renameNameError, renameOperationText, renameRequest, renameSourceHint, renameUnresolved } from "./threadRename";
import type { RenameOperation, RenameSource } from "./threadRename";

export default function RenameThreadDialog({ thread, onClose, onSaved }: {
  thread: Thread; onClose: () => void; onSaved: (thread: Thread) => void;
}) {
  useLocale();
  const [source, setSource] = useState<RenameSource | null>(null);
  const [name, setName] = useState(thread.title), [baseline, setBaseline] = useState(thread.title);
  const [operation, setOperation] = useState<RenameOperation>();
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true), inFlight = useRef(false), operationRef = useRef<RenameOperation | undefined>(undefined), delivered = useRef<string | null>(null);
  const saved = useRef(onSaved), nameInput = useRef<HTMLInputElement>(null);
  const inputId = useId(), statusId = useId();
  saved.current = onSaved;
  const unresolved = renameUnresolved(operation), dirty = !unresolved && name !== baseline;
  const nameDisabled = loading || submitting || unresolved || source?.canRename === false;
  useReloadGuard(() => submitting ? "正在提交新名称，请稍后更新。" : dirty ? "会话名称还有未保存的修改。" : null);
  const editName = (value: string) => {
    setName(value);
    if (source?.canRename && !unresolved) { operationRef.current = undefined; setOperation(undefined); setError(""); }
  };

  const accept = (incoming: RenameOperation) => {
    if (!alive.current || incoming.threadId !== thread.id) return;
    const next = mergeRenameOperation(operationRef.current, incoming);
    operationRef.current = next;
    setOperation(next);
    if (next.status === "succeeded" && next.thread?.id === thread.id && delivered.current !== next.requestId) {
      delivered.current = next.requestId;
      saved.current(next.thread);
    } else if (next.status === "changed") setSource(null);
  };
  const readSource = async (preserveInput = false, retainedReceipt?: RenameOperation) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true); setError("");
    try {
      const next = await api<RenameSource>(`/api/tasks/${thread.id}/name`, "GET", undefined, { signal: AbortSignal.timeout(15000) });
      if (!alive.current) return;
      setSource(next); setBaseline(next.title);
      const recovered = next.operation?.threadId === thread.id ? next.operation : undefined;
      operationRef.current = recovered ? undefined : retainedReceipt;
      setOperation(operationRef.current);
      // The service only includes its active receipt, including a terminal
      // result reconciled by this read after the editor was closed. Later
      // opens have no active receipt to report again.
      if (recovered) {
        setName(recovered.name);
        accept(recovered);
      } else if (!preserveInput) setName(next.title);
    } catch (failure) {
      if (alive.current) setError((failure as Error).message);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  };
  const check = async () => {
    const current = operationRef.current;
    if (!current || !renameUnresolved(current) || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    let rejected: RenameOperation | undefined;
    try {
      const next = await api<RenameOperation>(`/api/tasks/${thread.id}/name/${current.requestId}`, "GET", undefined, { signal: AbortSignal.timeout(15000) });
      accept(next);
      if (next.threadId === thread.id && next.requestId === current.requestId && next.status === "rejected") rejected = next;
    } catch (failure) {
      if (alive.current) {
        setError((failure as Error).message);
        accept({ ...current, status: "unknown" });
      }
    } finally {
      inFlight.current = false;
      if (alive.current) {
        setBusy(false);
        // A reopened unresolved request starts with canRename=false. Once a
        // read confirms no write, refresh its preconditions before enabling a
        // new request, retaining both the proposed name and the receipt.
        if (rejected) void readSource(true, rejected);
      }
    }
  };
  const actions = useRef({ readSource, check });
  actions.current = { readSource, check };
  useEffect(() => {
    alive.current = true;
    void actions.current.readSource();
    return () => { alive.current = false; };
  }, [thread.id]);
  useEffect(() => {
    if (!loading && source?.canRename && !unresolved) nameInput.current?.focus({ preventScroll: true });
  }, [loading, source?.canRename, unresolved]);
  useEffect(() => {
    if (operation?.status !== "pending" || busy || submitting) return;
    const timer = setTimeout(() => { if (document.visibilityState === "visible") void actions.current.check(); }, 1500);
    const visible = () => { if (document.visibilityState === "visible") void actions.current.check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [operation, busy, submitting]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current || renameUnresolved(operationRef.current) || !source?.canRename) return;
    const validation = renameNameError(name);
    if (validation) { setError(validation); nameInput.current?.focus(); return; }
    const nextName = name.trim();
    if (nextName === source.title) return;
    const pending: RenameOperation = { requestId: crypto.randomUUID(), threadId: thread.id, name: nextName, status: "pending" };
    operationRef.current = pending; setOperation(pending);
    inFlight.current = true; setSubmitting(true); setError("");
    let needsCheck = false;
    try {
      const result = await api<RenameOperation>(`/api/tasks/${thread.id}/name`, "POST",
        renameRequest(source, nextName, pending.requestId), { signal: AbortSignal.timeout(20000) });
      accept(result);
    } catch (failure) {
      if (alive.current) {
        const status = (failure as Error & { status?: number }).status;
        setError((failure as Error).message);
        accept({ ...pending, status: status && status < 500 ? "rejected" : "unknown", message: (failure as Error).message });
        if (status && status < 500) setSource(null);
        else needsCheck = true;
      }
    } finally {
      inFlight.current = false;
      if (alive.current) { setSubmitting(false); if (needsCheck) void check(); }
    }
  };

  return <Modal title={tr("重命名会话")} className="rename-thread-dialog" onClose={onClose} busy={submitting} dirty={dirty}>
    <form className="rename-thread-form" onSubmit={event => void submit(event)} noValidate>
      <label className="field-label" htmlFor={inputId}>{tr("会话名称")}</label>
      <div className="rename-thread-name">
        <input ref={nameInput} id={inputId} value={name} autoComplete="off" enterKeyHint="done"
          disabled={nameDisabled}
          aria-describedby={statusId} aria-invalid={!!renameNameError(name) && !!error || undefined}
          onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }}
          onChange={event => editName(event.target.value)} />
        {name.length > 0 && <IconButton type="button" className="icon-button rename-thread-clear" title={tr("清空名称")} aria-label={tr("清空名称")} disabled={nameDisabled}
          onMouseDown={event => { if (event.button === 0 && document.activeElement === nameInput.current) event.preventDefault(); }}
          onClick={() => {
            if (nameDisabled || inFlight.current) return;
            editName("");
            nameInput.current?.focus({ preventScroll: true });
          }}><AppIcon icon={X} kind="action" aria-hidden="true" /></IconButton>}
      </div>
      <p className="field-help rename-thread-status" id={statusId} role="status">
        {loading ? tr("正在读取原标题…") : operation ? tr(renameOperationText(operation)) : source && !source.canRename ? tr(renameSourceHint(source)) : tr("名称会同步到 Codex。")}
      </p>
      {operation?.currentTitle && operation.status === "changed" && <p className="field-help">{tr("当前名称：")}{operation.currentTitle}</p>}
      {error && <p className="inline-error" role="alert">{tr(error)}</p>}
      <footer className="dialog-actions">
        {unresolved ? <>
          <Button type="button" className="text-button" variant="ghost" color="gray" disabled={submitting} onClick={onClose}>{tr("关闭")}</Button>
          <Button type="button" className="secondary" variant="soft" color="gray" disabled={busy || submitting} onClick={() => void check()}>{busy ? tr("正在核对…") : tr("核对结果")}</Button>
        </> : <>
          {(!source || !source.canRename) && <Button type="button" className="secondary" variant="soft" color="gray" disabled={loading} onClick={() => void readSource(true)}>{tr("重新读取")}</Button>}
          <Button type="submit" className="primary" disabled={loading || submitting || !source?.canRename || !name.trim() || name.trim() === source.title}>{tr("保存名称")}</Button>
        </>}
      </footer>
    </form>
  </Modal>;
}

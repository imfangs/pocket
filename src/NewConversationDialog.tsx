import { useEffect, useRef, useState } from "react";
import { Modal } from "./Dialogs";
import { api } from "./api";
import { activeOperation, type CreateLocation, type TaskOperation } from "./taskOperations";
import TaskOperationStatus from "./TaskOperationStatus";
import { useReloadGuard } from "./updateSafety";

export default function NewConversationDialog({ preferredCwd, operation, operationError, onCreate, onCheck, onCancelOperation, onClose }: {
  preferredCwd?: string; operation?: TaskOperation; operationError?: string;
  onCreate: (input: { locationId: string; name?: string }) => Promise<unknown>;
  onCheck: () => void; onCancelOperation: () => void; onClose: () => void;
}) {
  const [locations, setLocations] = useState<CreateLocation[]>([]), [locationId, setLocationId] = useState("");
  const [available, setAvailable] = useState(false);
  const [name, setName] = useState(""), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const submitting = useRef(false), [busy, setBusy] = useState(false);
  const locked = busy || activeOperation(operation);
  useReloadGuard(() => busy ? "会话正在创建，请稍后更新。" : !operation && name ? "新会话名称尚未提交，请先处理。" : null);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ available: boolean; locations: CreateLocation[] }>("/api/tasks/create-options", "GET", undefined, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setLocations(result.locations);
        setAvailable(result.available);
        setLocationId(result.locations.find(location => location.cwd === preferredCwd)?.id || (result.locations.length === 1 ? result.locations[0].id : ""));
        if (!result.available || !result.locations.length) setError("暂时没有可用的工作目录，请同步任务后重试。");
      }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [preferredCwd]);
  return <Modal title="新建会话" onClose={() => !busy && onClose()}>
    <form onSubmit={async event => {
      event.preventDefault(); if (!available || !locationId || locked || submitting.current) return;
      submitting.current = true; setBusy(true); setError("");
      try { await onCreate({ locationId, ...(name.trim() ? { name: name.trim() } : {}) }); }
      catch (failure) { setError((failure as Error).message); }
      finally { submitting.current = false; setBusy(false); }
    }}>
      <label className="field-label" htmlFor="new-conversation-location">工作目录</label>
      <select id="new-conversation-location" data-autofocus value={locationId} disabled={loading || locked} onChange={event => setLocationId(event.target.value)} required>
        <option value="">{loading ? "正在读取目录…" : "选择一个工作目录"}</option>
        {locations.map(location => <option key={location.id} value={location.id}>{location.label}</option>)}
      </select>
      {locationId && <p className="field-help new-conversation-path">{locations.find(location => location.id === locationId)?.cwd}</p>}
      <label className="field-label" htmlFor="new-conversation-name">名称 <small>可选</small></label>
      <input id="new-conversation-name" value={name} disabled={locked} maxLength={220} onChange={event => setName(event.target.value)} />
      <p className="field-help">创建后可直接开始对话。</p>
      {operation && <TaskOperationStatus operation={operation} error={operationError} onCheck={onCheck} onCancel={onCancelOperation} />}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>{activeOperation(operation) ? "返回列表" : "取消"}</button>
        <button className="primary" disabled={loading || !available || locked || !locationId}>{busy || operation?.status === "pending" ? "正在创建…" : "创建会话"}</button>
      </footer>
    </form>
  </Modal>;
}

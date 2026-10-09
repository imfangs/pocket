import { useLayoutEffect, useRef } from "react";
import { activeOperation, observeCreationNotice, operationCancelLabel, operationText, type TaskOperation } from "./taskOperations";

export default function TaskOperationStatus({ operation, title, error, onCheck, onCancel, onOpen, onDismiss, autoDismissEnabled = false }: {
  operation: TaskOperation; title?: string; error?: string;
  onCheck: () => void; onCancel: () => void; onOpen?: () => void; onDismiss?: () => void;
  autoDismissEnabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null), dismiss = useRef(onDismiss);
  const notice = useRef<ReturnType<typeof observeCreationNotice> | null>(null);
  useLayoutEffect(() => {
    if (!root.current || operation.operation !== "create") return;
    const observer = observeCreationNotice({ target: root.current, requestId: operation.requestId, onDismiss: () => dismiss.current?.() });
    notice.current = observer;
    return () => { observer.stop(); notice.current = null; };
  }, [operation.requestId, operation.operation]);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
    notice.current?.update(operation, autoDismissEnabled && !error && !!onOpen && !!onDismiss);
  }, [operation, autoDismissEnabled, error, onOpen, onDismiss]);
  const cancelLabel = operationCancelLabel(operation);
  return <div ref={root} className="task-operation-status" role="status" data-status={operation.status}>
    {title && <strong>{title}</strong>}
    <span>{operationText(operation)}</span>
    {operation.operation === "create" && operation.status === "unknown" && <small>停止核对不会删除可能已创建的会话。</small>}
    {!!operation.descendantCount && <small>包含 {operation.descendantCount} 个子会话。</small>}
    <div className="task-operation-actions">
      {cancelLabel && <button className="text-button" onClick={onCancel}>{cancelLabel}</button>}
      {operation.status === "unknown" && <button className="text-button" onClick={onCheck}>核对操作状态</button>}
      {operation.operation === "create" && operation.status === "succeeded" && onOpen && <button className="text-button" onClick={() => { notice.current?.stop(); onOpen(); }}>打开新会话</button>}
      {!activeOperation(operation) && onDismiss && <button className="text-button" onClick={() => { notice.current?.stop(); onDismiss(); }}>关闭提示</button>}
    </div>
    {error && <small className="inline-error" role="alert">{error}</small>}
  </div>;
}

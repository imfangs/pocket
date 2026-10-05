import { activeOperation, operationCancelLabel, operationText, type TaskOperation } from "./taskOperations";

export default function TaskOperationStatus({ operation, title, error, onCheck, onCancel, onOpen, onDismiss }: {
  operation: TaskOperation; title?: string; error?: string;
  onCheck: () => void; onCancel: () => void; onOpen?: () => void; onDismiss?: () => void;
}) {
  const cancelLabel = operationCancelLabel(operation);
  return <div className="task-operation-status" role="status" data-status={operation.status}>
    {title && <strong>{title}</strong>}
    <span>{operationText(operation)}</span>
    {operation.operation === "create" && operation.status === "unknown" && <small>停止核对不会删除可能已创建的会话。</small>}
    {!!operation.descendantCount && <small>包含 {operation.descendantCount} 个子会话。</small>}
    <div className="task-operation-actions">
      {cancelLabel && <button className="text-button" onClick={onCancel}>{cancelLabel}</button>}
      {operation.status === "unknown" && <button className="text-button" onClick={onCheck}>核对操作状态</button>}
      {operation.operation === "create" && operation.status === "succeeded" && onOpen && <button className="text-button" onClick={onOpen}>打开新会话</button>}
      {!activeOperation(operation) && onDismiss && <button className="text-button" onClick={onDismiss}>关闭提示</button>}
    </div>
    {error && <small className="inline-error" role="alert">{error}</small>}
  </div>;
}

import type { Thread } from "./types";
import type { ThreadConnection } from "./threadConnection";

export type TaskOperation = {
  requestId: string;
  operation: "create" | "archive" | "restore";
  status: "pending" | "waiting" | "succeeded" | "rejected" | "unknown" | "cancelled" | "changed";
  threadId?: string;
  thread?: Thread;
  connection?: ThreadConnection;
  descendantCount?: number;
  code?: string;
  message?: string;
  createdAt?: number;
  updatedAt?: number;
};
export type CreateLocation = { id: string; label: string; cwd: string; projectId?: string; projectName?: string };
const creationRecoveryKey = "pocket.pending-creation-ids.v1";
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function readCreationRecoveryIds(storage?: Pick<Storage, "getItem">): string[] {
  try {
    const value = JSON.parse((storage ?? sessionStorage).getItem(creationRecoveryKey) || "[]");
    return Array.isArray(value) ? [...new Set(value.filter(validId))].slice(-100) : [];
  } catch { return []; }
}
export function saveCreationRecoveryIds(ids: string[], storage?: Pick<Storage, "setItem">) {
  try { (storage ?? sessionStorage).setItem(creationRecoveryKey, JSON.stringify([...new Set(ids.filter(validId))].slice(-100))); }
  catch { /* An unavailable session store must not change the operation itself. */ }
}
export function creationRecoveryIds(operations: Iterable<TaskOperation>, watched: ReadonlySet<string>) {
  return [...operations].filter(operation => operation.operation === "create" && watched.has(operation.requestId) &&
    ["pending", "waiting", "unknown", "succeeded"].includes(operation.status)).map(operation => operation.requestId);
}
export const activeOperation = (operation?: TaskOperation) => !!operation && ["pending", "waiting", "unknown"].includes(operation.status);
export const pollOperation = (operation: TaskOperation) => ["pending", "waiting"].includes(operation.status);
export function mergeOperation(current: TaskOperation | undefined, incoming: TaskOperation): TaskOperation {
  if (!current) return incoming;
  if (current.requestId !== incoming.requestId || current.operation !== incoming.operation) return current;
  if (current.threadId && incoming.threadId && current.threadId !== incoming.threadId) return current;
  if (current.updatedAt !== undefined && incoming.updatedAt !== undefined && incoming.updatedAt < current.updatedAt) return current;
  if (["succeeded", "cancelled", "changed", "rejected"].includes(current.status)) return current;
  return { ...current, ...incoming };
}
export function operationText(operation: TaskOperation) {
  const action = operation.operation === "create" ? "新建" : operation.operation === "restore" ? "恢复" : "归档";
  if (operation.status === "waiting") return `等待 Codex 释放会话，释放后自动${action}，可取消。`;
  if (operation.status === "pending") return `正在${action}会话…`;
  if (operation.status === "unknown") return `${action}结果尚未确认，请核对状态。`;
  if (operation.status === "succeeded") return `会话已${operation.operation === "create" ? "创建" : action}。`;
  if (operation.status === "cancelled") return operation.operation === "create"
    ? "已停止此次新建结果核对；可能已创建的会话会保留。" : "已取消等待。";
  if (operation.status === "changed") return "会话有新活动或子会话发生变化，本次操作已停止，请重新查看后操作。";
  if (operation.code === "outbox_not_empty") return "还有待发消息，请先处理待发列表再归档。";
  if (operation.code === "active_or_unknown_thread") return `会话尚未确认结束，请先核对执行状态再${action}。`;
  if (["thread_active", "thread_running", "active_turn"].includes(operation.code || "")) return "会话正在运行，请先停止或等本轮结束再归档。";
  if (["dispatch_unknown", "pending_dispatch", "unresolved_dispatch", "unresolved_send"].includes(operation.code || "")) return "还有发送结果尚未确认，请先核对再归档。";
  return operation.message || `未能${action}会话，请刷新状态后重试。`;
}
export function operationCancelLabel(operation: TaskOperation) {
  if (operation.operation === "create") return operation.status === "unknown" ? "停止核对" : null;
  if (operation.status === "unknown") return "停止后续尝试";
  return operation.status === "waiting" ? `取消等待${operation.operation === "restore" ? "恢复" : "归档"}` : null;
}

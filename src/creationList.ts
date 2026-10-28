import type { TaskOperation } from "./taskOperations";
import type { Catalog } from "./types";

export type CreationCue = {
  requestId: string;
  phase: "pending" | "confirmed" | "attention";
  label: string;
};

// A create receipt can introduce its verified thread, but cannot undo a newer
// catalog decision (archive, missing, or source exclusion) for an existing row.
export function withCreatedThread(catalog: Catalog, operation: TaskOperation): Catalog {
  const thread = operation.thread;
  if (operation.operation !== "create" || !thread || thread.id !== operation.threadId ||
      operation.status !== "succeeded" && operation.creationStatus !== "created") return catalog;
  if (catalog.threads.some(value => value.id === thread.id) || catalog.excludedThreadIds?.includes(thread.id) ||
      catalog.excludedThreadStates?.some(value => value.id === thread.id)) return catalog;
  return { ...catalog, threads: [...catalog.threads, thread] };
}

export function creationNeedsAttention(operation: TaskOperation, error?: string): boolean {
  if (operation.operation !== "create" || operation.status === "cancelled") return false;
  return !!error?.trim() || ["unknown", "rejected", "changed"].includes(operation.status) ||
    ["unknown", "rejected", "not_queued"].includes(operation.initialMessage?.status || "");
}

// A catalog row proves that a conversation exists, not that its first message
// was accepted. Keep this cue tied to the create and first-message receipts.
export function creationCue(operation: TaskOperation): CreationCue | null {
  if (operation.operation !== "create" || operation.status === "cancelled") return null;
  if (operation.status === "succeeded" && operation.initialMessage?.status === "cancelled") return null;
  const cue = (phase: CreationCue["phase"], label: string): CreationCue => ({ requestId: operation.requestId, phase, label });
  if (creationNeedsAttention(operation)) return cue("attention", "待核对");
  const initial = operation.initialMessage?.status;
  if (initial === "editing") return cue("attention", "已暂停");
  if (initial === "cancelled") return cue("attention", "消息已取消");
  if (operation.status !== "succeeded") return cue("pending", "创建中");
  if (initial === "queued") return cue("pending", "待发送");
  if (initial === "pending") return cue("pending", "发送中");
  if (!operation.initialMessage || initial === "accepted") return cue("confirmed", initial === "accepted" ? "已发送" : "已创建");
  return cue("attention", "待核对");
}

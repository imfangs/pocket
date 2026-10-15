import type { Thread } from "./types";

export type RenameOperation = {
  requestId: string;
  threadId: string;
  status: "pending" | "succeeded" | "changed" | "rejected" | "unknown";
  name: string;
  currentTitle?: string;
  message?: string;
  code?: string;
  thread?: Thread;
};
export type RenameSource = {
  title: string;
  name: string | null;
  nameFingerprint: string;
  canRename: boolean;
  code?: string;
  operation?: RenameOperation;
};

export const renameUnresolved = (operation?: RenameOperation) => !!operation && ["pending", "unknown"].includes(operation.status);

export function renameNameError(value: string): string | null {
  const name = value.trim();
  if (!name) return "请输入会话名称。";
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) return "会话名称不能包含换行或控制字符。";
  if (/[\uD800-\uDFFF]/u.test(name)) return "会话名称包含无效字符，请重新输入。";
  if (name.length > 220) return "会话名称最多 220 个字符。";
  return null;
}

export function renameRequest(source: RenameSource, name: string, requestId: string) {
  return { requestId, name: name.trim(), expectedName: source.title, expectedFingerprint: source.nameFingerprint };
}

export function mergeRenameOperation(current: RenameOperation | undefined, incoming: RenameOperation): RenameOperation {
  if (!current) return incoming;
  if (current.requestId !== incoming.requestId || current.threadId !== incoming.threadId) return current;
  if (!renameUnresolved(current)) return current;
  return incoming;
}

export function renameOperationText(operation: RenameOperation): string {
  if (operation.status === "pending") return "正在同步会话名称…";
  if (operation.status === "unknown") return "改名结果尚未确认，请核对后再操作。";
  if (operation.status === "changed") return "名称已变化，请重新读取后保存。";
  if (operation.status === "succeeded") return "会话已重命名。";
  if (operation.code === "rename_not_applied") return "改名未生效，可重新保存。";
  return operation.message || "未能重命名，请稍后再试。";
}

export function renameSourceHint(source: RenameSource): string {
  if (["archived", "thread_archived", "archived_thread"].includes(source.code || "")) return "请先恢复会话，再重命名。";
  if (["missing", "thread_missing", "not_found", "thread_not_found"].includes(source.code || "")) return "会话暂不可用，请刷新后再试。";
  if (source.code === "lifecycle_pending") return "此会话有未完成的管理操作，请先核对。";
  if (["app_version_changed", "cli_version_changed"].includes(source.code || "")) return "桌面版本已变化，重命名需更新兼容支持。";
  return "暂时无法重命名，请重新读取后再试。";
}

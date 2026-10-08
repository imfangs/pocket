import type { Thread, View } from "./types";

export function threadListStates(thread: Thread, hasDraft = false) {
  const states: { key: string; label: string }[] = [];
  if (hasDraft) states.push({ key: "draft", label: "草稿" });
  if (thread.archived) states.push({ key: "archived", label: "已归档" });
  else if (thread.needsInput && !thread.missing) states.push({ key: "unread", label: "未读" });
  if (thread.missing) states.push({ key: "missing", label: "来源待核对" });
  return states;
}

export type EmptyListAction = "create" | "showAll" | "refresh" | "clearQuery" | "clearFilters";
export function emptyListContent({ view, query, hasFilters = false, unreadAvailable = false, unreadPending = 0 }: {
  view: View; query: string; hasFilters?: boolean; unreadAvailable?: boolean; unreadPending?: number;
}): { title: string; description: string; action?: EmptyListAction; actionLabel?: string } {
  if (view === "unread" && !unreadAvailable) return { title: "暂时无法读取未读状态", description: "已有会话仍然保留，重新读取后再确认。", action: "refresh", actionLabel: "重新读取" };
  if (query.trim()) return { title: "没有找到匹配的会话", description: "可搜索会话名称、项目或接续说明。", action: "clearQuery", actionLabel: "清除搜索" };
  if (hasFilters) return { title: "当前筛选下没有会话", description: "清除筛选后，可查看这个视图中的其他会话。", action: "clearFilters", actionLabel: "清除筛选" };
  if (view === "unread") return { title: "暂时没有未读进展", description: unreadPending ? "还有未读会话尚未确认结束，结束后会出现在这里。" : "会话结束并有新提醒时，会出现在这里。", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "all") return { title: "开始一段新会话", description: "选择一个工作目录，就能从这里继续。", action: "create", actionLabel: "新建会话" };
  if (view === "pinned") return { title: "还没有置顶会话", description: "这里显示你在 Codex 中置顶的会话。", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "archived") return { title: "没有已归档会话", description: "归档后的会话会保留在这里，随时可以恢复。", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "group") return { title: "这个分组还没有会话", description: "在会话的「整理」中加入分组。", action: "showAll", actionLabel: "去选择会话" };
  if (view === "unassigned") return { title: "会话都已有分组", description: "也可以从全部会话继续查找。", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "recent") return { title: "还没有打开记录", description: "可从全部会话找到想继续的内容。", action: "showAll", actionLabel: "查看全部会话" };
  return { title: view === "later" ? "还没有稍后继续的会话" : view === "reference" ? "还没有留作参考的会话" : "还没有正在推进的会话", description: "在会话的「整理」中设置你的安排。", action: "showAll", actionLabel: "去选择会话" };
}

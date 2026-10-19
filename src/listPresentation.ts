import type { ActivityFilter, Thread, View } from "./types";
import type { TaskStatus } from "./taskStatuses";
import { hasUnreadContent } from "./unread.ts";

export function threadListStates(thread: Thread, hasDraft = false, runtimeStatus?: TaskStatus) {
  const states: { key: string; label: string }[] = [];
  if (hasDraft) states.push({ key: "draft", label: "草稿" });
  if (thread.archived) states.push({ key: "archived", label: "已归档" });
  else if (!thread.missing) {
    if (runtimeStatus === "running") states.push({ key: "running", label: "运行中" });
    else if (runtimeStatus === "waiting_input") states.push({ key: "waiting_input", label: "等待回答" });
    else if (runtimeStatus === "waiting_approval") states.push({ key: "waiting_approval", label: "等待确认" });
    else if (runtimeStatus === "unknown") states.push({ key: "unknown", label: "状态待确认" });
    if (hasUnreadContent(thread, runtimeStatus)) states.push({ key: "unread", label: "未读" });
  }
  if (thread.missing) states.push({ key: "missing", label: "会话待核对" });
  return states;
}

export function threadListPresentation(thread: Thread, hasDraft = false, runtimeStatus?: TaskStatus) {
  const states = threadListStates(thread, hasDraft, runtimeStatus);
  const primaryState = states.find(state => state.key === "waiting_approval" || state.key === "waiting_input" || state.key === "running");
  return { primaryState, secondaryStates: states.filter(state => state !== primaryState) };
}

export type EmptyListAction = "create" | "showAll" | "searchAll" | "refresh" | "clearQuery" | "clearFilters";
export function emptyListContent({ view, activity = view === "unread" || view === "running" ? view : "all", query, projectScope, hasFilters = false, unreadAvailable = false, unreadPending = 0, runtimeAvailable = false, runtimeLoading = false }: {
  view: View; activity?: ActivityFilter; query: string; projectScope?: string; hasFilters?: boolean; unreadAvailable?: boolean; unreadPending?: number; runtimeAvailable?: boolean; runtimeLoading?: boolean;
}): { title: string; description: string; action?: EmptyListAction; actionLabel?: string } {
  if (activity === "unread" && !unreadAvailable) return { title: "暂时无法读取未读状态", description: "", action: "refresh", actionLabel: "重新读取" };
  if (activity === "running" && !runtimeAvailable) return { title: runtimeLoading ? "正在确认运行状态" : "运行状态暂时不可用", description: "恢复后会自动更新。", action: "clearFilters", actionLabel: "取消运行筛选" };
  if (activity !== "all") return { title: query.trim() ? "没有找到匹配的会话" : activity === "unread" ? "暂时没有未读会话" : "暂未发现运行中的会话",
    description: activity === "unread" && unreadPending ? "运行中的未读会话结束后会出现在这里。" : "",
    action: "clearFilters", actionLabel: activity === "unread" ? "取消未读筛选" : "取消运行筛选" };
  if (query.trim()) return { title: "没有找到匹配的会话", description: "",
    action: projectScope && view !== "archived" ? "searchAll" : "clearQuery",
    actionLabel: projectScope && view !== "archived" ? "在全部会话搜索" : "清除搜索" };
  if (projectScope && (view === "all" || view === "created")) return { title: projectScope === "__unassigned__" ? "没有未归属项目的会话" : "这个项目还没有会话", description: "", action: "showAll", actionLabel: "查看全部会话" };
  if (hasFilters) return { title: "当前筛选下没有会话", description: "", action: "clearFilters", actionLabel: "清除筛选" };
  if (view === "all" || view === "created") return { title: "还没有会话", description: "", action: "create", actionLabel: "新建会话" };
  if (view === "priority") return { title: "还没有关注的会话", description: "", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "codex-pinned") return { title: "还没有置顶会话", description: "", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "pinned") return { title: "还没有已标记的会话", description: "", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "archived") return { title: "没有已归档会话", description: "", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "recent") return { title: "还没有打开记录", description: "", action: "showAll", actionLabel: "查看全部会话" };
  return { title: "没有会话", description: "", action: "showAll", actionLabel: "查看全部会话" };
}

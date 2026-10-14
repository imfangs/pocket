import type { Thread, View } from "./types";
import type { TaskStatus } from "./taskStatuses";
import { needsUserInput } from "./smartOrder.ts";

export function threadListStates(thread: Thread, hasDraft = false, runtimeStatus?: TaskStatus) {
  const states: { key: string; label: string }[] = [];
  if (hasDraft) states.push({ key: "draft", label: "草稿" });
  if (thread.archived) states.push({ key: "archived", label: "已归档" });
  else if (!thread.missing) {
    if (runtimeStatus === "running") states.push({ key: "running", label: "运行中" });
    else if (runtimeStatus === "waiting_input") states.push({ key: "waiting_input", label: "等待回答" });
    else if (runtimeStatus === "waiting_approval") states.push({ key: "waiting_approval", label: "等待确认" });
    else {
      if (runtimeStatus === "unknown") states.push({ key: "unknown", label: "状态待确认" });
      if (needsUserInput(thread, runtimeStatus)) states.push({ key: "unread", label: "未读" });
    }
  }
  if (thread.missing) states.push({ key: "missing", label: "来源待核对" });
  return states;
}

export function threadListPresentation(thread: Thread, hasDraft = false, runtimeStatus?: TaskStatus) {
  const states = threadListStates(thread, hasDraft, runtimeStatus);
  const primaryState = states.find(state => state.key === "waiting_approval" || state.key === "waiting_input" || state.key === "running");
  return { primaryState, secondaryStates: states.filter(state => state !== primaryState) };
}

export type EmptyListAction = "create" | "showAll" | "refresh" | "clearQuery" | "clearFilters";
export function emptyListContent({ view, query, projectScope, hasFilters = false, unreadAvailable = false, unreadPending = 0, runtimeAvailable = false, runtimeLoading = false }: {
  view: View; query: string; projectScope?: string; hasFilters?: boolean; unreadAvailable?: boolean; unreadPending?: number; runtimeAvailable?: boolean; runtimeLoading?: boolean;
}): { title: string; description: string; action?: EmptyListAction; actionLabel?: string } {
  if (view === "unread" && !unreadAvailable) return { title: "暂时无法读取未读状态", description: "已有会话仍然保留，重新读取后再确认。", action: "refresh", actionLabel: "重新读取" };
  if (view === "running" && !runtimeAvailable) return { title: runtimeLoading ? "正在确认运行中的任务" : "运行状态暂时不可用", description: "状态恢复后会自动更新，也可以先查看全部会话。", action: "showAll", actionLabel: "查看全部会话" };
  if (query.trim()) return { title: "没有找到匹配的会话", description: "", action: "clearQuery", actionLabel: "清除搜索" };
  if (projectScope && view === "all") return { title: projectScope === "__unassigned__" ? "没有未归属项目的会话" : "这个项目还没有会话", description: "", action: "showAll", actionLabel: "查看全部会话" };
  if (hasFilters) return { title: "当前筛选下没有会话", description: "", action: "clearFilters", actionLabel: "清除筛选" };
  if (view === "unread") return { title: "暂时没有待处理会话", description: unreadPending ? "还有未读会话尚未确认结束，结束后会出现在这里。" : "等待回答、确认或有未读结果的会话会出现在这里。", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "running") return { title: "暂未确认有运行中的任务", description: "这里显示 Mac 上当前已确认的运行任务。", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "all") return { title: "还没有会话", description: "", action: "create", actionLabel: "新建会话" };
  if (view === "pinned") return { title: "还没有置顶会话", description: "左划会话可置顶，也会显示 Codex 的置顶会话。", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "archived") return { title: "没有已归档会话", description: "", action: "showAll", actionLabel: "查看全部会话" };
  if (view === "recent") return { title: "还没有打开记录", description: "", action: "showAll", actionLabel: "查看全部会话" };
  return { title: "没有会话", description: "", action: "showAll", actionLabel: "查看全部会话" };
}

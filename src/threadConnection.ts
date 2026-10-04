import type { Thread } from "./types";

export type ThreadConnection = { status: "idle" } | {
  requestId: string;
  status: "connecting" | "connected" | "failed";
  startedAt: number;
  checkedAt: number;
  code?: string;
};
export type OpenThreadResult = { status: string; thread: Thread; connection?: ThreadConnection; readOnly?: boolean };

// History and the small connection endpoint can finish in either order. A late
// snapshot must not turn a verified/failed attempt back into "connecting".
export function newerConnection(current: ThreadConnection, incoming?: ThreadConnection): ThreadConnection {
  if (!incoming || incoming.status === "idle") return current;
  if (current.status === "idle") return incoming;
  if (incoming.startedAt < current.startedAt) return current;
  if (incoming.startedAt === current.startedAt && incoming.requestId !== current.requestId) return current;
  if (incoming.requestId === current.requestId) {
    if (incoming.checkedAt < current.checkedAt) return current;
    if (current.status !== "connecting" && incoming.status === "connecting") return current;
  }
  return incoming;
}

export function connectionFailureHint(code?: string) {
  if (["connection_timeout", "owner_lookup_timeout", "desktop_preflight_timeout"].includes(code || "")) return "连接原任务超时。草稿和待发消息已保留，请重试连接。";
  if (code === "app_version_changed") return "Mac 中的 Codex 版本已变化，暂时无法连接。草稿和待发消息已保留。";
  if (code === "connection_unknown") return "上次连接状态已不可用。草稿和待发消息已保留，请重试连接。";
  return "暂时未能连接 Mac 中的原任务。草稿和待发消息已保留，请重试连接。";
}

export function connectionFromHistory(current: ThreadConnection, history?: { source: string; resumeState?: string; checkedAt: number } | null): ThreadConnection {
  if (current.status !== "idle" && history?.source === "desktop" && history.resumeState === "resumed" && history.checkedAt >= current.checkedAt) {
    return { ...current, status: "connected", checkedAt: history.checkedAt, code: undefined };
  }
  return current;
}

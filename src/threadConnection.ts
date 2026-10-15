import type { Thread } from "./types";

export type ThreadConnection = { status: "idle" } | {
  requestId: string;
  status: "connecting" | "connected" | "failed";
  startedAt: number;
  checkedAt: number;
  code?: string;
};
export type OpenThreadResult = { status: string; thread: Thread; connection?: ThreadConnection; readOnly?: boolean };
export type ConnectOptions = { quiet?: boolean };

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
  if (["connection_timeout", "owner_lookup_timeout", "desktop_preflight_timeout"].includes(code || "")) return "连接超时";
  if (code === "desktop_protocol_incompatible" || code === "desktop_protocol_error") return "Codex 接口暂不兼容";
  if (code === "unsupported_app_identity") return "暂不支持此桌面应用";
  if (code === "app_version_changed") return "连接兼容性待确认";
  if (code === "connection_unknown") return "连接状态待确认";
  return "连接失败";
}

export function isConnectionCompatibilityFailure(code?: string) {
  return ["desktop_protocol_incompatible", "desktop_protocol_error", "unsupported_app_identity", "app_version_changed"].includes(code || "");
}

export function connectionFromHistory(current: ThreadConnection, history?: { source: string; resumeState?: string; checkedAt: number } | null): ThreadConnection {
  if (current.status !== "idle" && history?.source === "desktop" && history.resumeState === "resumed" && history.checkedAt >= current.checkedAt) {
    return { ...current, status: "connected", checkedAt: history.checkedAt, code: undefined };
  }
  return current;
}

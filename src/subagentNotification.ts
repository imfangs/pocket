import { heartbeatFieldMarkdown } from "./heartbeatMessage.ts";

export type SubagentNotification = {
  status: "completed" | "errored" | "running" | "pending_init" | "shutdown" | "not_found";
  label: string;
  text: string;
};
const labels = {
  completed: "子任务已完成", errored: "子任务遇到问题", running: "子任务运行中",
  pending_init: "子任务准备中", shutdown: "子任务已结束", not_found: "子任务暂不可用",
} as const;
const startsEnvelope = /^(?:[ \t]*\r?\n)* {0,3}<subagent_notification(?:\s|\/?>)/;
const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Only this complete wire shape is a notification. The original role, message
// ID and bytes stay untouched; no path, tool, file or execution capability is
// inferred from its content. JSON parsing never evaluates the result text.
export function subagentNotification(source: string): SubagentNotification | null {
  if (source.length > 262144 || !startsEnvelope.test(source)) return null;
  const envelope = /^(?:[ \t]*\r?\n)* {0,3}<subagent_notification>([\s\S]*)<\/subagent_notification>[ \t\r\n]*$/.exec(source);
  if (!envelope) return null;
  try {
    const json = envelope[1];
    // Each supported object has distinct keys. Reject duplicates, including
    // escaped spellings, instead of letting JSON.parse silently choose a value.
    const keys = [...json.matchAll(/"(?:\\.|[^"\\])*"/g)]
      .filter(match => /^\s*:/.test(json.slice(match.index! + match[0].length)))
      .map(match => JSON.parse(match[0]));
    if (keys.length !== new Set(keys).size) return null;
    const value: unknown = JSON.parse(json);
    if (!plainObject(value) || Object.keys(value).length !== 2 ||
      typeof value.agent_path !== "string" || !value.agent_path.trim() || value.agent_path.length > 1024 ||
      !("status" in value)) return null;
    let status: SubagentNotification["status"], text = "";
    if (typeof value.status === "string" && ["running", "pending_init", "shutdown", "not_found"].includes(value.status)) {
      status = value.status as typeof status;
    } else if (plainObject(value.status) && Object.keys(value.status).length === 1) {
      const [name, body] = Object.entries(value.status)[0];
      if (!["completed", "errored"].includes(name) || typeof body !== "string") return null;
      status = name as typeof status; text = body.trim();
    } else return null;
    return { status, label: labels[status], text };
  } catch { return null; }
}

export function subagentNotificationFallback(source: string): string | null {
  if (!startsEnvelope.test(source)) return null;
  const fence = "`".repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}text\n${source.trim()}\n${fence}`;
}

export function readableSubagentNotification(source: string): string {
  const notification = subagentNotification(source);
  return notification ? [notification.label, heartbeatFieldMarkdown(notification.text)].filter(Boolean).join("\n\n")
    : subagentNotificationFallback(source) ?? source;
}

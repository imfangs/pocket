import { projectStructuredMessage, structuredBodyMarkdown, type ChildStatus } from "./messageEnvelope.ts";
import { sourceTranslation, type DisplayTranslator } from "./displayTranslation.ts";

export type SubagentNotification = { status: ChildStatus; label: string; text: string; continuation?: string };

export function subagentNotification(source: string): SubagentNotification | null {
  const message = projectStructuredMessage(source);
  return message?.kind === "subagent" ? { status: message.status, label: message.label, text: message.text,
    ...(message.continuation ? { continuation: message.continuation } : {}) } : null;
}

export function subagentNotificationFallback(source: string): string | null {
  const message = projectStructuredMessage(source);
  return message?.kind === "literal" && message.tag === "subagent_notification" ? message.markdown : null;
}

export function readableSubagentNotification(source: string, translate: DisplayTranslator = sourceTranslation): string {
  const notification = subagentNotification(source);
  return notification ? [translate(notification.label), structuredBodyMarkdown(notification.text), notification.continuation].filter(Boolean).join("\n\n")
    : subagentNotificationFallback(source) ?? source;
}

import { projectStructuredMessage, structuredBodyMarkdown } from "./messageEnvelope.ts";
import { sourceTranslation, type DisplayTranslator } from "./displayTranslation.ts";

type HeartbeatMessage =
  | { kind: "trigger"; text: string; instructions: string; continuation?: string }
  | { kind: "result"; text: string; continuation?: string };

export function heartbeatMessage(source: string): HeartbeatMessage | null {
  const message = projectStructuredMessage(source);
  if (message?.kind === "heartbeat-trigger") return { kind: "trigger", text: message.text, instructions: message.instructions,
    ...(message.continuation ? { continuation: message.continuation } : {}) };
  if (message?.kind === "heartbeat-result") return { kind: "result", text: message.text,
    ...(message.continuation ? { continuation: message.continuation } : {}) };
  return null;
}

export function heartbeatFallback(source: string): string | null {
  const message = projectStructuredMessage(source);
  return message?.kind === "literal" && message.tag === "heartbeat" ? message.markdown : null;
}

export const heartbeatFieldMarkdown = structuredBodyMarkdown;

export function readableHeartbeatMessage(source: string, translate: DisplayTranslator = sourceTranslation): string {
  const message = heartbeatMessage(source);
  if (message) return [message.kind === "result" ? structuredBodyMarkdown(message.text)
    : `${translate(message.text)}\n\n${structuredBodyMarkdown(message.instructions)}`, message.continuation].filter(Boolean).join("\n\n");
  return heartbeatFallback(source) ?? source;
}

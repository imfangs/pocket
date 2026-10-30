import { stripEnvelopeCitationSuffix } from "./envelopeCitation.ts";

type HeartbeatMessage =
  | { kind: "trigger"; text: string; instructions: string }
  | { kind: "result"; text: string };

// These envelopes are message content, never instructions to execute. Parse a
// complete known shape without an XML engine, entities or external resources.
export function heartbeatMessage(source: string): HeartbeatMessage | null {
  if (!/^(?:[ \t]*\r?\n)* {0,3}<heartbeat>/.test(source)) return null;
  source = stripEnvelopeCitationSuffix(source, "heartbeat");
  const envelope = /^(?:[ \t]*\r?\n)* {0,3}<heartbeat>([\s\S]*)<\/heartbeat>[ \t\r\n]*$/.exec(source);
  if (!envelope) return null;
  const fields = new Map<string, string>();
  const body = envelope[1], field = /\s*<(automation_id|current_time_iso|instructions|decision|message)>([\s\S]*?)<\/\1>/gy;
  let offset = 0;
  while (offset < body.length && body.slice(offset).trim()) {
    field.lastIndex = offset;
    const match = field.exec(body);
    if (!match || fields.has(match[1])) return null;
    fields.set(match[1], match[2].trim());
    offset = field.lastIndex;
  }
  if (!fields.get("automation_id")) return null;
  if (fields.has("instructions") && !fields.has("message") && !fields.has("decision") && fields.get("instructions"))
    return { kind: "trigger", text: "定时检查", instructions: fields.get("instructions")! };
  if (fields.has("message") && !fields.has("instructions") && fields.get("message"))
    return { kind: "result", text: fields.get("message")! };
  return null;
}

// An incomplete or future envelope must stay visible instead of becoming an
// empty HTML block. Code examples and ordinary prose do not enter this branch.
function literalMarkdown(source: string): string {
  const fence = "`".repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}text\n${source.trim()}\n${fence}`;
}

export function heartbeatFallback(source: string): string | null {
  if (!/^(?:[ \t]*\r?\n)* {0,3}<heartbeat(?:\s|\/?>)/.test(source)) return null;
  return literalMarkdown(stripEnvelopeCitationSuffix(source, "heartbeat"));
}

export function heartbeatFieldMarkdown(source: string): string {
  if (!source.includes("<")) return source;
  type MarkdownNode = { type: string; children?: readonly MarkdownNode[] };
  const hasHtml = (node: MarkdownNode): boolean =>
    node.type === "html" || !!node.children?.some(hasHtml);
  // Nested tags remain literal data too. Preserve code examples normally, but
  // do not pass another raw HTML block to skipHtml and lose the extracted text.
  return hasHtml(fromMarkdown(source)) ? literalMarkdown(source) : source;
}

export function readableHeartbeatMessage(source: string): string {
  const message = heartbeatMessage(source);
  if (message) return message.kind === "result" ? heartbeatFieldMarkdown(message.text)
    : `${message.text}\n\n${heartbeatFieldMarkdown(message.instructions)}`;
  return heartbeatFallback(source) ?? source;
}
import { fromMarkdown } from "mdast-util-from-markdown";


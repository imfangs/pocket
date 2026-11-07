import { stripEnvelopeCitationSuffix, withoutEnvelopeCitations } from "./envelopeCitation.ts";
import { literalMessageMarkdown, messageDetailsParts, messageMarkdownProtectedRanges, trimMarkdownPadding } from "./messageDetails.ts";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";

export type ChildStatus = "completed" | "errored" | "running" | "pending_init" | "shutdown" | "not_found";
type Continuation = { continuation?: string };
export type StructuredMessage =
  | ({ kind: "heartbeat-trigger"; text: "定时检查"; instructions: string } & Continuation)
  | ({ kind: "heartbeat-result"; text: string } & Continuation)
  | ({ kind: "subagent"; status: ChildStatus; label: string; text: string } & Continuation)
  | { kind: "literal"; tag: "heartbeat" | "subagent_notification"; markdown: string };
type KnownTag = "heartbeat" | "subagent_notification";
const MAX_CHARS = 262144;
const labels: Record<ChildStatus, string> = {
  completed: "子任务已完成", errored: "子任务遇到问题", running: "子任务运行中",
  pending_init: "子任务准备中", shutdown: "子任务已结束", not_found: "子任务暂不可用",
};
const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const htmlTags = new Set(('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr').split(' '));

// Known disclosures use the same safe renderer. Other HTML/XML remains readable
// inert source; neither this body nor its metadata can authorize file access.
export function structuredBodyMarkdown(source: string, depth = 0): string {
  return normalizeBodyMarkdown(source, depth, true);
}

// Ordinary Markdown retains the established skipHtml behavior for raw HTML.
// Unknown XML still has readable inert fallback, as do malformed disclosures.
export function displayMessageMarkdown(source: string): string {
  return normalizeBodyMarkdown(source, 0, false);
}

function normalizeBodyMarkdown(source: string, depth: number, field: boolean): string {
  if (!source.includes("<")) return source;
  if (depth >= 6) return literalMessageMarkdown(source);
  const parts = messageDetailsParts(source, depth);
  if (parts.some(part => part.kind === "details")) return parts.map(part => part.kind === "details"
    ? /[<>]/.test(part.summary) ? literalMessageMarkdown(`<details><summary>${part.summary}</summary>\n${part.text}\n</details>`)
      : `<details${part.open ? " open" : ""}><summary>${part.summary}</summary>\n\n${normalizeBodyMarkdown(part.text, depth + 1, field)}\n\n</details>`
    : inertHtmlMarkdown(part.text, field)).join("\n\n");
  return inertHtmlMarkdown(parts.map(part => part.kind === "markdown" ? part.text : "").join("\n\n"), field);
}

function inertHtmlMarkdown(source: string, field: boolean): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
  const visit = (node: Root | RootContent, inline = false) => {
    if (node.type === "html" && node.position?.start.offset != null && node.position.end.offset != null) {
      const start = node.position.start.offset, end = node.position.end.offset, value = source.slice(start, end);
      const name = /^<\/?([a-z][\w:-]*)/i.exec(value)?.[1].toLowerCase();
      if (!field && (name && htmlTags.has(name) || /^<!--|^<!DOCTYPE/i.test(value))) return;
      edits.push({ start, end, text: inline ? escape(value) : `\n\n${literalMessageMarkdown(value)}\n\n` }); return;
    }
    if ("children" in node) for (const child of node.children) visit(child as RootContent,
      inline || ["paragraph", "heading", "emphasis", "strong", "delete", "link"].includes(node.type));
  };
  visit(fromMarkdown(source));
  let result = source;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

function heartbeatFields(body: string): Map<string, string> | null {
  const fieldPattern = /\s*<(automation_id|current_time_iso|instructions|decision|message)>/gy;
  const readFields = (offset: number, current: Map<string, string>): Map<string, string> | null => {
    if (!body.slice(offset).trim()) return current;
    fieldPattern.lastIndex = offset;
    const match = fieldPattern.exec(body);
    if (!match || current.has(match[1]) || current.size >= 5 ||
        match[1] === "message" && current.has("instructions") || match[1] === "instructions" && current.has("message")) return null;
    const start = fieldPattern.lastIndex, name = match[1], closing = `</${name}>`, remaining = body.slice(start);
    const markdown = ["instructions", "message"].includes(name);
    const candidates = [...remaining.matchAll(new RegExp(closing, "g"))];
    for (const close of markdown ? candidates.slice(-128).reverse() : candidates.slice(0, 1)) {
      const content = remaining.slice(0, close.index), protectedRanges = markdown ? messageMarkdownProtectedRanges(content) : [];
      // A closer inside an actual code/link example is field text. A skipped
      // unprotected closer would swallow duplicate wire fields, so reject it.
      if (candidates.some(candidate => candidate.index! < close.index! &&
          !protectedRanges.some(([a, b]) => candidate.index! >= a && candidate.index! < b))) continue;
      const fields = new Map(current);
      fields.set(name, markdown ? trimMarkdownPadding(content) : content.trim());
      const parsed = readFields(start + close.index! + closing.length, fields);
      if (parsed) return parsed;
    }
    return null;
  };
  return readFields(0, new Map());
}

function heartbeatBody(body: string): Exclude<StructuredMessage, { kind: "literal" }> | null {
  const fields = heartbeatFields(body);
  if (!fields) return null;
  if (!fields.get("automation_id")) return null;
  if (fields.has("instructions") && !fields.has("message") && !fields.has("decision") && fields.get("instructions")?.trim())
    return { kind: "heartbeat-trigger", text: "定时检查", instructions: fields.get("instructions")! };
  if (fields.has("message") && !fields.has("instructions") && fields.get("message")?.trim())
    return { kind: "heartbeat-result", text: fields.get("message")! };
  return null;
}

// A scheduler result can follow an ordinary authored answer rather than wrap
// the whole message. Only a complete, top-level result footer is metadata;
// triggers, examples and uncertain wire shapes stay in the original display.
export function readableHeartbeatResultSuffix(source: string): string {
  if (source.length > MAX_CHARS || !source.includes("<heartbeat>")) return source;
  // A multiline wire is a CommonMark HTML block. The same complete wire on
  // one line becomes a paragraph containing inline HTML instead.
  const candidates = fromMarkdown(source).children.filter(node => ["html", "paragraph"].includes(node.type) &&
    node.position?.start.offset != null && /^ {0,3}<heartbeat>/.test(source.slice(node.position.start.offset)));
  if (candidates.length !== 1) return source;
  const start = candidates[0].position!.start.offset!, prefix = trimMarkdownPadding(source.slice(0, start));
  // A trailing colon introduces a literal format/example, not a completed
  // answer followed by a scheduling receipt.
  if (!prefix.trim() || /[:：]\s*$/.test(prefix)) return source;
  const suffix = source.slice(start), opening = /^ {0,3}<heartbeat>/.exec(suffix)!;
  const close = "</heartbeat>", closers = [...suffix.matchAll(/<\/heartbeat>/g)].slice(-128).reverse();
  for (const closer of closers) {
    const body = suffix.slice(opening[0].length, closer.index), fields = heartbeatFields(body);
    const parsed = heartbeatBody(body);
    if (!fields || !["NOTIFY", "DONT_NOTIFY"].includes(fields.get("decision") || "") || parsed?.kind !== "heartbeat-result") continue;
    const tail = suffix.slice(closer.index! + close.length);
    if (withoutEnvelopeCitations(tail).trim()) continue;
    const result = structuredBodyMarkdown(parsed.text);
    const visibleText = (node: Root | RootContent): string | null => {
      if (node.type === "text" || node.type === "inlineCode") return node.value;
      if (node.type === "break") return "\n";
      // Text-identical links, images or other components can still contain
      // unique references. Never deduplicate their surrounding result.
      if (!["paragraph", "heading", "emphasis", "strong", "delete"].includes(node.type) || !("children" in node)) return null;
      const text = node.children.map(child => visibleText(child as RootContent));
      return text.some(value => value === null) ? null : text.join("");
    };
    const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
    const resultNodes = fromMarkdown(result).children;
    const visibleResult = resultNodes.length === 1 ? visibleText(resultNodes[0]) : null;
    const resultText = visibleResult === null ? "" : normalize(visibleResult);
    const duplicate = resultText && fromMarkdown(displayMessageMarkdown(prefix)).children.some(node =>
      visibleText(node) !== null && normalize(visibleText(node)!) === resultText);
    return duplicate ? prefix : `${prefix}\n\n${result}`;
  }
  return source;
}

function childBody(body: string): Exclude<StructuredMessage, { kind: "literal" }> | null {
  try {
    // Reject repeated/escaped wire keys before JSON.parse can choose a value.
    const keys = [...body.matchAll(/"(?:\\.|[^"\\])*"/g)]
      .filter(match => /^\s*:/.test(body.slice(match.index! + match[0].length)))
      .map(match => JSON.parse(match[0]));
    if (keys.length !== new Set(keys).size) return null;
    const value: unknown = JSON.parse(body);
    if (!plainObject(value) || Object.keys(value).length !== 2 ||
      typeof value.agent_path !== "string" || !value.agent_path.trim() || value.agent_path.length > 1024 || !("status" in value)) return null;
    let status: ChildStatus, text = "";
    if (typeof value.status === "string" && ["running", "pending_init", "shutdown", "not_found"].includes(value.status)) status = value.status as ChildStatus;
    else if (plainObject(value.status) && Object.keys(value.status).length === 1) {
      const [name, content] = Object.entries(value.status)[0];
      if (!["completed", "errored"].includes(name) || typeof content !== "string") return null;
      status = name as ChildStatus; text = content.trim() ? trimMarkdownPadding(content) : "";
    } else return null;
    return { kind: "subagent", status, label: labels[status], text };
  } catch { return null; }
}

const adapters: Record<KnownTag, (body: string) => Exclude<StructuredMessage, { kind: "literal" }> | null> = {
  heartbeat: heartbeatBody,
  subagent_notification: childBody,
};

// One display-only seam owns framing, code-example protection, strict wire
// validation, continuation and fallback for both supported envelope adapters.
// Parsing never edits the original message, follows a path or executes a tool.
export function projectStructuredMessage(source: string): StructuredMessage | null {
  const prefix = /^(?:[ \t]*\r?\n)* {0,3}<(heartbeat|subagent_notification)(?:\s|\/?>)/.exec(source);
  if (!prefix) return null;
  const tag = prefix[1] as KnownTag, exact = new RegExp(`^(?:[ \\t]*\\r?\\n)* {0,3}<${tag}>`).exec(source);
  if (exact && source.length <= MAX_CHARS) {
    const close = `</${tag}>`, starts = [...source.matchAll(new RegExp(close, "g"))].slice(-128).reverse();
    for (const match of starts) {
      const end = match.index!, parsed = adapters[tag](source.slice(exact[0].length, end));
      if (!parsed) continue;
      const tail = trimMarkdownPadding(withoutEnvelopeCitations(source.slice(end + close.length)));
      return tail.trim() ? { ...parsed, continuation: displayMessageMarkdown(tail) } : parsed;
    }
  }
  return { kind: "literal", tag, markdown: literalMessageMarkdown(stripEnvelopeCitationSuffix(source, tag)) };
}

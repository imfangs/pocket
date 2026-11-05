import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";

export type MessagePart = { kind: "markdown"; text: string } | {
  kind: "details"; summary: string; text: string; open: boolean;
};
const MAX_CHARS = 128 * 1024;
const detailTag = /<\/?details\b[^>]*>/gi;
const openTag = /^<details(?:\s+open(?:\s*=\s*(?:"open"|'open'|open|""|''))?)?\s*>$/i;

export function trimMarkdownPadding(source: string): string {
  // Remove framing blank lines, not the first code line's indentation or a
  // meaningful Markdown hard-break suffix.
  return source.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");
}

// Markdown reference definitions belong to the whole display projection, even
// when its disclosure body is rendered by another processor. Canonical first
// definitions are prepended, so a later local definition cannot shadow them.
export function messageReferenceDefinitions(source: string): string {
  const definitions = new Map<string, string>();
  const visit = (node: Root | RootContent) => {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      const identifier = node.identifier.replace(/[\\[\]]/g, "\\$&");
      const url = node.url.replace(/[<>\\\u0000-\u001f\u007f]/g, value => encodeURIComponent(value));
      definitions.set(node.identifier, `[${identifier}]: <${url}>`);
    }
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  };
  visit(fromMarkdown(source));
  return [...definitions.values()].join("\n");
}

function htmlRanges(source: string) {
  const ranges: [number, number][] = [];
  const visit = (node: Root | RootContent) => {
    if (["code", "inlineCode", "link", "linkReference", "image", "imageReference"].includes(node.type)) return;
    if (node.type === "html" && node.position?.start.offset != null && node.position.end.offset != null)
      ranges.push([node.position.start.offset, node.position.end.offset]);
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  };
  visit(fromMarkdown(source));
  return ranges;
}

export function messageMarkdownProtectedRanges(source: string) {
  // CommonMark initially treats details/summary as an HTML block, which can
  // hide a fenced/inline code example in its body from the outer AST. Mask
  // only these structural delimiters without changing offsets, then ask the
  // same Markdown parser for actual code/link ranges inside the disclosure.
  const blank = (value: string) => value.replace(/[^\r\n]/g, " ");
  // Summary is a plain disclosure label, not part of the body Markdown. Mask
  // its text too so delimiter padding cannot manufacture an indented code line.
  const masked = source.replace(/<summary\b[^>]*>[\s\S]*?<\/summary\s*>/gi, blank)
    .replace(/<\/?(?:details|summary)\b[^>]*>/gi, blank);
  const ranges: [number, number][] = [];
  const visit = (node: Root | RootContent) => {
    if (["code", "inlineCode", "link", "linkReference", "image", "imageReference", "definition"].includes(node.type) &&
        node.position?.start.offset != null && node.position.end.offset != null) {
      ranges.push([node.position.start.offset, node.position.end.offset]); return;
    }
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  };
  visit(fromMarkdown(masked));
  return ranges;
}

export function literalMessageMarkdown(source: string) {
  let length = 3;
  for (const match of source.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}text\n${source.trim()}\n${fence}`;
}

// Parse the one supported disclosure shape as data. No DOM/XML parser, raw HTML
// execution, event/style attributes, or new file capabilities are involved.
export function messageDetailsParts(source: string, depth = 0): MessagePart[] {
  if (!/<\/?details\b/i.test(source)) return [{ kind: "markdown", text: source }];
  if (source.length > MAX_CHARS) return [{ kind: "markdown", text: literalMessageMarkdown(source) }];
  if (depth >= 6) return [{ kind: "markdown", text: literalMessageMarkdown(source) }];
  const ranges = htmlRanges(source), codeRanges = messageMarkdownProtectedRanges(source), tags = [...source.matchAll(detailTag)]
    .filter(match => ranges.some(([start, end]) => match.index! >= start && match.index! < end) &&
      !codeRanges.some(([start, end]) => match.index! >= start && match.index! < end));
  const parts: MessagePart[] = [], stack: { start: number; tag: string }[] = [];
  let offset = 0, orphan = false;
  for (const match of tags) {
    const tag = match[0], start = match.index!;
    if (!/^<\//.test(tag)) {
      // Only block disclosures. Inline/code/link examples retain their source.
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      if (stack.length || /^ {0,3}$/.test(source.slice(lineStart, start))) stack.push({ start, tag });
      continue;
    }
    if (!stack.length) { orphan = true; continue; }
    const opening = stack.pop()!;
    if (stack.length) continue;
    const end = start + tag.length, body = source.slice(opening.start + opening.tag.length, start);
    const summary = /^\s*<summary\s*>([\s\S]*?)<\/summary\s*>/i.exec(body);
    const supported = openTag.test(opening.tag) && /^<\/details\s*>$/i.test(tag) && summary &&
      summary[1].trim().length > 0 && summary[1].length <= 1024;
    if (opening.start > offset) parts.push({ kind: "markdown", text: source.slice(offset, opening.start) });
    if (supported) parts.push({ kind: "details", summary: summary[1].trim(), text: trimMarkdownPadding(body.slice(summary[0].length)), open: /\sopen(?:\s|=|>)/i.test(opening.tag) });
    else parts.push({ kind: "markdown", text: literalMessageMarkdown(source.slice(opening.start, end)) });
    offset = end;
  }
  // A streamed/unsupported disclosure stays visible as inert text, not an empty
  // HTML block that silently swallows the remaining authored content.
  if (stack.length) {
    const start = stack[0].start;
    if (start >= offset) {
      if (start > offset) parts.push({ kind: "markdown", text: source.slice(offset, start) });
      parts.push({ kind: "markdown", text: literalMessageMarkdown(source.slice(start)) });
      offset = source.length;
    }
  }
  if (orphan) return [{ kind: "markdown", text: literalMessageMarkdown(source) }];
  if (offset < source.length) parts.push({ kind: "markdown", text: source.slice(offset) });
  return parts.length ? parts : [{ kind: "markdown", text: source }];
}

export function detailsAreReadable(source: string, depth = 0): boolean {
  if (depth >= 6) return false;
  const parts = messageDetailsParts(source, depth);
  if (!parts.some(part => part.kind === "details")) return false;
  return parts.every(part => {
    if (part.kind === "details") return !part.summary.includes("<") && !part.summary.includes(">") &&
      (messageDetailsParts(part.text, depth + 1).some(nested => nested.kind === "details")
        ? detailsAreReadable(part.text, depth + 1) : !containsRawHtml(part.text));
    return !containsRawHtml(part.text);
  });
}

export function containsRawHtml(source: string): boolean {
  const visit = (node: Root | RootContent): boolean => node.type === "html" ||
    "children" in node && node.children.some(child => visit(child as RootContent));
  return visit(fromMarkdown(source));
}

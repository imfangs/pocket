import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";
import { directiveAttributes, directiveIsEscaped, directivePattern, protectedMarkdownRanges } from "../shared/codex-directives.mjs";

export type CreatedThreadPart = { kind: "markdown"; text: string } | { kind: "created-thread"; threadId: string };
type Range = readonly [number, number];
const MAX_BYTES = 128 * 1024;
const threadIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

// CommonMark HTML blocks can stop at a blank line while the raw container is
// still open. Keep its whole body inert, including details and unknown tags.
function htmlContainerRanges(tree: Root, sourceLength: number): Range[] {
  const ranges: Range[] = [], stack: { name: string; start: number }[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === "html" && node.position?.start.offset != null) {
      const tokens = /<!--[\s\S]*?(?:-->|$)|<\?[\s\S]*?(?:\?>|$)|<![^>]*(?:>|$)|<\/?([a-z][a-z0-9:-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
      for (const match of node.value.matchAll(tokens)) {
        if (!match[1]) continue;
        const name = match[1].toLowerCase(), start = node.position.start.offset + match.index!;
        if (match[0].startsWith("</")) {
          let index = stack.length - 1;
          while (index >= 0 && stack[index].name !== name) index--;
          if (index >= 0) {
            ranges.push([stack[index].start, start + match[0].length]);
            stack.splice(index);
          }
        } else if (!voidTags.has(name) && !/\/\s*>$/.test(match[0])) stack.push({ name, start });
      }
      return;
    }
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  };
  visit(tree);
  for (const tag of stack) ranges.push([tag.start, sourceLength]);
  return ranges;
}

// The caller decides whether this is an assistant message. This projection
// retains source slices and carries only a thread ID, never navigation, machine
// selection, metadata, permissions, or a marker that ordinary links can forge.
export function createdThreadParts(source: string): readonly CreatedThreadPart[] {
  const unchanged: readonly CreatedThreadPart[] = [{ kind: "markdown", text: source }];
  if (!source.includes("created-thread") || source.length > MAX_BYTES || new TextEncoder().encode(source).byteLength > MAX_BYTES) return unchanged;
  const tree = fromMarkdown(source);
  const paragraphs = tree.children.filter(node => node.type === "paragraph" && node.position?.start.offset != null && node.position.end.offset != null)
    .map(node => [node.position!.start.offset!, node.position!.end.offset!] as Range);
  const protectedRanges: Range[] = [...protectedMarkdownRanges(source, true), ...htmlContainerRanges(tree, source.length)];
  // Encoded provenance is later removed by the existing display adapter. It
  // must not acquire cards while being split before that adapter runs.
  for (const match of source.matchAll(/&lt;(oai-mem-citation|citation_entries|rollout_ids)&gt;[\s\S]*?(?:&lt;\/\1&gt;|$)/g))
    protectedRanges.push([match.index!, match.index! + match[0].length]);

  const cards: { start: number; end: number; threadId: string }[] = [];
  let lineStart = 0, introducedExample = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const matches = [...line.matchAll(directivePattern)];
    const match = matches.length === 1 ? matches[0] : undefined;
    const standalone = match?.[1] === "created-thread" && /^ {0,3}$/.test(line.slice(0, match.index)) &&
      /^[ \t]*$/.test(line.slice(match.index! + match[0].length));
    if (standalone) {
      const start = lineStart + match.index!, end = start + match[0].length;
      const attrs = directiveAttributes(match[3]);
      if (!introducedExample && !match[2] && attrs && Object.keys(attrs).length === 1 &&
          typeof attrs.threadId === "string" && threadIdPattern.test(attrs.threadId) && !directiveIsEscaped(source, start) &&
          paragraphs.some(([a, b]) => start >= a && end <= b) && !protectedRanges.some(([a, b]) => start < b && end > a))
        cards.push({ start, end, threadId: attrs.threadId });
      // Adjacent directives, with or without blank lines, remain one example
      // group when a preceding explanatory line ended with a colon.
    } else if (line.trim()) introducedExample = /[:：]\s*$/.test(line);
    lineStart += rawLine.length + 1;
  }
  if (!cards.length) return unchanged;
  const parts: CreatedThreadPart[] = [];
  let offset = 0;
  for (const card of cards) {
    if (card.start > offset) parts.push({ kind: "markdown", text: source.slice(offset, card.start) });
    parts.push({ kind: "created-thread", threadId: card.threadId });
    offset = card.end;
  }
  if (offset < source.length) parts.push({ kind: "markdown", text: source.slice(offset) });
  return parts;
}

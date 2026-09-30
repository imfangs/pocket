import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

const taskId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function pocketTaskUrl(value: string) {
  const match = /^(?:codex:\/\/threads\/|\/\?task=)([^/?#]+)$/.exec(value);
  return match && taskId.test(match[1]) ? `/?task=${match[1]}` : null;
}

function attributes(source: string) {
  const result: Record<string, string> = Object.create(null);
  const pattern = /([a-zA-Z][\w-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\w.-]+)/g;
  let end = 0;
  for (const match of source.matchAll(pattern)) {
    if (source.slice(end, match.index).trim()) return null;
    const raw = match[2];
    try { result[match[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1).replace(/\\'/g, "'") : raw; }
    catch { return null; }
    end = match.index + match[0].length;
  }
  return source.slice(end).trim() ? null : result;
}
const plain = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&");
const quote = (text: string) => "\n\n" + plain(text).split("\n").map(line => `> ${line}`).join("\n") + "\n\n";

// These are display adapters, never executable directives. Work on original
// offsets and protect Markdown code/examples and link destinations from edits.
export function readableCodexMarkdown(source: string): string {
  if (!/<(?:oai-mem-citation|citation_entries|rollout_ids)|&lt;|:(?:created-thread|code-comment|codex-|inbox-item|archive-thread|automation)|/.test(source)) return source;
  const protectedRanges: [number, number][] = [];
  function visit(node: Nodes) {
    if (["code", "inlineCode", "link", "image", "definition"].includes(node.type) && node.position) {
      protectedRanges.push([node.position.start.offset!, node.position.end.offset!]);
      return;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  }
  visit(fromMarkdown(source));
  const edits: { start: number; end: number; text: string }[] = [];
  const replace = (pattern: RegExp, render: (match: RegExpMatchArray) => string | null) => {
    for (const match of source.matchAll(pattern)) {
      let start = match.index!;
      const end = start + match[0].length;
      if (protectedRanges.some(([a, b]) => start >= a && start < b) || edits.some(e => start < e.end && end > e.start)) continue;
      const text = render(match);
      if (text !== null) {
        // A block-style followup often arrives as a list item. Remove that
        // marker too, rather than leaving an empty bullet ahead of the quote.
        const lineStart = source.lastIndexOf("\n", start - 1) + 1;
        if (text.startsWith("\n\n>") && /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+$/.test(source.slice(lineStart, start))) start = lineStart;
        edits.push({ start, end, text });
      }
    }
  };
  // Consume the entire citation block, including streamed/truncated tails.
  // Merely skipping HTML leaves underscore tag names and provenance as prose.
  replace(/<(oai-mem-citation|citation_entries|rollout_ids)>[\s\S]*?(?:<\/\1>|$)/g, () => "");
  replace(/&lt;(oai-mem-citation|citation_entries|rollout_ids)&gt;[\s\S]*?(?:&lt;\/\1&gt;|$)/g, () => "");
  replace(/:{1,2}(created-thread|code-comment|codex-followup|codex-annotation|inbox-item|archive-thread|automation-update|automation)\s*(?:\[((?:\\.|[^\]\\])*)\])?\{((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^{}"'])*)\}/g, match => {
    const name = match[1], label = match[2]?.replace(/\\([\[\]\\])/g, "$1"), attrs = attributes(match[3]);
    if (!attrs) return null;
    if (name === "created-thread") {
      return attrs.threadId && taskId.test(attrs.threadId)
        ? `[打开任务](/?task=${attrs.threadId})`
        : attrs.clientThreadId ? "任务正在准备中" : null;
    }
    if (name === "code-comment") {
      if (!attrs.title || !attrs.body) return null;
      return quote([attrs.title, attrs.body, attrs.file && `${attrs.file}${/^\d+$/.test(attrs.start || "") ? `:${attrs.start}` : ""}`].filter(Boolean).join("\n\n"));
    }
    if (name === "codex-followup") return label ? quote(label + (attrs.prompt && attrs.prompt !== label ? `\n\n${attrs.prompt}` : "")) : null;
    if (name === "codex-annotation") return /^\d+$/.test(attrs.index || "") ? `〔批注 ${attrs.index}〕` : null;
    if (name === "inbox-item") return attrs.title ? quote([attrs.title, attrs.summary].filter(Boolean).join("\n\n")) : null;
    if (name === "archive-thread") return "";
    return quote(attrs.name || attrs.title || "自动化任务（请在 Codex 查看）");
  });
  replace(/(cite|filecite|filenavlist|entity|image_group|i)([\s\S]*?)/g, match => {
    if (match[1] === "entity") {
      try { const data: unknown = JSON.parse(match[2]); if (Array.isArray(data) && typeof data[1] === "string") return plain(data[1]); } catch { /* Keep an unsupported payload visible. */ }
      return null;
    }
    if (match[1] === "filecite") {
      const lines = /(?:^|)(L\d+(?:-L?\d+)?)$/.exec(match[2]);
      return `〔文件引用${lines ? " " + lines[1] : ""}〕`;
    }
    // Reference IDs alone cannot reconstruct a source URL or a media attachment.
    return match[1] === "cite" ? "〔来源引用〕" : match[1] === "filenavlist" ? "〔相关文件〕" : "〔图片引用〕";
  });
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

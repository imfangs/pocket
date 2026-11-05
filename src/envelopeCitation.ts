import { protectedMarkdownRanges } from "../shared/codex-directives.mjs";
import { messageMarkdownProtectedRanges } from "./messageDetails.ts";

// The continuation owns its Markdown/code ranges independently of an outer
// HTML-like envelope. A citation mixed with prose must not fence that prose.
export function withoutEnvelopeCitations(source: string): string {
  const protectedRanges = [...protectedMarkdownRanges(source), ...messageMarkdownProtectedRanges(source)];
  const citation = /<(oai-mem-citation|citation_entries|rollout_ids)>[\s\S]*?(?:<\/\1>|$)|&lt;(oai-mem-citation|citation_entries|rollout_ids)&gt;[\s\S]*?(?:&lt;\/\2&gt;|$)/g;
  let result = "", offset = 0;
  for (const match of source.matchAll(citation)) {
    const start = match.index!;
    if (protectedRanges.some(([a, b]) => start >= a && start < b)) continue;
    result += source.slice(offset, start); offset = start + match[0].length;
  }
  return result + source.slice(offset);
}

// Call only after the envelope's original prefix/size checks. Parse Markdown
// solely in the trailing suffix: mdast can treat the entire XML/JSON envelope
// as HTML and miss code examples inside its message or instructions fields.
export function stripEnvelopeCitationSuffix(source: string, tag: "heartbeat" | "subagent_notification"): string {
  const close = `</${tag}>`, index = source.lastIndexOf(close);
  if (index < 0) return source;
  const boundary = index + close.length, tail = source.slice(boundary);
  if (!tail.trim()) return source;
  const retained = withoutEnvelopeCitations(tail);
  return retained !== tail && !retained.trim() ? source.slice(0, boundary) : source;
}

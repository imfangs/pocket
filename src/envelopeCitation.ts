import { protectedMarkdownRanges } from "../shared/codex-directives.mjs";

// Call only after the envelope's original prefix/size checks. Parse Markdown
// solely in the trailing suffix: mdast can treat the entire XML/JSON envelope
// as HTML and miss code examples inside its message or instructions fields.
export function stripEnvelopeCitationSuffix(source: string, tag: "heartbeat" | "subagent_notification"): string {
  const close = `</${tag}>`, index = source.lastIndexOf(close);
  if (index < 0) return source;
  const boundary = index + close.length, tail = source.slice(boundary);
  if (!tail.trim()) return source;
  const protectedRanges = protectedMarkdownRanges(tail);
  const citation = /<(oai-mem-citation|citation_entries|rollout_ids)>[\s\S]*?(?:<\/\1>|$)|&lt;(oai-mem-citation|citation_entries|rollout_ids)&gt;[\s\S]*?(?:&lt;\/\2&gt;|$)/g;
  const retained: string[] = [];
  let offset = 0;
  for (const match of tail.matchAll(citation)) {
    const start = match.index!;
    if (protectedRanges.some(([a, b]) => start >= a && start < b)) continue;
    retained.push(tail.slice(offset, start));
    offset = start + match[0].length;
  }
  retained.push(tail.slice(offset));
  // A footer plus prose, a fenced/inline example, or any other content keeps
  // the original source intact so the existing inert fallback still applies.
  return offset > 0 && !retained.join("").trim() ? source.slice(0, boundary) : source;
}

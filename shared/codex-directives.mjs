import { fromMarkdown } from 'mdast-util-from-markdown';
import { isMessageVideo } from './message-media.mjs';

export const directivePattern = /:{1,2}(created-thread|code-comment|codex-[a-z][a-z0-9-]*|inbox-item|archive-thread|automation-update|automation)\s*(?:\[((?:\\.|[^\]\\])*)\])?\{((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^{}"'])*)\}/g;

export const incompleteDirectivePattern = /:{1,2}(created-thread|code-comment|codex-[a-z][a-z0-9-]*|inbox-item|archive-thread|automation-update|automation)\s*(?:\[((?:\\.|[^\]\\])*)\]\s*)?\{(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^{}"'])*(?:"(?:\\.|[^"\\])*\\?|'(?:\\.|[^'\\])*\\?)?$/g;

export function directiveIsEscaped(source, start) {
  if (source[start - 1] === ':') return true;
  let slashes = 0;
  for (let index = start - 1; index >= 0 && source[index] === "\\"; index--) slashes++;
  return slashes % 2 === 1;
}

export function directiveAttributes(source) {
  const result = Object.create(null);
  const pattern = /([a-zA-Z][\w-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\w.-]+)/g;
  let end = 0;
  for (const match of source.matchAll(pattern)) {
    if (source.slice(end, match.index).trim() || Object.hasOwn(result, match[1])) return null;
    const raw = match[2];
    try { result[match[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1).replace(/\\'/g, "'") : raw; }
    catch { return null; }
    end = match.index + match[0].length;
  }
  return source.slice(end).trim() ? null : result;
}

export function protectedMarkdownRanges(source, includeHtml = false) {
  const ranges = [];
  const visit = node => {
    if ((['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'definition'].includes(node.type) || (includeHtml && node.type === 'html')) && node.position) {
      ranges.push([node.position.start.offset, node.position.end.offset]);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(source));
  return ranges;
}

export function localFileReference(value, decode = false) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const path = decode ? decodeURIComponent(value) : value;
    // Only literal local file paths. URLs, controls, and directory references
    // cannot become capabilities; permission and realpath checks happen later.
    if (!path.startsWith('/') || path.startsWith('//') || path.endsWith('/') || /[\u0000-\u001f\u007f]/.test(path)) return null;
    encodeURIComponent(path); // Reject malformed UTF-16 before a URL/header is made.
    return path;
  } catch { return null; }
}

// Shared by the renderer and server-side capability registration. Code examples
// and link destinations containing directive syntax do not grant file access.
export function referencedMessageFiles(source) {
  if (typeof source !== 'string') return [];
  const paths = [], add = path => { if (path && !paths.includes(path)) paths.push(path); };
  const protectedRanges = protectedMarkdownRanges(source, true);
  const codeProtectedRanges = protectedMarkdownRanges(source);
  // These display-only spans are removed/escaped by readableCodexMarkdown.
  // A blank line inside them can still create an image/link AST node.
  const hiddenRanges = [
    ...[...source.matchAll(/<(oai-mem-citation|citation_entries|rollout_ids)>[\s\S]*?(?:<\/\1>|$)/g),
      ...source.matchAll(/&lt;(oai-mem-citation|citation_entries|rollout_ids)&gt;[\s\S]*?(?:&lt;\/\1&gt;|$)/g)]
      .filter(match => !codeProtectedRanges.some(([a,b]) => match.index >= a && match.index < b)),
    ...[...source.matchAll(/(cite|filecite|filenavlist|entity|image_group|i)([\s\S]*?)/g)]
      .filter(match => {
        if (protectedRanges.some(([a,b]) => match.index >= a && match.index < b)) return false;
        if (match[1] !== 'entity') return true;
        // Invalid entities stay as ordinary Markdown in the renderer.
        try { const data = JSON.parse(match[2]); return Array.isArray(data) && typeof data[1] === 'string'; }
        catch { return false; }
      }),
  ].map(match => [match.index, match.index + match[0].length]);
  const directives = [...source.matchAll(directivePattern)];
  const componentRanges = [...directives, ...source.matchAll(incompleteDirectivePattern)]
    .map(match => [match.index, match.index + match[0].length]);
  const excludedRanges = [...componentRanges, ...hiddenRanges];
  const insideExcluded = node => node.position && excludedRanges.some(([a,b]) => node.position.start.offset >= a && node.position.start.offset < b);
  for (const match of directives) {
    if (match[1] !== 'codex-file-citation' || directiveIsEscaped(source, match.index) || [...protectedRanges, ...hiddenRanges].some(([a,b]) => match.index >= a && match.index < b)) continue;
    const attrs = directiveAttributes(match[3]);
    if (attrs) add(localFileReference(attrs.path));
  }
  const tree = fromMarkdown(source), definitions = new Map();
  const walk = (node, visit) => { visit(node); for (const child of node.children ?? []) walk(child, visit); };
  walk(tree, node => {
    // Match Markdown's first definition, never a shadowed later destination.
    if (node.type === 'definition' && !insideExcluded(node) && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  const visitReferences = (node, insideLink = false) => {
    const excluded = insideExcluded(node);
    const isLink = node.type === 'link' || node.type === 'linkReference';
    const link = excluded ? null : node.type === 'link' ? localFileReference(node.url, true)
      : node.type === 'linkReference' ? localFileReference(definitions.get(node.identifier), true) : null;
    add(link);
    if (!excluded && !insideLink && (node.type === 'image' || node.type === 'imageReference')) {
      const path = localFileReference(node.type === 'image' ? node.url : definitions.get(node.identifier), true);
      if (isMessageVideo(path)) add(path);
    }
    // A video inside an anchor remains label text, never nested media controls.
    // Local file cards can replace that label entirely.
    for (const child of node.children ?? []) visitReferences(child, insideLink || isLink);
  };
  visitReferences(tree);
  return paths;
}

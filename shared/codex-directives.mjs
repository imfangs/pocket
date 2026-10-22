import { fromMarkdown } from 'mdast-util-from-markdown';

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
  const directives = [...source.matchAll(directivePattern)];
  const componentRanges = [...directives, ...source.matchAll(incompleteDirectivePattern)]
    .map(match => [match.index, match.index + match[0].length]);
  const insideComponent = node => node.position && componentRanges.some(([a,b]) => node.position.start.offset >= a && node.position.start.offset < b);
  for (const match of directives) {
    if (match[1] !== 'codex-file-citation' || directiveIsEscaped(source, match.index) || protectedRanges.some(([a,b]) => match.index >= a && match.index < b)) continue;
    const attrs = directiveAttributes(match[3]);
    if (attrs) add(localFileReference(attrs.path));
  }
  const tree = fromMarkdown(source), definitions = new Map();
  const walk = (node, visit) => { visit(node); for (const child of node.children ?? []) walk(child, visit); };
  walk(tree, node => { if (node.type === 'definition' && !insideComponent(node)) definitions.set(node.identifier, node.url); });
  walk(tree, node => {
    if (insideComponent(node)) return;
    if (node.type === 'link') add(localFileReference(node.url, true));
    else if (node.type === 'linkReference') add(localFileReference(definitions.get(node.identifier), true));
  });
  return paths;
}

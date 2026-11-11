export const OFFICE_TEXT_TAGS: ReadonlySet<string> = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "strong", "em", "u", "s", "sup", "sub", "br", "a"]);
export function safeOfficeHref(value: string): string | undefined {
  if (!value || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password) return undefined;
    // Reject encoded and machine-prefixed private endpoints as well. File
    // contents receive no task, owner, attachment, or API authority.
    let path = url.pathname;
    for (let i = 0; i < 3; i++) { const decoded = decodeURIComponent(path); if (decoded === path) break; path = decoded; }
    if (/^\/*api(?:\/|\\)/i.test(path.replace(/\\/g, "/"))) return undefined;
    if (url.protocol === "mailto:" && /[\r\n]/i.test(decodeURIComponent(value))) return undefined;
    return value;
  } catch { return undefined; }
}

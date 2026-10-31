// Cloudflare Pages _headers rules used by the tested build, not copied policy
// strings. Reject unsupported syntax so a future policy is never silently lost.
export function parseStaticHeaders(text) {
  const rules = [];
  let rule;
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      if (!line.startsWith('/') || /[\s:]/.test(line)) throw new Error(`Unsupported _headers path at line ${index + 1}`);
      const pattern = line.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      rule = { pattern: new RegExp('^' + pattern + '$'), headers: {} }; rules.push(rule);
    } else {
      const match = /^\s+([!#$%&'*+.^_`|~\w-]+):\s*(.+)$/.exec(line);
      if (!rule || !match) throw new Error(`Unsupported _headers directive at line ${index + 1}`);
      const name = match[1].toLowerCase(), value = match[2].trim();
      rule.headers[name] = rule.headers[name] ? `${rule.headers[name]}, ${value}` : value;
    }
  }
  return pathname => {
    const headers = {};
    for (const rule of rules) if (rule.pattern.test(pathname)) {
      for (const [name, value] of Object.entries(rule.headers)) headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
    }
    return headers;
  };
}

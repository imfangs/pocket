const maxAttachments = 32;
const maxNameLength = 512;
const unsafeName = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f\ud800-\udfff]/u;
const unsafeNames = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f\ud800-\udfff]/gu;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const kind = value => value === 'image' || value === 'file';

function nativeName(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) return '';
  const basename = value.split(/[\\/]/).at(-1);
  if (!basename?.trim() || basename === '.' || basename === '..' || !basename.replace(unsafeNames, '').trim()) return '';
  let safe = basename.replace(unsafeNames, '\ufffd');
  if (safe.length > maxNameLength) {
    safe = safe.slice(0, maxNameLength - 1);
    if (/[\ud800-\udbff]$/.test(safe)) safe = safe.slice(0, -1);
    safe += '\u2026';
  }
  return safe;
}

// Display metadata only. This validator never reads a path, URL or ID, and
// never reconstructs a capability from cache or another incoming projection.
export function sanitizeUnavailableAttachments(value) {
  if (!Array.isArray(value) || value.length > maxAttachments) return [];
  return value.flatMap(item => record(item) && kind(item.kind) && typeof item.name === 'string' &&
    item.name.length <= maxNameLength && (item.name === '' || !!item.name.trim()) &&
    !/[\\/]/.test(item.name) && !unsafeName.test(item.name) && item.name !== '.' && item.name !== '..'
    ? [{ name: item.name, kind: item.kind }] : []);
}

// Native readers have already established attachment provenance. Keep only a
// bounded cross-platform basename for display; no filesystem lookup is made.
// Unnamed siblings remain blank slots beside known names. If no original name
// or basename is available, the caller retains its existing generic fallback.
export function unavailableAttachmentNames(value) {
  if (!Array.isArray(value) || !value.length || value.length > maxAttachments) return [];
  const names = value.map(item => record(item) && kind(item.kind)
    ? { name: nativeName(item.name) || nativeName(item.path), kind: item.kind }
    : { name: '', kind: 'file' });
  return names.some(item => item.name) ? sanitizeUnavailableAttachments(names) : [];
}

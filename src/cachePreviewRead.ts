// An opening sheet is not established reading interest yet. Let its first
// authenticated cache body render during entry, while the normal read observer
// still waits for motion to settle before advancing a watermark.
export function cachePreviewReadingProtected(root: HTMLElement | null, conversation: HTMLElement | null) {
  const doc = root?.ownerDocument ?? conversation?.ownerDocument;
  if (!doc || doc.hidden) return true;
  const selection = doc.getSelection();
  if (root && selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(root)) return true;
  const focused = doc.activeElement;
  if (focused && focused !== root && (root?.contains(focused) || conversation?.contains(focused) &&
      focused.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))) return true;
  if (doc.querySelector("dialog[open], [data-reading-overlay]:not([data-reading-motion])")) return true;
  const motions = doc.querySelectorAll("[data-reading-motion]");
  if (motions.length) return motions.length !== 1 || !conversation?.closest(".inspector[data-inspector-motion='entering']");
  return false;
}

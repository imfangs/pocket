type VisibleAnchor = { id: string; offset: number };

function rows(root: HTMLElement) {
  const nodes = [...root.querySelectorAll<HTMLElement>(".conversation-live [data-message-id]")];
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.dataset.messageId!, (counts.get(node.dataset.messageId!) ?? 0) + 1);
  // A conflict's occurrence may change across sources. It cannot establish
  // the same readable row, even though its React render key is unique.
  return nodes.filter(node => counts.get(node.dataset.messageId!) === 1)
    .map(node => ({ id: node.dataset.messageId!, rect: node.getBoundingClientRect() }));
}

// A feed can replace the visible window before the browser's next scroll
// event. Keep an exact visible row, never a stale numeric scrollTop. Capture
// again before DOM changes if reading continued after the feed notification.
export function createLiveReadingAnchor(options: { root: () => HTMLElement | null; enabled: () => boolean }) {
  let pending: { root: HTMLElement; scrollTop: number; anchors: VisibleAnchor[] } | null = null;
  const capture = () => {
    const root = options.root();
    if (!root || !options.enabled()) { pending = null; return; }
    const viewport = root.getBoundingClientRect();
    const anchors = rows(root).filter(({ rect }) => rect.width > 0 && rect.height > 0 &&
      rect.bottom > viewport.top && rect.top < viewport.bottom).map(({ id, rect }) =>
      ({ id, offset: rect.top - viewport.top }));
    pending = anchors.length ? { root, scrollTop: root.scrollTop, anchors } : null;
  };
  const updateReading = () => {
    if (!pending) return;
    const root = options.root();
    if (!options.enabled() || root !== pending.root) pending = null;
    else if (Math.abs(root.scrollTop - pending.scrollTop) > 2) capture();
  };
  return {
    prepare() { if (pending) updateReading(); else capture(); },
    updateReading,
    restore() {
      const saved = pending; pending = null;
      const root = options.root();
      if (!saved || root !== saved.root || !options.enabled()) return false;
      const displayed = rows(root);
      for (const anchor of saved.anchors) {
        const match = displayed.find(row => row.id === anchor.id && row.rect.width > 0 && row.rect.height > 0);
        if (!match) continue;
        const delta = match.rect.top - root.getBoundingClientRect().top - anchor.offset;
        if (Math.abs(delta) > 1) root.scrollTop += delta;
        return true;
      }
      return false;
    },
  };
}

export type EarlierHistoryAnchor = { id: string; offset: number };

export function captureEarlierHistoryAnchor(root: HTMLElement, candidates?: ReadonlySet<string>): EarlierHistoryAnchor | null {
  const viewport = root.getBoundingClientRect();
  const element = [...root.querySelectorAll<HTMLElement>("[data-message-id]")].find(node => {
    const rect = node.getBoundingClientRect();
    return (!candidates || candidates.has(node.dataset.messageId!)) && rect.width > 0 && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  return element ? { id: element.dataset.messageId!, offset: element.getBoundingClientRect().top - viewport.top } : null;
}

export function restoreEarlierHistoryAnchor(root: HTMLElement, anchor: EarlierHistoryAnchor | null) {
  if (!anchor) { root.scrollTop = 0; return; }
  const element = [...root.querySelectorAll<HTMLElement>("[data-message-id]")].find(node => node.dataset.messageId === anchor.id && node.getBoundingClientRect().width > 0);
  if (element) root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
  else root.scrollTop = 0;
}

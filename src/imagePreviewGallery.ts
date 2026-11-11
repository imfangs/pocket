export type ImagePreviewItem = { src: string; alt: string };

const imageUrl = /^\/api\/tasks\/([a-f0-9-]{36})\/(?:images\/[a-f0-9]{64}|attachments\/[a-f0-9-]{36}|files\/[a-f0-9]{64}\/image)$/i;
export const maxImagePreviewItems = 32;

export function isImagePreviewForScope(src: string, scope: string) {
  return imageUrl.exec(src)?.[1].toLowerCase() === scope.toLowerCase();
}

// The manifest only carries capabilities already supplied to image components.
// Bound a large message around its clicked image, retaining reading order.
export function imagePreviewGallery(scope: string, candidates: readonly ImagePreviewItem[], clicked: ImagePreviewItem): readonly ImagePreviewItem[] {
  if (!isImagePreviewForScope(clicked.src, scope)) return Object.freeze([]);
  const unique = new Map<string, ImagePreviewItem>();
  for (const item of candidates) {
    if (isImagePreviewForScope(item.src, scope) && !unique.has(item.src)) unique.set(item.src, { src: item.src, alt: item.alt });
  }
  // An opener may have just been reconciled. It still owns its original image.
  unique.set(clicked.src, { src: clicked.src, alt: clicked.alt });
  const items = [...unique.values()], index = items.findIndex(item => item.src === clicked.src);
  const start = Math.max(0, Math.min(index - Math.floor(maxImagePreviewItems / 2), items.length - maxImagePreviewItems));
  return Object.freeze(items.slice(start, start + maxImagePreviewItems).map(item => Object.freeze(item)));
}

// DOM nodes are used only for mounted membership and reading order. No path,
// data attribute or image source is read from the document to mint a capability.
export function createImagePreviewRegistry() {
  const entries = new Map<HTMLElement, ImagePreviewItem>();
  return {
    register(element: HTMLElement, item: ImagePreviewItem) {
      const registered = { src: item.src, alt: item.alt };
      entries.set(element, registered);
      return () => { if (entries.get(element) === registered) entries.delete(element); };
    },
    snapshot(opener: HTMLElement): readonly ImagePreviewItem[] {
      return [...entries].filter(([element]) => element.isConnected && element.ownerDocument === opener.ownerDocument)
        .sort(([left], [right]) => {
          const position = left.compareDocumentPosition(right);
          return position & 1 ? 0 : position & 4 ? -1 : position & 2 ? 1 : 0;
        }).map(([, item]) => ({ src: item.src, alt: item.alt }));
    },
  };
}

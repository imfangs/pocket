import { MOTION_EASE, MOTION_MS, prefersReducedMotion } from "./motion.ts";

export type ViewerMotion = "open" | "next" | "previous";
export async function decodedViewerImage(image: HTMLImageElement, current: () => boolean) {
  if (!current()) return null;
  if (typeof image.decode === "function") await image.decode();
  if (!current()) return null;
  if (!image.naturalWidth || !image.naturalHeight) throw new Error("Image decode unavailable");
  return { width: image.naturalWidth, height: image.naturalHeight };
}

// Only the image surface moves. Gesture transforms and all close/navigation
// controls remain owned by their existing implementations.
export function createImageViewerMotion(element: HTMLElement, browser = element.ownerDocument.defaultView) {
  let animation: Animation | null = null, disposed = false;
  const media = browser?.matchMedia("(prefers-reduced-motion: reduce)");
  const cancel = () => {
    const active = animation; animation = null;
    if (active) { active.onfinish = active.oncancel = null; active.cancel(); }
    element.removeAttribute("data-image-motion");
  };
  const preference = () => { if (media?.matches) cancel(); };
  const visibility = () => { if (element.ownerDocument.hidden) cancel(); };
  media?.addEventListener("change", preference);
  element.ownerDocument.addEventListener("visibilitychange", visibility);
  return {
    play(kind: ViewerMotion) {
      cancel();
      if (disposed || !browser || prefersReducedMotion(browser) || element.ownerDocument.hidden || !element.isConnected || typeof element.animate !== "function") return;
      const frames = kind === "open" ? [{ opacity: .45 }, { opacity: 1 }] : [
        { opacity: .75, transform: `translate3d(${kind === "next" ? 10 : -10}px,0,0)` }, { opacity: 1, transform: "translate3d(0,0,0)" },
      ];
      try {
        const active = element.animate(frames, { duration: MOTION_MS.content, easing: MOTION_EASE.out });
        animation = active; element.dataset.imageMotion = kind;
        const finish = () => { if (animation === active) { animation = null; element.removeAttribute("data-image-motion"); } };
        active.onfinish = active.oncancel = finish;
      } catch { cancel(); }
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true; cancel();
      media?.removeEventListener("change", preference);
      element.ownerDocument.removeEventListener("visibilitychange", visibility);
    },
  };
}

export const MOTION_MS = { feedback: 120, content: 180, navigation: 240 } as const;
export const MOTION_EASE = {
  out: "cubic-bezier(0.23, 1, 0.32, 1)",
  move: "cubic-bezier(0.77, 0, 0.175, 1)",
  drawer: "cubic-bezier(0.32, 0.72, 0, 1)",
} as const;

export function prefersReducedMotion(browser: Pick<Window, "matchMedia"> | undefined = typeof window === "undefined" ? undefined : window) {
  return !browser || browser.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Transformed content can still intersect its own scroll root. Keep the shared
// reading observer suspended until every moving surface has settled or left.
export function holdReadingMotion(doc: Document = document): () => void {
  const marker = doc.createElement("span");
  marker.hidden = true;
  marker.setAttribute("data-reading-overlay", "motion");
  marker.setAttribute("data-reading-motion", "");
  (doc.body || doc.documentElement).append(marker);
  const notify = () => {
    const event = doc.createEvent("Event");
    event.initEvent("pocket-reading-visibility-change", false, false);
    doc.defaultView?.dispatchEvent(event);
  };
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    marker.remove();
    notify();
  };
}

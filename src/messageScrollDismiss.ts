import { holdReadingMotion } from "./motion.ts";

type Options = {
  canDismiss: () => boolean;
  dismiss: () => void;
  settled: () => void;
};

// Only a deliberate touch gesture dismisses input. Programmatic scrolls from
// streaming, textarea measurement and keyboard layout must never do so.
export function bindMessageScrollDismiss(root: HTMLElement, options: Options, browser = window) {
  const doc = root.ownerDocument, panel = root.closest(".inspector");
  let start: { id: number; x: number; y: number; time: number } | null = null;
  let touching = false, dismissedAt = 0, timer: number | undefined;
  let releaseReading: (() => void) | undefined;
  const selected = () => doc.getSelection()?.isCollapsed === false;
  const clearTimer = () => { browser.clearTimeout(timer); timer = undefined; };
  const finish = () => {
    start = null; touching = false; clearTimer();
    if (!releaseReading) return;
    const release = releaseReading; releaseReading = undefined;
    // Recompute from the settled layout before releasing the shared reading
    // hold, so the old 100px near-bottom threshold cannot pull the reader back.
    options.settled();
    release();
  };
  const schedule = () => {
    clearTimer();
    if (!releaseReading || touching) return;
    timer = browser.setTimeout(() => {
      if (panel?.hasAttribute("data-keyboard-open") && browser.performance.now() - dismissedAt < 1200) schedule();
      else finish();
    }, 250);
  };
  const cancelCandidate = () => { start = null; };
  const begin = (event: TouchEvent) => {
    start = null; touching = !!releaseReading; clearTimer();
    if (event.touches.length !== 1 || event.defaultPrevented || selected() || !options.canDismiss() ||
        doc.querySelector("dialog[open], [data-reading-overlay]")) return;
    const target = event.target as Element | null;
    if (target?.closest("input, textarea, select, button, a, pre, .markdown-table, [contenteditable]:not([contenteditable='false'])")) return;
    const touch = event.touches[0];
    if (touch.clientX - (panel?.getBoundingClientRect().left ?? 0) <= 32) return;
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp };
  };
  const move = (event: TouchEvent) => {
    if (!start) return;
    if (event.touches.length !== 1 || event.defaultPrevented || selected() || !options.canDismiss() ||
        event.timeStamp - start.time >= 400) return cancelCandidate();
    const touch = event.touches[0];
    if (touch.identifier !== start.id) return cancelCandidate();
    const dx = Math.abs(touch.clientX - start.x), dy = Math.abs(touch.clientY - start.y);
    if (Math.max(dx, dy) < 12) return;
    if (dy < dx * 1.25) return cancelCandidate();
    start = null; touching = true; dismissedAt = browser.performance.now();
    releaseReading = holdReadingMotion(doc);
    options.dismiss();
  };
  const end = (event: TouchEvent) => { start = null; touching = event.touches.length > 0; schedule(); };
  const selectionChanged = () => { if (selected()) cancelCandidate(); };
  const focusChanged = () => { if (releaseReading && options.canDismiss()) finish(); };
  const hidden = () => { if (doc.visibilityState === "hidden") finish(); };
  root.addEventListener("touchstart", begin, { passive: true });
  root.addEventListener("touchmove", move, { passive: true });
  // The final finger may end outside the message region after a second touch.
  // Observe completion on the document so the reading hold cannot get stuck.
  doc.addEventListener("touchend", end, { passive: true, capture: true });
  doc.addEventListener("touchcancel", end, { passive: true, capture: true });
  root.addEventListener("scroll", schedule, { passive: true });
  root.addEventListener("contextmenu", cancelCandidate);
  doc.addEventListener("selectionchange", selectionChanged);
  doc.addEventListener("focusin", focusChanged);
  doc.addEventListener("visibilitychange", hidden);
  browser.visualViewport?.addEventListener("resize", schedule);
  browser.visualViewport?.addEventListener("scroll", schedule);
  browser.addEventListener("pagehide", finish);
  return () => {
    start = null; touching = false; clearTimer();
    // Unmount releases protection without publishing state to the old view.
    releaseReading?.(); releaseReading = undefined;
    root.removeEventListener("touchstart", begin);
    root.removeEventListener("touchmove", move);
    doc.removeEventListener("touchend", end, true);
    doc.removeEventListener("touchcancel", end, true);
    root.removeEventListener("scroll", schedule);
    root.removeEventListener("contextmenu", cancelCandidate);
    doc.removeEventListener("selectionchange", selectionChanged);
    doc.removeEventListener("focusin", focusChanged);
    doc.removeEventListener("visibilitychange", hidden);
    browser.visualViewport?.removeEventListener("resize", schedule);
    browser.visualViewport?.removeEventListener("scroll", schedule);
    browser.removeEventListener("pagehide", finish);
  };
}

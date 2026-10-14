import type { Message, QueuedMessage } from "./conversationFeed";
import { completeSubmittedEcho, type SubmittedQuery } from "./submittedQueries.ts";
import { sameAttachments } from "./attachments.ts";
import { holdReadingMotion, MOTION_EASE, MOTION_MS, prefersReducedMotion } from "./motion.ts";

export type HandoffRow<T> = { id: string; item: T; leaving: boolean };
const motionOwners = new WeakMap<HTMLElement, symbol>();

// A disappearing snapshot is not evidence of delivery. These IDs only describe
// transitions the existing receipt/echo rules have already authorized.
export function receiptHandoffs(entries: readonly SubmittedQuery[], messages: readonly Message[], queue: readonly QueuedMessage[]) {
  const submissions = new Set<string>(), outbox = new Set<string>(), explicit = new Set<string>();
  const messageIds = new Map<string, string>();
  for (const entry of entries) {
    const echoed = completeSubmittedEcho(entry, messages);
    if (entry.dismissed || entry.status === "cancelled") explicit.add(entry.requestId);
    if (entry.dismissed || entry.status === "cancelled" || entry.echoed || echoed) {
      submissions.add(entry.requestId); outbox.add(entry.requestId);
    }
    if (echoed) {
      const message = messages.find(item => item.role === "user" && item.clientMessageId === entry.requestId && !item.truncated
        && item.text.trim() === entry.text.trim() && sameAttachments(item.attachments, entry.attachments));
      if (message) messageIds.set(entry.requestId, message.id);
    }
    if (queue.some(item => item.id === entry.requestId && item.text.trim() === entry.text.trim()
      && sameAttachments(item.attachments, entry.attachments))) submissions.add(entry.requestId);
  }
  return { submissions, outbox, explicit, messageIds };
}

export function reconcileHandoffRows<T>(previous: readonly HandoffRow<T>[], items: readonly T[], key: (item: T) => string, exitIds: ReadonlySet<string>): HandoffRow<T>[] {
  const next = items.map(item => ({ id: key(item), item, leaving: false }));
  const present = new Set(next.map(row => row.id));
  previous.forEach((row, index) => {
    if (!present.has(row.id) && (row.leaving || exitIds.has(row.id))) next.splice(Math.min(index, next.length), 0, { ...row, leaving: true });
  });
  return next;
}

function selectedWithin(element: HTMLElement) {
  const selection = element.ownerDocument.getSelection();
  return !!selection && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(element);
}

// Keep the first visible message still while a receipt releases space. The
// bottom remains attached only when it was attached before this local motion.
function readingAnchor(element: HTMLElement) {
  const root = element.closest(".conversation")?.querySelector<HTMLElement>(".conversation-messages");
  if (!root) return () => {};
  let atBottom = root.scrollHeight - root.clientHeight - root.scrollTop < 2, previousScroll = root.scrollTop;
  const top = root.getBoundingClientRect().top;
  const anchor = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
    .find(item => !element.contains(item) && item.getBoundingClientRect().bottom > top);
  let previousTop = anchor?.getBoundingClientRect().top;
  return () => {
    if (!root.isConnected) return;
    if (root.scrollTop !== previousScroll) {
      // User scrolling or an existing layout-restoration hook takes precedence.
      previousScroll = root.scrollTop; previousTop = anchor?.getBoundingClientRect().top;
      atBottom = root.scrollHeight - root.clientHeight - root.scrollTop < 2;
      return;
    }
    if (atBottom && !selectedWithin(root)) root.scrollTop = root.scrollHeight;
    else if (anchor?.isConnected && previousTop !== undefined) {
      const current = anchor.getBoundingClientRect().top;
      root.scrollTop += current - previousTop;
      previousTop = anchor.getBoundingClientRect().top;
    }
    previousScroll = root.scrollTop;
  };
}

// Presentation only: never invokes a request, changes a receipt, or owns a draft.
// Re-entry/unmount can cancel it; selection or focus pauses an automatic exit.
export function animateReceiptHandoff(element: HTMLElement, phase: "enter" | "exit", complete: () => void = () => {}, explicit = false) {
  const doc = element.ownerDocument, browser = doc.defaultView;
  const protectedReading = () => selectedWithin(element) || !explicit && !!doc.activeElement && element.contains(doc.activeElement);
  if (!browser || (prefersReducedMotion(browser) || doc.visibilityState !== "visible" || typeof element.animate !== "function")
    && (phase !== "exit" || !protectedReading())) {
    complete(); return () => {};
  }
  let stopped = false, suspended = doc.visibilityState !== "visible", animation: Animation | undefined, frame: number | undefined, finishFrame: number | undefined;
  const owner = Symbol("receipt-motion");
  const reducedMedia = browser.matchMedia("(prefers-reduced-motion: reduce)");
  const release = holdReadingMotion(doc);
  let restoreAnchor = () => {};
  const detach = () => {
    doc.removeEventListener("selectionchange", check);
    element.removeEventListener("focusin", check);
    element.removeEventListener("focusout", afterFocus);
    doc.removeEventListener("visibilitychange", visibility);
    reducedMedia.removeEventListener("change", reducedMotion);
  };
  const reset = () => {
    animation?.cancel(); animation = undefined;
    if (frame !== undefined) browser.cancelAnimationFrame(frame);
    frame = undefined;
    if (motionOwners.get(element) === owner) { element.removeAttribute("data-handoff-phase"); motionOwners.delete(element); }
  };
  const finish = () => {
    if (stopped) return;
    stopped = true; detach();
    if (frame !== undefined) browser.cancelAnimationFrame(frame);
    restoreAnchor(); complete();
    // React removes the retained row before this frame; restore once more after
    // its gap/parent wrapper has also left, then reopen reading observation.
    finishFrame = browser.requestAnimationFrame(() => { reset(); restoreAnchor(); release(); });
  };
  const tick = () => { if (stopped) return; restoreAnchor(); frame = browser.requestAnimationFrame(tick); };
  const start = () => {
    if (stopped || suspended || animation || phase === "exit" && protectedReading()) return;
    if (!element.isConnected || doc.visibilityState !== "visible" || prefersReducedMotion(browser) || typeof element.animate !== "function") { finish(); return; }
    if (phase === "enter" && protectedReading()) { finish(); return; }
    motionOwners.set(element, owner); element.dataset.handoffPhase = phase;
    const height = element.getBoundingClientRect().height;
    const style = browser.getComputedStyle(element);
    // Tall retained text fades in place instead of pulling a whole screen shut.
    const collapse = phase === "exit" && height <= Math.min(280, browser.innerHeight / 2);
    const frames: Keyframe[] = phase === "enter" ? [{ opacity: .35 }, { opacity: 1 }] : collapse ? [
      { opacity: 1, height: `${height}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
        marginTop: style.marginTop, marginBottom: style.marginBottom, borderTopWidth: style.borderTopWidth, borderBottomWidth: style.borderBottomWidth, overflow: "hidden", boxSizing: "border-box" },
      { opacity: 0, height: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px", borderTopWidth: "0px", borderBottomWidth: "0px", overflow: "hidden", boxSizing: "border-box" },
    ] : [{ opacity: 1 }, { opacity: 0 }];
    animation = element.animate(frames, { duration: phase === "enter" ? MOTION_MS.content : MOTION_MS.feedback, easing: MOTION_EASE.out, fill: "forwards" });
    const current = animation;
    current.finished.then(() => { if (animation === current) finish(); }, () => {});
    frame = browser.requestAnimationFrame(() => {
      // Capture after the parent has applied its normal bottom/scroll restore.
      restoreAnchor = phase === "exit" ? readingAnchor(element) : () => {};
      tick();
    });
  };
  function check() {
    if (stopped || suspended) return;
    if (phase === "exit" && protectedReading()) { reset(); restoreAnchor(); }
    else start();
  }
  function afterFocus() { queueMicrotask(check); }
  function visibility() {
    suspended = doc.visibilityState !== "visible";
    if (!suspended) { check(); return; }
    // App switching does not revoke a selection or an in-progress edit. Keep
    // its original DOM even if focusout arrives while the page is hidden.
    if (phase === "exit" && protectedReading()) { reset(); restoreAnchor(); }
    else finish();
  }
  function reducedMotion() {
    if (!reducedMedia.matches) return;
    reset(); restoreAnchor();
    if (phase !== "exit" || !protectedReading()) finish();
  }
  doc.addEventListener("selectionchange", check);
  element.addEventListener("focusin", check);
  element.addEventListener("focusout", afterFocus);
  doc.addEventListener("visibilitychange", visibility);
  reducedMedia.addEventListener("change", reducedMotion);
  start();
  return () => {
    stopped = true; detach(); reset();
    if (finishFrame !== undefined) browser.cancelAnimationFrame(finishFrame);
    restoreAnchor(); release();
  };
}

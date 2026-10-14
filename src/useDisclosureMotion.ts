import { useCallback, useLayoutEffect, useRef } from "react";
import { holdReadingMotion, MOTION_EASE, MOTION_MS, prefersReducedMotion } from "./motion";

type Prepared = { from: number; anchor: HTMLElement | null; top: number; root: HTMLElement | null; release: () => void };
type Running = Prepared & { animation: Animation; frame: number; endHidden?: boolean; wasInert: boolean };

function scrollRoot(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(element.ownerDocument.defaultView!.getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

function containsSelection(element: HTMLElement) {
  const selection = element.ownerDocument.getSelection();
  return !!selection && !selection.isCollapsed && !!selection.rangeCount && selection.getRangeAt(0).intersectsNode(element);
}

// Only an explicit prepare() opts into animation. Polling and automatic folding
// continue to use their normal immediate layout, on the same content nodes.
export function createDisclosureMotion(element: HTMLElement) {
  const doc = element.ownerDocument, browser = doc.defaultView!;
  let prepared: Prepared | null = null, running: Running | null = null;
  let preparedFrame = 0;
  let disposed = false;
  const style = { height: element.style.height, maxBlockSize: element.style.maxBlockSize, overflow: element.style.overflow };
  const clearStyle = () => {
    element.style.height = style.height;
    element.style.maxBlockSize = style.maxBlockSize;
    element.style.overflow = style.overflow;
    element.removeAttribute("data-disclosure-motion");
  };
  const anchorPosition = (state: Prepared) => {
    if (state.root && state.anchor?.isConnected) {
      const delta = state.anchor.getBoundingClientRect().top - state.top;
      if (Math.abs(delta) > .25) state.root.scrollTop += delta;
    }
  };
  const cancel = (settle = true) => {
    browser.cancelAnimationFrame(preparedFrame); preparedFrame = 0;
    prepared?.release(); prepared = null;
    const active = running;
    if (!active) return;
    running = null;
    browser.cancelAnimationFrame(active.frame);
    active.animation.onfinish = null;
    active.animation.oncancel = null;
    active.animation.cancel();
    clearStyle();
    if (settle && active.endHidden !== undefined) element.hidden = active.endHidden;
    element.inert = active.wasInert;
    if (settle) anchorPosition(active);
    active.release();
  };
  const interrupt = () => cancel();
  const visibility = () => { if (doc.visibilityState === "hidden") cancel(); };
  // An intentional new scroll takes over immediately; animation never fights it.
  doc.addEventListener("wheel", interrupt, { passive: true });
  doc.addEventListener("touchmove", interrupt, { passive: true });
  doc.addEventListener("visibilitychange", visibility);
  browser.addEventListener("resize", interrupt);
  const media = browser.matchMedia("(prefers-reduced-motion: reduce)");
  const reduce = () => { if (media.matches) cancel(); };
  media.addEventListener("change", reduce);
  return {
    prepare(anchor: HTMLElement | null = element) {
      if (disposed) return;
      const from = element.getBoundingClientRect().height;
      const top = anchor?.getBoundingClientRect().top ?? 0;
      // Acquire the replacement gate before releasing an interrupted transition.
      const release = holdReadingMotion(doc);
      cancel(false);
      prepared = { from, anchor, top, root: scrollRoot(element), release };
      preparedFrame = browser.requestAnimationFrame(() => {
        preparedFrame = 0;
        // A controlled owner may decline the toggle. Never leave reading held.
        if (prepared) { prepared.release(); prepared = null; }
      });
    },
    commit(endHidden?: boolean, enabled = true) {
      if (disposed) return;
      const state = prepared;
      if (!state) { cancel(false); if (endHidden !== undefined) element.hidden = endHidden; return; }
      browser.cancelAnimationFrame(preparedFrame); preparedFrame = 0;
      prepared = null;
      if (endHidden !== undefined) element.hidden = endHidden;
      const to = element.getBoundingClientRect().height;
      const distance = Math.abs(to - state.from);
      const limit = Math.min(360, Math.max(160, browser.innerHeight * .55));
      if (!enabled || prefersReducedMotion(browser) || typeof element.animate !== "function" ||
          containsSelection(element) || distance < 1 || distance > limit) {
        anchorPosition(state);
        state.release();
        return;
      }
      const wasInert = element.inert;
      if (endHidden !== undefined) { element.hidden = false; if (endHidden) element.inert = true; }
      element.setAttribute("data-disclosure-motion", "");
      element.style.maxBlockSize = "none";
      element.style.overflow = "clip";
      // Height is bounded above; large documents never sweep across the viewport.
      const animation = element.animate([{ height: `${state.from}px` }, { height: `${to}px` }],
        { duration: MOTION_MS.content, easing: MOTION_EASE.out, fill: "both" });
      const active: Running = { ...state, animation, frame: 0, endHidden, wasInert };
      running = active;
      const tick = () => {
        if (running !== active) return;
        anchorPosition(active);
        active.frame = browser.requestAnimationFrame(tick);
      };
      // Child layout effects install the initial frame before the parent's scroll
      // restoration, then keep the trigger stationary for the whole transition.
      anchorPosition(active);
      active.frame = browser.requestAnimationFrame(tick);
      animation.onfinish = () => { if (running === active) cancel(); };
      animation.oncancel = () => { if (running === active) cancel(); };
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      doc.removeEventListener("wheel", interrupt);
      doc.removeEventListener("touchmove", interrupt);
      doc.removeEventListener("visibilitychange", visibility);
      browser.removeEventListener("resize", interrupt);
      media.removeEventListener("change", reduce);
    },
  };
}

export function useDisclosureMotion(open: boolean, hideClosed = false) {
  const ref = useRef<HTMLDivElement>(null);
  const motion = useRef<ReturnType<typeof createDisclosureMotion> | null>(null);
  const prepare = useCallback((anchor: HTMLElement | null) => {
    if (!ref.current) return;
    motion.current ??= createDisclosureMotion(ref.current);
    motion.current.prepare(anchor);
  }, []);
  useLayoutEffect(() => { motion.current?.commit(hideClosed ? !open : undefined); }, [open, hideClosed]);
  useLayoutEffect(() => () => { motion.current?.dispose(); motion.current = null; }, []);
  return { ref, prepare };
}

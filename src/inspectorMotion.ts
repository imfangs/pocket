import { bindInspectorSwipe } from "./mobileInspector.ts";
import { holdReadingMotion, MOTION_EASE, MOTION_MS, prefersReducedMotion } from "./motion.ts";

type Phase = "idle" | "entering" | "dragging" | "settling" | "exiting" | "closed";
type Options = { onClose: () => void; enabled?: () => boolean; animateEntry?: boolean };

export function bindInspectorMotion(panel: HTMLElement, options: Options, browser = window) {
  const document = browser.document, workspace = panel.closest<HTMLElement>(".workspace");
  const narrow = browser.matchMedia("(max-width: 760px)"), reduced = browser.matchMedia("(prefers-reduced-motion: reduce)");
  let phase: Phase = "idle", animation: Animation | null = null, generation = 0, stopped = false, closed = false, suspended = false;
  let releaseReading: (() => void) | null = null, offset = 0;
  const visible = () => !suspended && document.visibilityState !== "hidden";
  const editing = () => !!document.activeElement && panel.contains(document.activeElement) &&
    document.activeElement.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
  const enabled = () => !stopped && !closed && visible() && (options.enabled?.() ?? true);
  const animated = () => narrow.matches && !prefersReducedMotion(browser) && !editing() && !panel.hasAttribute("data-keyboard-open");
  const width = () => panel.clientWidth || browser.innerWidth;
  const transform = (x: number) => `translate3d(${x}px, 0, 0)`;
  const currentOffset = () => {
    if (!animation) return offset;
    const computed = browser.getComputedStyle(panel).transform;
    const values = computed.match(/^matrix(3d)?\(([^)]+)\)$/);
    if (values) {
      const value = Number(values[2].split(",")[values[1] ? 12 : 4]);
      if (Number.isFinite(value)) return value;
    }
    return offset;
  };
  const hold = () => { releaseReading ??= holdReadingMotion(document); };
  const release = () => { releaseReading?.(); releaseReading = null; };
  const setPhase = (next: Phase) => {
    phase = next;
    if (next === "idle") {
      panel.removeAttribute("data-inspector-motion"); workspace?.removeAttribute("data-inspector-navigation");
    } else {
      panel.setAttribute("data-inspector-motion", next); workspace?.setAttribute("data-inspector-navigation", next);
    }
  };
  const setOffset = (value: number) => { offset = value; panel.style.transform = transform(value); };
  const stopAnimation = () => {
    const current = currentOffset();
    generation++;
    if (animation) {
      const previous = animation; animation = null;
      setOffset(current); previous.cancel();
    }
    return current;
  };
  const settle = () => {
    stopAnimation(); offset = 0; panel.style.removeProperty("transform"); setPhase("idle");
    if (visible()) release();
  };
  const finishClose = () => {
    if (stopped || closed) return;
    closed = true; setPhase("closed");
    // Keep the reading hold until React actually removes this offscreen panel.
    // A close callback is not itself proof that the old detail has unmounted.
    options.onClose();
  };
  const travel = (to: number, next: "entering" | "settling" | "exiting", velocity = 0) => {
    const from = stopAnimation();
    if (!enabled()) { settle(); return; }
    if (!animated() || typeof panel.animate !== "function") {
      if (next === "exiting") finishClose(); else settle();
      return;
    }
    hold(); setPhase(next); setOffset(to);
    const distance = Math.abs(to - from);
    const duration = next === "entering" ? MOTION_MS.navigation : Math.min(MOTION_MS.navigation,
      Math.max(MOTION_MS.feedback, velocity > .55 ? distance / velocity : MOTION_MS.navigation * distance / width()));
    const token = generation;
    try {
      animation = panel.animate([{ transform: transform(from) }, { transform: transform(to) }], { duration, easing: MOTION_EASE.drawer });
      const running = animation;
      running.addEventListener("finish", () => {
        if (stopped || token !== generation || animation !== running) return;
        animation = null;
        if (next === "exiting") finishClose(); else settle();
      }, { once: true });
    } catch {
      animation = null;
      if (next === "exiting") finishClose(); else settle();
    }
  };
  const close = (animate = true) => {
    if (!enabled() || phase === "exiting") return;
    if (!animate || !animated()) { stopAnimation(); finishClose(); return; }
    travel(width(), "exiting");
  };
  const cancelGesture = () => {
    if (phase !== "dragging") return;
    // Selection, pinch and native cancellation restore stable content at once.
    settle();
  };
  const releaseSwipe = bindInspectorSwipe(panel, () => close(false), browser, {
    enabled: () => enabled() && !editing() && phase !== "exiting" && phase !== "closed",
    start() {
      const current = stopAnimation();
      if (animated()) { hold(); setPhase("dragging"); setOffset(current); }
      return current;
    },
    move(value) { if (phase === "dragging") setOffset(value); },
    release(complete, velocity) {
      if (complete) {
        if (phase === "dragging") travel(width(), "exiting", velocity); else close(false);
      } else if (phase === "dragging") travel(0, "settling");
    },
    cancel: cancelGesture,
  });
  const interacted = (event: Event) => {
    if (phase !== "entering" && phase !== "exiting" && phase !== "settling") return;
    const target = event.target as Element | null;
    if (target?.closest("[data-inspector-close]")) return;
    // A new edit or action wins over a pending exit. Let its native event run;
    // the existing DOM nodes and input focus stay intact.
    if (event.type === "focusin" || event.type === "input" || target?.closest("button, input, textarea, select, a, [contenteditable]:not([contenteditable='false'])")) settle();
  };
  const resized = () => { if (!closed) settle(); };
  const suspend = () => { suspended = true; if (!closed) { hold(); settle(); } };
  const resume = () => { suspended = false; resized(); };
  const visibility = () => document.visibilityState === "hidden" ? suspend() : resume();
  const preference = () => { if (reduced.matches && !closed) { if (phase === "exiting") { stopAnimation(); finishClose(); } else settle(); } };
  panel.addEventListener("pointerdown", interacted, true);
  panel.addEventListener("focusin", interacted, true);
  panel.addEventListener("input", interacted, true);
  browser.addEventListener("resize", resized);
  browser.addEventListener("orientationchange", resized);
  browser.addEventListener("pagehide", suspend);
  browser.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", visibility);
  narrow.addEventListener("change", resized);
  reduced.addEventListener("change", preference);
  if (options.animateEntry && enabled() && animated()) { setOffset(width()); travel(0, "entering"); }

  return {
    close,
    dispose() {
      if (stopped) return;
      stopped = true; stopAnimation(); releaseSwipe();
      panel.style.removeProperty("transform"); panel.removeAttribute("data-inspector-motion"); workspace?.removeAttribute("data-inspector-navigation");
      release();
      panel.removeEventListener("pointerdown", interacted, true);
      panel.removeEventListener("focusin", interacted, true);
      panel.removeEventListener("input", interacted, true);
      browser.removeEventListener("resize", resized);
      browser.removeEventListener("orientationchange", resized);
      browser.removeEventListener("pagehide", suspend);
      browser.removeEventListener("pageshow", resume);
      document.removeEventListener("visibilitychange", visibility);
      narrow.removeEventListener("change", resized);
      reduced.removeEventListener("change", preference);
    },
  };
}

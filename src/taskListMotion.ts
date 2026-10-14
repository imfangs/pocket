import { MOTION_EASE, MOTION_MS, prefersReducedMotion } from "./motion.ts";

type StatusSnapshot = { key: string; node: Element };
type RowSnapshot = { node: HTMLElement; top: number; bottom: number; visible: boolean; pinned: boolean; statuses: Map<string, StatusSnapshot> };
type PinIntent = { id: string; pinned: boolean; scope: string; confirmed: boolean };

// The outer list item owns Y motion. The existing swipe track retains its own
// X transform, so rank movement never takes control away from a swipe.
export function bindTaskListMotion(root: HTMLElement, browser = window) {
  const document = browser.document;
  const panel = root.closest<HTMLElement>(".list-panel");
  const reduced = browser.matchMedia?.("(prefers-reduced-motion: reduce)");
  const pointers = new Set<number>();
  const animations = new Map<Animation, { node: Element; moving: boolean }>();
  let touching = false, stopped = false, scope = "", quietUntil = 0;
  let previous = new Map<string, RowSnapshot>(), intent: PinIntent | null = null;
  let scrollTop = panel?.scrollTop ?? 0;
  const now = () => browser.performance.now();
  const release = (animation: Animation) => {
    const entry = animations.get(animation);
    if (entry?.moving) entry.node.removeAttribute("data-list-moving");
    animations.delete(animation);
  };
  const cancelAnimations = () => {
    for (const animation of animations.keys()) {
      release(animation);
      animation.cancel();
    }
  };
  const interrupt = () => { intent = null; cancelAnimations(); };
  const selected = () => browser.getSelection()?.isCollapsed === false;
  const available = () => !stopped && !document.hidden && !prefersReducedMotion(browser) && !pointers.size && !touching && !selected() && now() >= quietUntil &&
    !root.closest('[inert], [aria-hidden="true"]') && !root.querySelector("[data-swiping]") && !document.querySelector("[data-reading-overlay]");
  const capture = () => {
    const rows = new Map<string, RowSnapshot>();
    const bounds = panel?.getBoundingClientRect();
    const top = Math.max(bounds?.top ?? 0, 0), bottom = Math.min(bounds?.bottom ?? 0, browser.innerHeight);
    for (const node of root.querySelectorAll<HTMLElement>("[data-row-motion-id]")) {
      const rect = node.getBoundingClientRect();
      const statuses = new Map<string, StatusSnapshot>();
      for (const status of node.querySelectorAll<HTMLElement>("[data-list-status]")) {
        statuses.set(status.dataset.listStatus!, { key: status.dataset.listStatusKey ?? "", node: status });
      }
      rows.set(node.dataset.rowMotionId!, { node, top: rect.top, bottom: rect.bottom, visible: !!panel?.clientHeight && bottom > top && rect.bottom > top && rect.top < bottom,
        pinned: node.dataset.rowPinned === "true", statuses });
    }
    return rows;
  };
  const play = (node: Element, frames: Keyframe[], moving: boolean) => {
    if (typeof node.animate !== "function") return;
    try {
      const animation = node.animate(frames, { duration: moving ? MOTION_MS.content : MOTION_MS.feedback, easing: moving ? MOTION_EASE.move : MOTION_EASE.out });
      animations.set(animation, { node, moving });
      if (moving) node.setAttribute("data-list-moving", "true");
      animation.addEventListener("finish", () => release(animation), { once: true });
      animation.addEventListener("cancel", () => release(animation), { once: true });
    } catch { /* A missing animation implementation must never block an action. */ }
  };
  const down = (event: PointerEvent) => { pointers.add(event.pointerId); interrupt(); };
  const up = (event: PointerEvent) => { pointers.delete(event.pointerId); };
  const touchStart = () => { touching = true; interrupt(); };
  const touchEnd = (event: TouchEvent) => { touching = event.touches.length > 0; };
  const selection = () => { if (selected()) interrupt(); };
  const scroll = () => {
    // Anchoring changes scrollTop before commit records it. Its later scroll
    // event is not a new user scroll and must not cancel that same transition.
    if ((panel?.scrollTop ?? 0) === scrollTop) return;
    scrollTop = panel?.scrollTop ?? 0;
    quietUntil = now() + MOTION_MS.content;
    interrupt();
  };
  const contextMenu = () => { quietUntil = now() + MOTION_MS.content; interrupt(); };
  const leave = () => { pointers.clear(); touching = false; interrupt(); };
  const visibility = () => { if (document.hidden) leave(); };
  const preference = () => { if (reduced?.matches) interrupt(); };
  root.addEventListener("pointerdown", down, { capture: true, passive: true });
  document.addEventListener("pointerup", up, { capture: true, passive: true });
  document.addEventListener("pointercancel", up, { capture: true, passive: true });
  root.addEventListener("touchstart", touchStart, { capture: true, passive: true });
  document.addEventListener("touchend", touchEnd, { capture: true, passive: true });
  document.addEventListener("touchcancel", touchEnd, { capture: true, passive: true });
  root.addEventListener("contextmenu", contextMenu);
  panel?.addEventListener("scroll", scroll, { passive: true });
  document.addEventListener("selectionchange", selection);
  document.addEventListener("visibilitychange", visibility);
  browser.addEventListener("blur", leave);
  browser.addEventListener("resize", leave);
  reduced?.addEventListener("change", preference);

  return {
    beginPin(id: string, pinned: boolean, animate = true) {
      interrupt();
      // Keyboard actions and interactions that just scrolled remain immediate.
      if (animate && available()) intent = { id, pinned, scope, confirmed: false };
    },
    confirmPin(id: string) { if (intent?.id === id) intent.confirmed = true; },
    cancelPin(id: string) { if (intent?.id === id) intent = null; },
    prepareLayout: cancelAnimations,
    isMoving: () => [...animations.values()].some(animation => animation.moving),
    commit(nextScope: string) {
      if (stopped) return;
      const current = capture();
      if (nextScope !== scope) { interrupt(); previous = new Map(); scope = nextScope; }
      const canAnimate = available();
      const action = intent;
      if (action && action.scope === scope) {
        const actedRow = current.get(action.id);
        // An unpin in the pinned view may legitimately remove its row. Do not
        // infer success from absence until the actual action has confirmed it.
        if (actedRow?.pinned === action.pinned || (!actedRow && action.confirmed)) {
          intent = null;
          if (canAnimate) {
            const center = actedRow?.top ?? previous.get(action.id)?.top ?? 0;
            const moves = [...current.entries()].flatMap(([id, row]) => {
              const before = previous.get(id);
              if (!before?.visible || !row.visible || before.node !== row.node) return [];
              const delta = before.top - row.top;
              return Math.abs(delta) >= 1 ? [{ row, delta, distance: Math.abs(row.top - center) }] : [];
            }).sort((a, b) => a.distance - b.distance).slice(0, 8);
            for (const { row, delta } of moves) play(row.node, [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0px)" }], true);
          }
        }
      }
      if (canAnimate) for (const [id, row] of current) {
        const before = previous.get(id);
        if (!before?.visible || !row.visible || before.node !== row.node) continue;
        for (const [slot, status] of row.statuses) {
          // A status identity is independent of a time label: polling and time
          // ticks do not replay a fade, and newly mounted rows never fade in.
          if (before.statuses.get(slot)?.key !== status.key) play(status.node, [{ opacity: .45 }, { opacity: 1 }], false);
        }
      }
      previous = current;
      scrollTop = panel?.scrollTop ?? 0;
    },
    dispose() {
      if (stopped) return;
      stopped = true; leave(); previous.clear();
      root.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      root.removeEventListener("touchstart", touchStart, true);
      document.removeEventListener("touchend", touchEnd, true);
      document.removeEventListener("touchcancel", touchEnd, true);
      root.removeEventListener("contextmenu", contextMenu);
      panel?.removeEventListener("scroll", scroll);
      document.removeEventListener("selectionchange", selection);
      document.removeEventListener("visibilitychange", visibility);
      browser.removeEventListener("blur", leave);
      browser.removeEventListener("resize", leave);
      reduced?.removeEventListener("change", preference);
    },
  };
}

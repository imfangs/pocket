type Options = { canLoad: () => boolean; load: () => Promise<void> };
type Gesture = {
  kind: "touch" | "wheel"; qualified: boolean; lastActivity: number;
  endedAt: number | null; waitingMotion: boolean;
  id?: number; x?: number; y?: number; furthestY?: number;
};
const settleMs = 120, motionWaitMs = 1500, wheelBurstMs = 240;
const interactive = "input, textarea, select, button, a, summary, pre, table, video, audio, canvas, iframe, object, embed, .markdown-table, [role='button'], [role='link'], [role='slider'], [contenteditable]:not([contenteditable='false'])";
const hidden = "[hidden], [inert], [aria-hidden='true']";

// canLoad describes reader availability, not transient keyboard/focus motion.
// This observes native gestures without taking ownership of their scrolling.
export function bindEarlierHistoryScroll(root: HTMLElement, options: Options, browser = window) {
  const doc = root.ownerDocument, panel = root.closest(".inspector");
  let gesture: Gesture | null = null, touching = false, busy = false, disposed = false;
  let timer: number | undefined, lastWheel = -Infinity, wheelConsumed = false;
  const now = () => browser.performance.now();
  const selected = () => doc.getSelection()?.isCollapsed === false;
  const excluded = (target: EventTarget | null) => !!(target as Element | null)?.closest?.(interactive);
  const motion = () => !!doc.querySelector("[data-reading-motion]");
  const blocked = () => disposed || doc.visibilityState !== "visible" || root.isConnected === false ||
    !!root.closest(hidden) || root.getClientRects().length === 0 || selected() ||
    !!doc.querySelector("dialog[open], [data-reading-overlay]:not([data-reading-motion])");
  const canLoad = () => { try { return options.canLoad(); } catch { return false; } };
  const clearTimer = () => { browser.clearTimeout(timer); timer = undefined; };
  const cancel = () => { gesture = null; wheelConsumed = true; clearTimer(); };
  const atEdge = (x: number) => x - (panel?.getBoundingClientRect().left ?? root.getBoundingClientRect().left) <= 32;
  const updateMotion = (current: Gesture) => {
    const moving = motion();
    if ((moving || current.waitingMotion) && now() - current.endedAt! >= motionWaitMs) return false;
    current.waitingMotion = moving;
    return true;
  };
  const schedule = (delay = settleMs) => {
    clearTimer();
    if (gesture?.qualified && !touching) {
      if (!updateMotion(gesture)) return cancel();
      const remaining = gesture.waitingMotion ? motionWaitMs - (now() - gesture.endedAt!) : delay;
      timer = browser.setTimeout(attempt, Math.min(delay, remaining));
    }
  };
  function attempt() {
    timer = undefined;
    const current = gesture;
    if (!current || touching || busy || blocked()) return cancel();
    if (!updateMotion(current)) return cancel();
    const quietFor = now() - current.lastActivity;
    if (quietFor < settleMs) return schedule(settleMs - quietFor);
    if (!Number.isFinite(root.scrollTop) || root.scrollTop > 48) return cancel();
    if (current.waitingMotion) {
      const remaining = motionWaitMs - (now() - current.endedAt!);
      if (remaining <= 0) return cancel();
      return schedule(Math.min(60, remaining));
    }
    // Consume before calling business code, including a synchronous rejection.
    gesture = null; wheelConsumed = true;
    if (!canLoad() || disposed) return;
    busy = true;
    try { void Promise.resolve(options.load()).catch(() => {}).finally(() => { busy = false; }); }
    catch { busy = false; }
  }
  const begin = (event: TouchEvent) => {
    cancel(); touching = event.touches.length > 0; lastWheel = -Infinity;
    if (busy || event.defaultPrevented || event.touches.length !== 1 || blocked() || excluded(event.target) || !canLoad()) return;
    const touch = event.touches[0];
    if (atEdge(touch.clientX)) return;
    gesture = { kind: "touch", id: touch.identifier, x: touch.clientX, y: touch.clientY, furthestY: touch.clientY,
      qualified: false, endedAt: null, waitingMotion: false, lastActivity: now() };
  };
  const move = (event: TouchEvent) => {
    if (gesture?.kind !== "touch" || gesture.endedAt !== null) return;
    if (event.defaultPrevented || event.touches.length !== 1 || blocked() || excluded(event.target)) return cancel();
    const touch = event.touches[0], current = gesture;
    if (touch.identifier !== current.id) return cancel();
    const dx = Math.abs(touch.clientX - current.x!), dy = touch.clientY - current.y!;
    current.lastActivity = now();
    if (Math.max(dx, Math.abs(dy)) < 12) return;
    if (dy < 12 || dy < dx * 1.25 || touch.clientY < current.furthestY! - 12) return cancel();
    current.furthestY = Math.max(current.furthestY!, touch.clientY);
    current.qualified = true;
  };
  const end = (event: TouchEvent) => {
    touching = event.touches.length > 0;
    if (gesture?.kind !== "touch") return;
    if (gesture.endedAt !== null) { if (touching || event.defaultPrevented) cancel(); return; }
    if (event.defaultPrevented || touching || blocked() || !gesture.qualified) return cancel();
    gesture.endedAt = now(); gesture.lastActivity = now(); schedule();
  };
  const touchCancelled = () => { touching = false; cancel(); };
  const otherTouch = (event: TouchEvent) => {
    if (event.touches.length !== 1 || !root.contains(event.target as Node)) cancel();
  };
  const wheel = (event: WheelEvent) => {
    const time = now(), fresh = time - lastWheel >= wheelBurstMs;
    lastWheel = time;
    if (fresh) { cancel(); wheelConsumed = false; }
    if (touching || busy || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
        blocked() || excluded(event.target) || event.deltaY >= 0 || Math.abs(event.deltaY) < Math.abs(event.deltaX) * 1.25) return cancel();
    if (wheelConsumed) return;
    if (!gesture && !canLoad()) return cancel();
    gesture = { kind: "wheel", qualified: true, lastActivity: time, endedAt: time, waitingMotion: false };
    schedule();
  };
  const scroll = (event: Event) => {
    if (!gesture) return;
    if (event.defaultPrevented || blocked()) return cancel();
    gesture.lastActivity = now(); schedule();
  };
  const guard = () => {
    if (!gesture) { if (doc.visibilityState !== "visible") touching = false; return; }
    if (blocked()) { touching = false; return cancel(); }
    if (gesture?.waitingMotion && !motion()) schedule(Math.max(0, settleMs - (now() - gesture.lastActivity)));
  };
  const focus = (event: Event) => { if (excluded(event.target)) cancel(); else guard(); };
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, listener: EventListener, capture = false) => {
    target.addEventListener(type, listener, { passive: true, capture });
    listeners.push(() => target.removeEventListener(type, listener, capture));
  };
  listen(root, "touchstart", begin as EventListener);
  listen(root, "touchmove", move as EventListener);
  listen(root, "wheel", wheel as EventListener);
  listen(root, "scroll", scroll);
  listen(root, "contextmenu", cancel);
  listen(doc, "touchstart", otherTouch as EventListener, true);
  listen(doc, "touchend", end as EventListener, true);
  listen(doc, "touchcancel", touchCancelled, true);
  listen(doc, "selectionchange", guard);
  listen(doc, "focusin", focus);
  for (const type of ["beforeinput", "input", "compositionstart"]) listen(doc, type, cancel, true);
  listen(doc, "visibilitychange", guard);
  listen(browser, "pocket-reading-visibility-change", guard);
  listen(browser, "pagehide", touchCancelled);
  listen(browser, "pageshow", touchCancelled);
  const observer = browser.MutationObserver && doc.documentElement ? new browser.MutationObserver(guard) : null;
  observer?.observe(doc.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["hidden", "inert", "aria-hidden", "open", "data-reading-overlay", "data-reading-motion"] });
  return Object.assign(() => {
    disposed = true; touching = false; cancel();
    listeners.forEach(remove => remove()); observer?.disconnect();
  }, { cancel });
}

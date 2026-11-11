type Options = { pageKey: () => string; canLoad: () => boolean; waitForLayout?: () => boolean; load: () => void };
const settleMs = 120, burstMs = 240, intentMs = 6000;
const editable = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

// Observe scrolling without taking over native panning or row swipes. One
// deliberate gesture can append one batch; layout/restore scrolls alone cannot.
export function bindListLoadMore(panel: HTMLElement, options: Options, browser = window) {
  const doc = panel.ownerDocument;
  let gesture: { key: string; qualified: boolean; lastAt: number; x?: number; y?: number; id?: number } | null = null;
  let touching = false, consumed = true, lastWheel = -Infinity, disposed = false;
  let timer: number | undefined;
  const now = () => browser.performance.now();
  const blocked = () => disposed || doc.visibilityState !== "visible" || !panel.isConnected ||
    !panel.getClientRects().length || !!panel.closest("[inert], [hidden], [aria-hidden='true']") ||
    !!doc.querySelector("dialog[open], [data-reading-overlay]") || doc.getSelection()?.isCollapsed === false;
  const excluded = (target: EventTarget | null) => !!(target as Element | null)?.closest?.(editable);
  const clear = () => { browser.clearTimeout(timer); timer = undefined; };
  const cancel = () => { clear(); gesture = null; consumed = true; };
  const schedule = (delay = settleMs) => {
    clear();
    if (gesture?.qualified && !touching) timer = browser.setTimeout(attempt, delay);
  };
  function attempt() {
    timer = undefined;
    const pending = gesture;
    if (!pending || touching || blocked() || pending.key !== options.pageKey() || now() - pending.lastAt > intentMs) return cancel();
    if (panel.scrollHeight - panel.scrollTop - panel.clientHeight > 96 || panel.scrollTop < 0) {
      // Slow wheel ticks can be farther apart than settling but still belong
      // to one continuous read. Consume only after a batch, not before bottom.
      clear(); gesture = null; return;
    }
    // Pressed rows keep their geometry until their delayed click/400ms release.
    // Retry briefly after that settles instead of losing the bottom gesture.
    if (panel.querySelector("[data-list-interacting]") || options.waitForLayout?.()) return schedule(60);
    if (!options.canLoad()) { clear(); gesture = null; return; }
    cancel(); options.load();
  }
  const start = (event: TouchEvent) => {
    cancel(); touching = event.touches.length > 0; lastWheel = -Infinity;
    if (event.defaultPrevented || event.touches.length !== 1 || blocked() || excluded(event.target)) return;
    const touch = event.touches[0];
    gesture = { key: options.pageKey(), qualified: false, lastAt: now(), x: touch.clientX, y: touch.clientY, id: touch.identifier };
  };
  const move = (event: TouchEvent) => {
    const pending = gesture;
    if (!pending || pending.x === undefined || !touching) return;
    if (event.defaultPrevented || event.touches.length !== 1 || blocked()) return cancel();
    const touch = event.touches[0], dx = Math.abs(touch.clientX - pending.x), dy = pending.y! - touch.clientY;
    if (touch.identifier !== pending.id) return cancel();
    pending.lastAt = now();
    if (Math.max(dx, Math.abs(dy)) < 12) return;
    if (dy < 12 || dy < dx * 1.25) return cancel();
    pending.qualified = true;
  };
  const end = (event: TouchEvent) => {
    touching = event.touches.length > 0;
    if (event.defaultPrevented || touching || blocked()) return cancel();
    if (gesture) { gesture.lastAt = now(); schedule(); }
  };
  const reset = () => { touching = false; cancel(); };
  const wheel = (event: WheelEvent) => {
    const time = now();
    if (time - lastWheel >= burstMs) { cancel(); consumed = false; }
    lastWheel = time;
    if (touching || consumed || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        event.deltaY <= 0 || event.deltaY < Math.abs(event.deltaX) * 1.25 || blocked() || excluded(event.target)) return cancel();
    gesture = { key: options.pageKey(), qualified: true, lastAt: time }; schedule();
  };
  const scroll = () => {
    if (!gesture) return;
    if (blocked() || gesture.key !== options.pageKey()) return cancel();
    gesture.lastAt = now(); schedule();
  };
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        !["ArrowDown", "PageDown", "End"].includes(event.key) || blocked() || excluded(event.target)) return;
    gesture = { key: options.pageKey(), qualified: true, lastAt: now() }; schedule();
  };
  const focus = (event: Event) => { if (!panel.contains(event.target as Node) || excluded(event.target)) cancel(); };
  const listeners: (() => void)[] = [];
  const listen = (target: EventTarget, type: string, callback: EventListener, capture = false) => {
    target.addEventListener(type, callback, { passive: true, capture });
    listeners.push(() => target.removeEventListener(type, callback, capture));
  };
  listen(panel, "touchstart", start as EventListener); listen(panel, "touchmove", move as EventListener);
  listen(doc, "touchstart", ((event: TouchEvent) => {
    if (!panel.contains(event.target as Node) || event.touches.length !== 1) reset();
  }) as EventListener, true);
  listen(doc, "touchend", end as EventListener, true); listen(doc, "touchcancel", reset, true);
  listen(panel, "wheel", wheel as EventListener); listen(panel, "scroll", scroll); listen(panel, "keydown", key as EventListener);
  listen(doc, "focusin", focus); listen(doc, "selectionchange", () => { if (blocked()) cancel(); });
  listen(doc, "visibilitychange", reset); listen(browser, "blur", reset); listen(browser, "pagehide", reset); listen(browser, "pageshow", reset);
  return Object.assign(() => { disposed = true; reset(); listeners.forEach(remove => remove()); }, { cancel });
}

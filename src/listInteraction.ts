type Options = {
  scope: () => string;
  current: (id: string) => boolean;
  hold: () => void;
  release: () => void;
};

export function heldListRows<T extends { id: string }>(current: readonly T[], held: readonly T[] | null): T[] {
  if (!held) return [...current];
  const latest = new Map(current.map(row => [row.id, row]));
  return held.map(row => latest.get(row.id) ?? row);
}

// Keep the pressed target stable until its click is dispatched, not merely
// until pointerup: mobile browsers synthesize the click after touchend.
export function bindListInteraction(root: HTMLElement, options: Options, browser = window) {
  const document = browser.document, pointers = new Set<number>();
  let touchCount = 0, timer: number | undefined, disposed = false;
  let press: { id: string; scope: string; cancelled: boolean } | null = null;
  let geometry: { node: HTMLElement; height: string; overflow: string }[] = [];
  const idAt = (target: EventTarget | null) => (target as Element | null)?.closest?.<HTMLElement>("[data-row-motion-id]")?.dataset.rowMotionId;
  const clearTimer = () => { if (timer !== undefined) browser.clearTimeout(timer); timer = undefined; };
  const releaseOrder = () => {
    for (const { node, height, overflow } of geometry) { node.style.height = height; node.style.overflow = overflow; }
    geometry = [];
    root.removeAttribute("data-list-interacting");
    options.release();
  };
  const finish = () => { clearTimer(); press = null; releaseOrder(); };
  const settle = (delay = 400) => {
    clearTimer();
    if (press && !pointers.size && !touchCount) timer = browser.setTimeout(finish, delay);
  };
  const begin = (target: EventTarget | null) => {
    clearTimer();
    if (press && (pointers.size > 1 || touchCount > 1)) return;
    const id = idAt(target);
    if (!id || !options.current(id)) return;
    if (press) finish();
    press = { id, scope: options.scope(), cancelled: false };
    for (const node of root.querySelectorAll<HTMLElement>("[data-row-motion-id]")) {
      const height = node.getBoundingClientRect().height;
      if (!Number.isFinite(height) || height <= 0) continue;
      geometry.push({ node, height: node.style.height, overflow: node.style.overflow });
      node.style.height = `${height}px`; node.style.overflow = "hidden";
    }
    root.setAttribute("data-list-interacting", "");
    options.hold();
  };
  const down = (event: PointerEvent) => { if (event.button !== 0) return; pointers.add(event.pointerId); begin(event.target); };
  const up = (event: PointerEvent) => { pointers.delete(event.pointerId); settle(); };
  const cancel = (event: PointerEvent) => { if (press) press.cancelled = true; up(event); };
  const touchStart = (event: TouchEvent) => { touchCount = event.touches.length; if (!press) begin(event.target); else clearTimer(); };
  const touchEnd = (event: TouchEvent) => { touchCount = event.touches.length; settle(); };
  const touchCancel = (event: TouchEvent) => { if (press) press.cancelled = true; touchEnd(event); };
  const click = (event: MouseEvent) => {
    const id = idAt(event.target);
    const wrongPress = event.detail !== 0 && press && (press.cancelled || press.id !== id || press.scope !== options.scope());
    if (id && (!options.current(id) || wrongPress)) { event.preventDefault(); event.stopImmediatePropagation(); }
    settle(0);
  };
  const leave = () => { pointers.clear(); touchCount = 0; finish(); };
  const visibility = () => { if (document.hidden) leave(); };
  root.addEventListener("pointerdown", down, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", cancel, true);
  root.addEventListener("touchstart", touchStart, { capture: true, passive: true });
  document.addEventListener("touchend", touchEnd, { capture: true, passive: true });
  document.addEventListener("touchcancel", touchCancel, { capture: true, passive: true });
  root.addEventListener("click", click, true);
  browser.addEventListener("blur", leave);
  document.addEventListener("visibilitychange", visibility);
  return {
    scopeChanged() { if (press && press.scope !== options.scope()) { press.cancelled = true; releaseOrder(); } },
    dispose() {
      if (disposed) return;
      disposed = true; leave();
      root.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      root.removeEventListener("touchstart", touchStart, true);
      document.removeEventListener("touchend", touchEnd, true);
      document.removeEventListener("touchcancel", touchCancel, true);
      root.removeEventListener("click", click, true);
      browser.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", visibility);
    },
  };
}

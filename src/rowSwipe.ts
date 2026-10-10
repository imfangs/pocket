export const ROW_ACTION_WIDTH = 84;

type SwipeOptions = {
  enabled: () => boolean;
  isOpen: () => boolean;
  onClaim: () => void;
  onOpenChange: (open: boolean) => void;
  onTranslate: (offset: number, dragging: boolean) => void;
};
type Gesture = { id: number; x: number; y: number; time: number; base: number; claimed: boolean };

export function bindRowSwipe(row: HTMLElement, options: SwipeOptions, browser = window): () => void {
  let gesture: Gesture | null = null;
  let suppressClickAfter = 0, suppressClickUntil = 0;
  const selected = () => browser.getSelection()?.isCollapsed === false;
  const clamp = (offset: number) => Math.max(-ROW_ACTION_WIDTH, Math.min(0, offset));
  const mainButton = (target: EventTarget | null) => {
    const button = (target as Element | null)?.closest?.("button");
    return button && button === row.querySelector("button.task-select") ? button : null;
  };
  const cancel = () => {
    const claimed = gesture?.claimed;
    gesture = null;
    if (claimed) options.onTranslate(options.isOpen() ? -ROW_ACTION_WIDTH : 0, false);
  };
  const begin = (event: TouchEvent) => {
    cancel();
    // A fresh touch is an ordinary interaction, even inside the ghost-click window.
    suppressClickAfter = suppressClickUntil = 0;
    if (!options.enabled() || event.touches.length !== 1 || selected() || event.defaultPrevented) return;
    const target = event.target as Element | null;
    if (!target?.closest || target.closest("form, input, textarea, select, a, [contenteditable]:not([contenteditable='false'])")) return;
    if (target.closest("button") && !mainButton(target)) return;
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp,
      base: options.isOpen() ? -ROW_ACTION_WIDTH : 0, claimed: false };
  };
  const move = (event: TouchEvent) => {
    const current = gesture;
    if (!current) return;
    if (!options.enabled() || event.touches.length !== 1 || selected() || event.touches[0].identifier !== current.id) return cancel();
    const touch = event.touches[0];
    const dx = touch.clientX - current.x, dy = touch.clientY - current.y;
    if (!current.claimed) {
      // Leave long presses, diagonals, and established vertical scrolling to the browser.
      if (event.timeStamp - current.time >= 400) return cancel();
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) return;
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.5 ||
          (current.base === 0 && dx > 0) || (current.base === -ROW_ACTION_WIDTH && dx < 0) ||
          !event.cancelable || event.defaultPrevented) return cancel();
      current.claimed = true;
      options.onClaim();
      if (gesture !== current) return;
    }
    if (!event.cancelable) return cancel();
    event.preventDefault();
    options.onTranslate(clamp(current.base + dx), true);
  };
  const end = (event: TouchEvent) => {
    const current = gesture;
    if (!current) return;
    const touch = Array.from(event.changedTouches).find(item => item.identifier === current.id);
    if (!current.claimed || !touch || event.touches.length || !options.enabled() || selected()) return cancel();
    gesture = null;
    const open = clamp(current.base + touch.clientX - current.x) <= -ROW_ACTION_WIDTH / 2;
    suppressClickAfter = event.timeStamp;
    suppressClickUntil = event.timeStamp + 500;
    options.onOpenChange(open);
    options.onTranslate(open ? -ROW_ACTION_WIDTH : 0, false);
  };
  const click = (event: MouseEvent) => {
    if (!suppressClickUntil) return;
    if (event.timeStamp < suppressClickAfter || event.timeStamp > suppressClickUntil) {
      suppressClickAfter = suppressClickUntil = 0;
      return;
    }
    const source = event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } | null; pointerType?: string };
    if (!(event.detail > 0) || !mainButton(event.target) || source.sourceCapabilities?.firesTouchEvents === false ||
        (source.pointerType && source.pointerType !== "touch")) return;
    // Older Safari omits touch provenance: suppress one row click, not later taps or controls.
    suppressClickAfter = suppressClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  row.addEventListener("touchstart", begin, { passive: true });
  row.addEventListener("touchmove", move, { passive: false });
  row.addEventListener("touchend", end, { passive: true });
  row.addEventListener("touchcancel", cancel, { passive: true });
  row.addEventListener("contextmenu", cancel);
  row.addEventListener("click", click, true);
  browser.document.addEventListener("selectionchange", cancel);
  return () => {
    cancel();
    suppressClickAfter = suppressClickUntil = 0;
    row.removeEventListener("touchstart", begin);
    row.removeEventListener("touchmove", move);
    row.removeEventListener("touchend", end);
    row.removeEventListener("touchcancel", cancel);
    row.removeEventListener("contextmenu", cancel);
    row.removeEventListener("click", click, true);
    browser.document.removeEventListener("selectionchange", cancel);
  };
}

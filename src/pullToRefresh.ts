type PullState = { distance: number; refreshing: boolean; armed: boolean };
type Options = {
  canRefresh: () => boolean;
  refresh: () => Promise<void>;
  onChange: (state: PullState) => void;
};

export function bindPullToRefresh(panel: HTMLElement, options: Options, browser = window) {
  const narrow = browser.matchMedia("(max-width: 760px)");
  let start: { x: number; y: number } | null = null;
  let distance = 0, refreshing = false, disposed = false;
  let moved = false, suppressClickUntil = 0;
  const emit = () => {
    if (!disposed) options.onChange({ distance: Math.min(64, distance * 0.55), refreshing, armed: distance >= 80 });
  };
  const reset = () => { start = null; distance = 0; emit(); };
  const selected = () => browser.getSelection()?.isCollapsed === false;
  const begin = (event: TouchEvent) => {
    if (refreshing) return;
    reset();
    moved = false;
    suppressClickUntil = 0;
    if (!narrow.matches || !options.canRefresh() || panel.scrollTop > 0 ||
        event.touches.length !== 1 || selected()) return;
    const target = event.target as Element | null;
    if (target?.closest("input, textarea, select, a, button:not(.task-select), [contenteditable='true']")) return;
    start = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  };
  const move = (event: TouchEvent) => {
    if (!start || refreshing) return;
    if (event.touches.length !== 1 || !options.canRefresh() || selected()) return reset();
    const dx = event.touches[0].clientX - start.x;
    const dy = event.touches[0].clientY - start.y;
    moved ||= Math.hypot(dx, dy) >= 12;
    if (dy < -8 || Math.abs(dx) > Math.max(16, Math.abs(dy))) return reset();
    distance = Math.max(0, dy);
    emit();
  };
  const end = () => {
    if (moved) suppressClickUntil = Date.now() + 500;
    if (!start || refreshing) return;
    const commit = distance >= 80 && options.canRefresh() && !selected();
    start = null;
    if (!commit) return reset();
    refreshing = true;
    distance = 80;
    emit();
    void Promise.resolve().then(options.refresh).catch(() => {}).finally(() => {
      refreshing = false;
      reset();
    });
  };
  const click = (event: MouseEvent) => {
    // Safari may synthesize a row click after a short drag.
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
  };
  panel.addEventListener("touchstart", begin, { passive: true });
  panel.addEventListener("touchmove", move, { passive: true });
  panel.addEventListener("touchend", end, { passive: true });
  panel.addEventListener("touchcancel", reset, { passive: true });
  panel.addEventListener("click", click, true);
  return () => {
    disposed = true;
    panel.removeEventListener("touchstart", begin);
    panel.removeEventListener("touchmove", move);
    panel.removeEventListener("touchend", end);
    panel.removeEventListener("touchcancel", reset);
    panel.removeEventListener("click", click, true);
  };
}

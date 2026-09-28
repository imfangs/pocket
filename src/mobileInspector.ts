// The layout viewport can remain full-sized while Safari's keyboard covers it.
// Track the visible viewport, including Safari's focus-induced vertical pan.
export function bindInspectorViewport(panel: HTMLElement, browser = window) {
  const viewport = browser.visualViewport;
  const narrow = browser.matchMedia("(max-width: 760px)");
  let frame = 0;
  let keyboardOpen = false;
  const clear = () => {
    panel.style.removeProperty("--inspector-viewport-height");
    panel.style.removeProperty("--inspector-viewport-top");
    panel.removeAttribute("data-keyboard-open");
    keyboardOpen = false;
  };
  const update = () => {
    frame = 0;
    if (!narrow.matches || (viewport && Math.abs(viewport.scale - 1) > 0.05)) {
      clear();
      return;
    }
    const height = viewport?.height ?? browser.innerHeight;
    panel.style.setProperty("--inspector-viewport-height", `${height}px`);
    panel.style.setProperty("--inspector-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    const active = browser.document.activeElement;
    const editing = !!active && panel.contains(active) &&
      active.matches("input, textarea, [contenteditable='true']");
    // Keep the layout steady during the tap that blurs an input to submit it.
    // Release it when the keyboard's viewport actually returns.
    const obscured = browser.innerHeight - height > 80;
    keyboardOpen = (editing && (obscured || height < 520)) || (keyboardOpen && obscured);
    panel.toggleAttribute("data-keyboard-open", keyboardOpen);
  };
  const schedule = () => {
    if (!frame) frame = browser.requestAnimationFrame(update);
  };
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  browser.addEventListener("resize", schedule);
  browser.document.addEventListener("focusin", schedule);
  browser.document.addEventListener("focusout", schedule);
  narrow.addEventListener("change", schedule);
  update();
  return () => {
    if (frame) browser.cancelAnimationFrame(frame);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    browser.removeEventListener("resize", schedule);
    browser.document.removeEventListener("focusin", schedule);
    browser.document.removeEventListener("focusout", schedule);
    narrow.removeEventListener("change", schedule);
    clear();
  };
}

export function bindInspectorSwipe(panel: HTMLElement, close: () => void, browser = window) {
  const narrow = browser.matchMedia("(max-width: 760px)");
  let start: { x: number; y: number; time: number } | null = null;
  const cancel = () => { start = null; };
  const hasSelection = () => browser.getSelection()?.isCollapsed === false;
  const begin = (event: TouchEvent) => {
    cancel();
    if (!narrow.matches || event.touches.length !== 1 || hasSelection()) return;
    const target = event.target as Element | null;
    if (target?.closest("input, textarea, select, button, a, pre, .markdown-table, [contenteditable='true']")) return;
    const touch = event.touches[0];
    const edgeDistance = touch.clientX - panel.getBoundingClientRect().left;
    if (edgeDistance < 0 || edgeDistance > 32) return;
    start = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
  };
  const move = (event: TouchEvent) => {
    if (!start) return;
    if (event.touches.length !== 1) return cancel();
    const touch = event.touches[0];
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) cancel();
  };
  const end = (event: TouchEvent) => {
    const origin = start;
    cancel();
    if (!origin || event.touches.length || !event.changedTouches.length || hasSelection()) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - origin.x, dy = touch.clientY - origin.y;
    if (narrow.matches && dx >= 72 && Math.abs(dy) < Math.abs(dx) * 0.4 &&
        event.timeStamp - origin.time <= 650) close();
  };
  // Passive touch listeners preserve native vertical scroll and pinch zoom.
  panel.addEventListener("touchstart", begin, { passive: true });
  panel.addEventListener("touchmove", move, { passive: true });
  panel.addEventListener("touchend", end, { passive: true });
  panel.addEventListener("touchcancel", cancel, { passive: true });
  return () => {
    panel.removeEventListener("touchstart", begin);
    panel.removeEventListener("touchmove", move);
    panel.removeEventListener("touchend", end);
    panel.removeEventListener("touchcancel", cancel);
  };
}

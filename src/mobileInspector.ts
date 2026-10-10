// CSS owns the full-height layout. Only a confirmed software keyboard gets a
// temporary visual-viewport override; stale Safari measurements must not pin it.
export function bindInspectorViewport(panel: HTMLElement, browser = window) {
  const viewport = browser.visualViewport;
  const narrow = browser.matchMedia("(max-width: 760px)");
  let frame = 0, stopped = false, keyboardOpen = false;
  let closedHeight = 0, width = browser.innerWidth;
  let blurredAt: number | null = null;
  let resumedAt: number | null = null;
  let suspended: { height: number; top: number } | null = null;
  let timers: number[] = [];
  const now = () => browser.performance.now();
  const clear = () => {
    panel.style.removeProperty("--inspector-viewport-height");
    panel.style.removeProperty("--inspector-viewport-top");
    panel.removeAttribute("data-keyboard-open");
    keyboardOpen = false; blurredAt = null;
  };
  const cancel = () => {
    if (frame) browser.cancelAnimationFrame(frame);
    frame = 0;
    timers.forEach(timer => browser.clearTimeout(timer)); timers = [];
  };
  const update = () => {
    frame = 0;
    if (stopped) return;
    if (browser.document.visibilityState === "hidden" || !narrow.matches ||
        (viewport && (!Number.isFinite(viewport.scale) || Math.abs(viewport.scale - 1) > 0.05))) {
      clear(); return;
    }
    const height = viewport?.height ?? browser.innerHeight, offset = viewport?.offsetTop ?? 0;
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(offset)) { clear(); return; }
    const layoutHeight = Math.max(browser.innerHeight, browser.document.documentElement.clientHeight);
    if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) { clear(); return; }
    // Width changes invalidate the old orientation's closed-keyboard baseline.
    if (width !== browser.innerWidth) { width = browser.innerWidth; closedHeight = 0; clear(); }
    const active = browser.document.activeElement;
    const editing = !!active && panel.contains(active) && active.matches("input, textarea, [contenteditable='true']");
    const obscured = Math.max(closedHeight, layoutHeight) - height > 80;
    // A retained textarea focus after app switching is not fresh keyboard evidence.
    // A changed measurement, new viewport event, or new input focus releases this.
    if (suspended && suspended.height === height && suspended.top === offset && obscured) { clear(); return; }
    suspended = null;
    if (editing) blurredAt = null;
    else if (keyboardOpen && blurredAt === null) blurredAt = now();
    const closing = keyboardOpen && blurredAt !== null && now() - blurredAt < 400;
    if (!obscured || (!editing && !closing)) {
      if (!editing || !obscured) closedHeight = Math.max(layoutHeight, height);
      clear(); return;
    }
    keyboardOpen = true;
    const visibleHeight = Math.min(height, layoutHeight);
    const top = Math.max(0, Math.min(offset, layoutHeight - visibleHeight));
    const set = (key: string, value: string) => { if (panel.style.getPropertyValue(key) !== value) panel.style.setProperty(key, value); };
    set("--inspector-viewport-height", `${visibleHeight}px`);
    set("--inspector-viewport-top", `${top}px`);
    panel.toggleAttribute("data-keyboard-open", true);
  };
  const scheduleFrame = () => { if (!stopped && !frame) frame = browser.requestAnimationFrame(update); };
  const settle = () => {
    if (stopped || browser.document.visibilityState === "hidden") return;
    scheduleFrame();
    timers.forEach(timer => browser.clearTimeout(timer));
    // Safari may publish the final dimensions after the event that announced
    // closing/rotation. Sample briefly, then stop; never poll in the background.
    timers = [80, 240, 480, 1000].map(delay => browser.setTimeout(scheduleFrame, delay));
  };
  const freshViewport = () => { suspended = null; settle(); };
  const freshFocus = () => { suspended = null; settle(); };
  const blur = () => {
    // Start the grace period at the event, even if rendering is suspended until
    // all delayed samples have fired. A late first frame must not start it anew.
    if (keyboardOpen) blurredAt = now();
    settle();
  };
  const suspend = () => {
    cancel(); resumedAt = null; suspended = { height: viewport?.height ?? browser.innerHeight, top: viewport?.offsetTop ?? 0 }; clear();
  };
  const resume = () => {
    // pageshow, visibility and window focus can arrive in one recovery burst.
    // Reset once, preserving any fresh input/viewport evidence received between.
    const time = now();
    if (resumedAt === null || time - resumedAt > 1000) suspend();
    resumedAt = time; settle();
  };
  const visibility = () => browser.document.visibilityState === "hidden" ? suspend() : resume();
  const rotate = () => { cancel(); closedHeight = 0; clear(); settle(); };
  viewport?.addEventListener("resize", freshViewport);
  viewport?.addEventListener("scroll", freshViewport);
  browser.addEventListener("resize", freshViewport);
  browser.addEventListener("orientationchange", rotate);
  browser.addEventListener("pageshow", resume);
  browser.addEventListener("pagehide", suspend);
  browser.addEventListener("focus", resume);
  browser.document.addEventListener("visibilitychange", visibility);
  browser.document.addEventListener("focusin", freshFocus);
  browser.document.addEventListener("focusout", blur);
  narrow.addEventListener("change", freshViewport);
  update();
  return () => {
    stopped = true; cancel();
    viewport?.removeEventListener("resize", freshViewport);
    viewport?.removeEventListener("scroll", freshViewport);
    browser.removeEventListener("resize", freshViewport);
    browser.removeEventListener("orientationchange", rotate);
    browser.removeEventListener("pageshow", resume);
    browser.removeEventListener("pagehide", suspend);
    browser.removeEventListener("focus", resume);
    browser.document.removeEventListener("visibilitychange", visibility);
    browser.document.removeEventListener("focusin", freshFocus);
    browser.document.removeEventListener("focusout", blur);
    narrow.removeEventListener("change", freshViewport);
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

const answerEditor = "textarea, input:not([type='radio']):not([type='hidden'])";

// Questions have their own scroll ownership: optional answers live in the
// message reader, blocking answers in the request panel. Native focus can
// reveal an input before Safari publishes the keyboard's final viewport.
export function bindQuestionInputVisibility(root: HTMLElement, browser = window) {
  const doc = root.ownerDocument, viewport = browser.visualViewport;
  let frame = 0, timers: number[] = [], stopped = false, reading = false;
  const activeInput = () => {
    const active = doc.activeElement as HTMLElement | null;
    return active && root.contains(active) && active.matches(answerEditor) ? active : null;
  };
  const cancel = () => {
    if (frame) browser.cancelAnimationFrame(frame);
    frame = 0;
    timers.forEach(timer => browser.clearTimeout(timer)); timers = [];
  };
  const reveal = () => {
    frame = 0;
    const input = activeInput();
    if (stopped || !input || doc.visibilityState === "hidden" ||
        viewport && (!Number.isFinite(viewport.scale) || Math.abs(viewport.scale - 1) > .05)) return;
    const scroller = input.closest<HTMLElement>(".request-actions, .conversation-messages");
    if (!scroller) return;
    const box = scroller.getBoundingClientRect(), field = input.getBoundingClientRect();
    const height = viewport?.height ?? browser.innerHeight, offset = viewport?.offsetTop ?? 0;
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(offset)) return;
    const top = Math.max(box.top + scroller.clientTop, offset) + 8;
    const bottom = Math.min(box.top + scroller.clientTop + scroller.clientHeight, offset + height) - 8;
    if (bottom <= top) return;
    // Never use scrollIntoView: it can pan the document or the inspector and
    // fight the existing visual-viewport recovery. Do not focus or replace the
    // input; its caret, internal scroll and ongoing IME composition stay native.
    if (field.top < top || field.height > bottom - top) scroller.scrollTop += field.top - top;
    else if (field.bottom > bottom) scroller.scrollTop += field.bottom - bottom;
  };
  const schedule = () => {
    if (stopped || frame) return;
    // Let inspector height and AutoTextarea measurement settle before reading
    // the answer's geometry. Both already schedule layout work for this event.
    frame = browser.requestAnimationFrame(() => { frame = browser.requestAnimationFrame(reveal); });
  };
  const settle = () => {
    cancel();
    if (stopped || !activeInput() || doc.visibilityState === "hidden") return;
    schedule();
    // Match the existing bounded keyboard recovery window, including a final
    // metric published after its resize event. No polling or streaming hooks.
    timers = [80, 240, 480, 1000].map(delay => browser.setTimeout(schedule, delay));
  };
  const editing = (event: Event) => {
    if ((event.target as Element | null)?.matches(answerEditor)) { reading = false; settle(); }
  };
  const keyboard = () => {
    if (!reading && browser.matchMedia("(max-width: 760px)").matches) settle();
  };
  const focusChanged = () => { if (!activeInput()) cancel(); };
  const readingIntent = (event: Event) => {
    // A deliberate move back to reading cancels pending settling samples even
    // when iOS keeps the old textarea focused after dismissing its keyboard.
    if (!(event.target as Element | null)?.matches(answerEditor)) { reading = true; cancel(); }
  };
  const scroller = root.closest<HTMLElement>(".request-actions, .conversation-messages");
  root.addEventListener("focusin", editing);
  root.addEventListener("click", editing);
  root.addEventListener("input", editing);
  doc.addEventListener("focusin", focusChanged);
  doc.addEventListener("visibilitychange", cancel);
  scroller?.addEventListener("touchstart", readingIntent, { passive: true });
  scroller?.addEventListener("pointerdown", readingIntent, { passive: true });
  scroller?.addEventListener("wheel", readingIntent, { passive: true });
  viewport?.addEventListener("resize", keyboard);
  viewport?.addEventListener("scroll", keyboard);
  browser.addEventListener("resize", keyboard);
  browser.addEventListener("pagehide", cancel);
  return () => {
    stopped = true; cancel();
    root.removeEventListener("focusin", editing);
    root.removeEventListener("click", editing);
    root.removeEventListener("input", editing);
    doc.removeEventListener("focusin", focusChanged);
    doc.removeEventListener("visibilitychange", cancel);
    scroller?.removeEventListener("touchstart", readingIntent);
    scroller?.removeEventListener("pointerdown", readingIntent);
    scroller?.removeEventListener("wheel", readingIntent);
    viewport?.removeEventListener("resize", keyboard);
    viewport?.removeEventListener("scroll", keyboard);
    browser.removeEventListener("resize", keyboard);
    browser.removeEventListener("pagehide", cancel);
  };
}

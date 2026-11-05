import type { InspectorEntryOrigin } from "./inspectorFocus.ts";

// Native focus-visible can stay latched when an already-focused scroll region
// is tapped after keyboard/programmatic focus. Track this reading surface's
// intent without moving focus, consuming input or changing child controls.
export function bindMessageRegionFocus(root: HTMLElement, browser = window) {
  const document = root.ownerDocument;
  const previous = root.getAttribute("data-message-focus-origin");
  let tabPending = false, timer: number | undefined;
  const origin = (value: InspectorEntryOrigin) => root.setAttribute("data-message-focus-origin", value);
  const clearPending = () => { tabPending = false; browser.clearTimeout(timer); timer = undefined; };
  const pointer = (event: Event) => {
    clearPending();
    const target = event.target as Node | null;
    if (document.activeElement === root || target && root.contains(target)) origin("pointer");
  };
  const key = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229 || event.altKey) return;
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey) {
      clearPending(); tabPending = true;
      // Tab's native default action (including Shift+Tab) focuses its target
      // before this timer. Later unrelated programmatic focus stays neutral.
      timer = browser.setTimeout(clearPending, 0);
    } else if (document.activeElement === root && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", " "].includes(event.key)) {
      origin("keyboard");
    }
  };
  const focused = (event: FocusEvent) => {
    if (event.target === root) { origin(tabPending ? "keyboard" : root.getAttribute("data-message-focus-origin") === "pointer" ? "pointer" : "programmatic"); clearPending(); }
  };
  const blurred = (event: FocusEvent) => { if (event.target === root) origin("programmatic"); };
  origin("programmatic");
  document.addEventListener("pointerdown", pointer, { capture: true, passive: true });
  document.addEventListener("keydown", key, true);
  // Existing gesture tests and older touch surfaces can emit TouchEvents
  // independently. This listener is passive and never claims their gestures.
  root.addEventListener("touchstart", pointer, { capture: true, passive: true });
  root.addEventListener("focusin", focused);
  root.addEventListener("focusout", blurred);
  return () => {
    clearPending();
    document.removeEventListener("pointerdown", pointer, { capture: true });
    document.removeEventListener("keydown", key, true);
    root.removeEventListener("touchstart", pointer, { capture: true });
    root.removeEventListener("focusin", focused);
    root.removeEventListener("focusout", blurred);
    if (previous === null) root.removeAttribute("data-message-focus-origin");
    else root.setAttribute("data-message-focus-origin", previous);
  };
}

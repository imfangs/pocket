export type InspectorEntryOrigin = "pointer" | "keyboard" | "programmatic";
export type InspectorCloseOrigin = InspectorEntryOrigin;

// A zero-detail activation comes from the keyboard or assistive technology.
// Motion preferences are intentionally unrelated to focus intent.
export function inspectorEntryFromClick(event: { detail: number }): InspectorEntryOrigin {
  return event.detail > 0 ? "pointer" : "keyboard";
}

export function focusInspectorEntry(panel: HTMLElement, origin: InspectorEntryOrigin = "programmatic") {
  // A creation modal may still be leaving above the new detail. Its existing
  // completion handler restores focus after the top layer has gone.
  if (panel.ownerDocument.querySelector("dialog[open]")) return;
  const target = origin === "keyboard" ? panel.querySelector<HTMLElement>("[data-inspector-close]") ?? panel : panel;
  target.focus({ preventScroll: true });
}

// Returning from a touch gesture must not move the editor's keyboard modality
// onto a row button. Keyboard/assistive activation still restores that button.
export function scheduleInspectorReturnFocus(panel: HTMLElement, list: HTMLElement, threadId: string,
  origin: InspectorCloseOrigin, isCurrent: () => boolean, browser = window, signal?: AbortSignal) {
  if (signal?.aborted) return () => {};
  const document = panel.ownerDocument;
  const neutral = (target: Element | null) => !target || target === document.body || target === document.documentElement;
  let cancelled = false;
  const newerIntent = (event: Event) => {
    const target = event.target as Element | null;
    if (!neutral(target) && !panel.contains(target)) cancelled = true;
  };
  const events = ["pointerdown", "keydown", "focusin"];
  for (const event of events) document.addEventListener(event, newerIntent, true);
  const cleanup = () => {
    for (const event of events) document.removeEventListener(event, newerIntent, true);
    signal?.removeEventListener("abort", cancel);
  };
  const frame = browser.requestAnimationFrame(() => {
    cleanup();
    const active = document.activeElement;
    if (cancelled || !isCurrent() || !list.isConnected || list.closest("[inert]") || document.querySelector("dialog[open]") ||
      !neutral(active) && !panel.contains(active)) return;
    const row = origin === "keyboard" ? [...list.querySelectorAll<HTMLButtonElement>(".task-select[data-thread-id]")]
      .find(item => item.dataset.threadId === threadId && !item.disabled && !item.closest("[inert]")) : undefined;
    (row ?? list.querySelector<HTMLElement>(".task-list-surface"))?.focus({ preventScroll: true });
  });
  const cancel = () => { cancelled = true; browser.cancelAnimationFrame(frame); cleanup(); };
  signal?.addEventListener("abort", cancel, { once: true });
  return cancel;
}

export type InspectorEntryOrigin = "pointer" | "keyboard" | "programmatic";

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

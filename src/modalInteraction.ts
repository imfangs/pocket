export function modalCloseDecision(busy: boolean, dirty: boolean, fromBackdrop = false) {
  if (busy || dirty && fromBackdrop) return "ignore";
  return dirty ? "confirm" : "close";
}

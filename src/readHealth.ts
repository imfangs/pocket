import { isNetworkError } from "./requestError.ts";

export type ReadHealth = { pending: boolean; failures: number; failingSince: number | null; reachableAt: number | null };
export type ReadHealthEvent = { type: "pending" | "reachable" | "applied" | "unavailable" | "failed" | "settled"; error?: unknown };
export type ReadCompletion = { serial: number; outcome: "none" | "pending" | "applied" | "failed" | "unavailable" | "cancelled" };
export const emptyReadHealth = (): ReadHealth => ({ pending: false, failures: 0, failingSince: null, reachableAt: null });

// Diagnostic display only. A native unavailable/unknown response still proves
// its HTTP route is reachable; expired runtime facts do not become network errors.
export function isReadTransportFailure(error: unknown) {
  const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
  if (typeof status === "number") return status >= 500;
  return isNetworkError(error);
}

export function createReadHealth(now: () => number = () => performance.now()) {
  let value = emptyReadHealth();
  let completion: ReadCompletion = { serial: 0, outcome: "none" };
  const listeners = new Set<() => void>();
  const publish = (next: ReadHealth, force = false) => {
    if (!force && Object.keys(next).every(key => next[key as keyof ReadHealth] === value[key as keyof ReadHealth])) return;
    value = next; listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => value,
    // Applying verified data differs from transport reachability. Motion can
    // observe this receipt without turning a 200 fallback into fresh data.
    getCompletionSnapshot: () => completion,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset() { completion = { serial: 0, outcome: "none" }; publish(emptyReadHealth(), true); },
    observe(event: ReadHealthEvent) {
      const previous = completion;
      if (event.type === "pending") completion = { ...completion, outcome: "pending" };
      else if (event.type === "applied") completion = { serial: completion.serial + 1, outcome: "applied" };
      else if (event.type === "failed" || event.type === "unavailable") completion = { ...completion, outcome: event.type };
      else if (event.type === "settled" && completion.outcome === "pending") completion = { ...completion, outcome: "cancelled" };
      if (event.type === "applied" || event.type === "unavailable") {
        if (previous !== completion) { value = { ...value }; listeners.forEach(listener => listener()); }
        return;
      }
      if (event.type === "pending") publish({ ...value, pending: true }, previous !== completion);
      else if (event.type === "settled") publish({ ...value, pending: false }, previous !== completion);
      else if (event.type === "failed" && isReadTransportFailure(event.error))
        publish({ ...value, failures: value.failures + 1, failingSince: value.failingSince ?? now() }, previous !== completion);
      else publish({ ...value, failures: 0, failingSince: null, reachableAt: now() }, previous !== completion);
    },
  };
}
export type ReadHealthStore = ReturnType<typeof createReadHealth>;

export const collectionFailureGraceMs = 30000;
export function persistentCollectionFailureAt(health: readonly ReadHealth[]): number | null {
  const deadlines = health.filter(item => item.failures >= 3 && item.failingSince !== null &&
    !health.some(other => other !== item && other.reachableAt !== null && other.reachableAt >= item.failingSince!))
    .map(item => item.failingSince! + collectionFailureGraceMs);
  return deadlines.length ? Math.min(...deadlines) : null;
}

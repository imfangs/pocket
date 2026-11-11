import { isNetworkError } from "./requestError.ts";

export type ReadHealth = { pending: boolean; failures: number; failingSince: number | null; reachableAt: number | null };
export type ReadHealthEvent = { type: "pending" | "reachable" | "failed" | "settled"; error?: unknown };
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
  const listeners = new Set<() => void>();
  const publish = (next: ReadHealth) => {
    if (Object.keys(next).every(key => next[key as keyof ReadHealth] === value[key as keyof ReadHealth])) return;
    value = next; listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset() { publish(emptyReadHealth()); },
    observe(event: ReadHealthEvent) {
      if (event.type === "pending") publish({ ...value, pending: true });
      else if (event.type === "settled") publish({ ...value, pending: false });
      else if (event.type === "failed" && isReadTransportFailure(event.error))
        publish({ ...value, failures: value.failures + 1, failingSince: value.failingSince ?? now() });
      else publish({ ...value, failures: 0, failingSince: null, reachableAt: now() });
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

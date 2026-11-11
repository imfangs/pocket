import type { NewConversationInput } from "./NewConversationDialog";
import type { CreateLocation, TaskOperation } from "./taskOperations";
import { creationCue } from "./creationList.ts";
import { saveCreationConfirmations } from "./creationConfirmations.ts";

export const creationConfirmationWindowMs = 300000;
export type CreationArrivalDraft = { input: NewConversationInput; location?: CreateLocation; startedAt: number };

// Own the temporary full input and green-cue lifetime together. The operation
// store retains request/receipt identity independently; retiring this view is
// never evidence that an unknown creation failed or that a Query may replay.
export function createCreationArrival({
  confirmedAt = new Map<string, number>(),
  now = Date.now,
  saveConfirmed = saveCreationConfirmations,
  dismiss,
}: {
  confirmedAt?: ReadonlyMap<string, number>;
  now?: () => number;
  saveConfirmed?: (values: ReadonlyMap<string, number>) => void;
  dismiss: (requestId: string) => void;
}) {
  const drafts = new Map<string, CreationArrivalDraft>(), observedWaits = new Set<string>(), retired = new Set<string>();
  const confirmations = new Map(confirmedAt), listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => { revision++; listeners.forEach(listener => listener()); };
  const recent = (operation: TaskOperation) => {
    const confirmed = confirmations.get(operation.requestId);
    return confirmed !== undefined ? now() < confirmed + creationConfirmationWindowMs
      : drafts.has(operation.requestId) || observedWaits.has(operation.requestId) ||
        Math.abs(now() - (operation.createdAt ?? operation.thread?.createdAt ?? 0)) < creationConfirmationWindowMs;
  };
  const retire = (requestId: string) => {
    if (retired.has(requestId)) return;
    retired.add(requestId);
    drafts.delete(requestId); observedWaits.delete(requestId);
    // Keep only lightweight confirmation metadata, so reload cannot renew its
    // deadline. No local input survives any retirement path.
    dismiss(requestId);
    notify();
  };
  const expired = (operation: TaskOperation) => creationCue(operation)?.phase === "confirmed" &&
    confirmations.has(operation.requestId) && now() >= confirmations.get(operation.requestId)! + creationConfirmationWindowMs;
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => revision,
    remember(requestId: string, input: NewConversationInput, location?: CreateLocation) {
      if (retired.has(requestId)) return;
      drafts.set(requestId, { input, location, startedAt: now() });
      notify();
    },
    getDraft: (requestId: string) => drafts.get(requestId),
    recent,
    observe(operations: readonly TaskOperation[]) {
      let newlyConfirmed = false;
      for (const operation of operations) {
        if (operation.operation !== "create" || retired.has(operation.requestId)) continue;
        if (operation.status === "cancelled" || operation.status === "succeeded" && operation.initialMessage?.status === "cancelled") {
          // Explicitly stopping recovery removes its UI entry. The open form
          // owns any editable text; possible native creation/receipt identity
          // remains in the operation store, never inferred absent or replayed.
          retire(operation.requestId); continue;
        }
        const cue = creationCue(operation);
        if (cue && cue.phase !== "confirmed" && operation.createdAt !== undefined) observedWaits.add(operation.requestId);
        if (cue?.phase !== "confirmed") continue;
        if (!recent(operation)) { retire(operation.requestId); continue; }
        if (!confirmations.has(operation.requestId)) {
          confirmations.set(operation.requestId, drafts.has(operation.requestId) || observedWaits.has(operation.requestId)
            ? now() : operation.thread?.createdAt ?? operation.createdAt ?? now());
          newlyConfirmed = true;
        }
      }
      if (newlyConfirmed) { saveConfirmed(confirmations); notify(); }
      return newlyConfirmed;
    },
    nextDeadline(operations: readonly TaskOperation[]) {
      const deadlines = operations.filter(operation => !retired.has(operation.requestId) &&
        creationCue(operation)?.phase === "confirmed" && confirmations.has(operation.requestId))
        .map(operation => confirmations.get(operation.requestId)! + creationConfirmationWindowMs);
      return deadlines.length ? Math.min(...deadlines) : null;
    },
    expire(operations: readonly TaskOperation[]) {
      for (const operation of operations) if (expired(operation)) retire(operation.requestId);
    },
    retire,
  };
}

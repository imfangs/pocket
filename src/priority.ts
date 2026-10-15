import type { Thread } from "./types";

type PriorityState = Pick<Thread, "pinned" | "pinSource" | "codexPinned" | "pocketPriority">;

// Older snapshots remain readable. Their effective pin cannot reveal both
// independent facts, so only a complete new projection can authorize a write.
export function pocketPriority(thread: PriorityState): boolean {
  return typeof thread.pocketPriority === "boolean" ? thread.pocketPriority
    : thread.pinned && thread.pinSource === "pocket";
}

export function codexPinned(thread: PriorityState): boolean {
  return typeof thread.codexPinned === "boolean" ? thread.codexPinned
    : thread.pinned && thread.pinSource !== "pocket";
}

export function hasPriorityState(thread: PriorityState): boolean {
  return typeof thread.codexPinned === "boolean" && typeof thread.pocketPriority === "boolean";
}

export function priorityFields(thread: Thread) {
  return { pinned: thread.pinned, pinnedOrder: thread.pinnedOrder, pinSource: thread.pinSource,
    pinRevision: thread.pinRevision,
    ...(hasPriorityState(thread) ? { codexPinned: thread.codexPinned, pocketPriority: thread.pocketPriority } : {}) };
}

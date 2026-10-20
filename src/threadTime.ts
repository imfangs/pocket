import type { Thread } from "./types";

// Source updates also include settings/read events; they cannot stand in for
// a message. Old or unavailable catalogs show an unknown time until refreshed.
export function lastMessageTime(thread: Pick<Thread, "lastMessageAt">): number | null {
  const value = thread.lastMessageAt;
  return typeof value === "number" && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : null;
}

// A temporary visual cue follows the original creation time, never a visit,
// catalog refresh, new message or recovered Pocket creation receipt.
export function recentCreationExpiry(thread: Pick<Thread, "createdAt" | "archived" | "missing" | "separator" | "sourceExcluded">, now: number): number | null {
  const created = thread.createdAt;
  if (thread.archived || thread.missing || thread.separator || thread.sourceExcluded ||
      typeof created !== "number" || created <= 0 || !Number.isFinite(new Date(created).getTime()) ||
      created > now || now - created >= 5 * 60_000) return null;
  return created + 5 * 60_000;
}

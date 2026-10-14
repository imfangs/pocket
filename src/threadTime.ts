import type { Thread } from "./types";

// Source updates also include settings/read events; they cannot stand in for
// a message. Old or unavailable catalogs show an unknown time until refreshed.
export function lastMessageTime(thread: Pick<Thread, "lastMessageAt">): number | null {
  const value = thread.lastMessageAt;
  return typeof value === "number" && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : null;
}

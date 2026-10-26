import type { Thread } from "./types";
import type { TaskStatus } from "./taskStatuses";

// Attention and unread content are separate: an already-read question still
// needs an answer, but must not regain an unread label or enter that filter.
export function hasUnreadContent(thread: Thread, runtimeStatus?: TaskStatus): boolean {
  if (thread.sourceExcluded || thread.archived || thread.missing || thread.separator) return false;
  // A fresh running state hides unread presentation, never the stored content
  // or reading watermark. Once the run ends, the same content is judged again.
  if (runtimeStatus === "running") return false;
  if (typeof thread.pocketUnread === "boolean") return thread.pocketUnread;
  // Compatibility for older APIs without Pocket content versions.
  if (thread.hasUnreadTurn === false) return false;
  if (runtimeStatus === "waiting_input" || runtimeStatus === "waiting_approval")
    return thread.hasUnreadTurn === true;
  // Older snapshots may omit hasUnreadTurn but still confirm an ended unread
  // turn through needsInput. An explicit read flag above always wins.
  return thread.needsInput === true;
}

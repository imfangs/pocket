import type { Catalog } from "./types";
import { hasPriorityState, priorityFields } from "./priority.ts";
import { hasHiddenState, hiddenFields } from "./hiddenThreads.ts";

const version = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;

// Save/open/catalog responses may arrive after a pin or native rename. Preserve
// each newer field independently, while accepting unrelated response fields.
export function preserveNewerThreadMetadata(current: Catalog, incoming: Catalog): Catalog {
  const previous = new Map(current.threads.map(thread => [thread.id, thread]));
  let changed = false;
  const threads = incoming.threads.map(thread => {
    const known = previous.get(thread.id);
    if (!known) return thread;
    // Never attach a newer revision to an older half of the independent pair.
    // Legacy/partial payloads cannot withdraw a known complete projection.
    const stalePin = version(known.pinRevision) > version(thread.pinRevision)
      || hasPriorityState(known) && !hasPriorityState(thread);
    const staleTitle = version(known.titleRevision) > version(thread.titleRevision);
    const staleHidden = version(known.hiddenRevision) > version(thread.hiddenRevision)
      || hasHiddenState(known) && !hasHiddenState(thread);
    if (!stalePin && !staleTitle && !staleHidden) return thread;
    changed = true;
    const merged = { ...thread,
      ...(stalePin ? priorityFields(known) : {}),
      ...(staleTitle ? { title: known.title, titleRevision: known.titleRevision } : {}),
      ...(staleHidden ? hiddenFields(known) : {}),
    };
    if (stalePin && !hasPriorityState(known)) {
      delete merged.codexPinned; delete merged.pocketPriority;
    }
    return merged;
  });
  return changed ? { ...incoming, threads } : incoming;
}

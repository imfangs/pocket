import type { Catalog, Thread } from "./types";

const version = (thread: Thread) => Number.isSafeInteger(thread.pinRevision) && thread.pinRevision! >= 0 ? thread.pinRevision! : 0;

// Save/open/batch responses can arrive after a newer pin write. Preserve only
// the newer pin fields, while accepting the rest of each response normally.
export function preserveNewerPins(current: Catalog, incoming: Catalog): Catalog {
  const previous = new Map(current.threads.map(thread => [thread.id, thread]));
  let changed = false;
  const threads = incoming.threads.map(thread => {
    const known = previous.get(thread.id);
    if (!known || version(known) <= version(thread)) return thread;
    changed = true;
    return { ...thread, pinned: known.pinned, pinnedOrder: known.pinnedOrder, pinRevision: known.pinRevision, pinSource: known.pinSource };
  });
  return changed ? { ...incoming, threads } : incoming;
}

import type { Catalog, Thread } from "./types";

const version = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;

// Save/open/catalog responses may arrive after a pin or native rename. Preserve
// each newer field independently, while accepting unrelated response fields.
export function preserveNewerThreadMetadata(current: Catalog, incoming: Catalog): Catalog {
  const previous = new Map(current.threads.map(thread => [thread.id, thread]));
  let changed = false;
  const threads = incoming.threads.map(thread => {
    const known = previous.get(thread.id);
    if (!known) return thread;
    const stalePin = version(known.pinRevision) > version(thread.pinRevision);
    const staleTitle = version(known.titleRevision) > version(thread.titleRevision);
    if (!stalePin && !staleTitle) return thread;
    changed = true;
    return { ...thread,
      ...(stalePin ? { pinned: known.pinned, pinnedOrder: known.pinnedOrder, pinRevision: known.pinRevision, pinSource: known.pinSource } : {}),
      ...(staleTitle ? { title: known.title, titleRevision: known.titleRevision } : {}),
    };
  });
  return changed ? { ...incoming, threads } : incoming;
}

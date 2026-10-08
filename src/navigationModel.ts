import { filterThreads } from "./model.ts";
import type { Catalog, Group, View } from "./types";

export function navigationViewCount(catalog: Catalog, view: View, showSeparators = false) {
  return filterThreads(catalog.threads, catalog.groups, view, null, "", "", showSeparators, "updated").length;
}

export function groupAncestorIds(groups: readonly Group[], id: string) {
  const byId = new Map(groups.map(group => [group.id, group]));
  const ancestors = new Set<string>(), seen = new Set([id]);
  let parent = byId.get(id)?.parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent); ancestors.add(parent); parent = byId.get(parent)?.parentId;
  }
  return ancestors;
}

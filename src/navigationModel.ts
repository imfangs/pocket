import { filterThreads } from "./model.ts";
import type { Catalog, View } from "./types";

export function navigationViewCount(catalog: Catalog, view: View) {
  return filterThreads(catalog.threads, view, "", "", "updated").length;
}

// Retired group and arrangement views must never restore an empty dead end.
export function normalizeNavigationPrefs(value: unknown): { view: View; sort: "pinned" | "updated"; sortVersion: 2 } {
  const prefs = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const view: View = prefs.view === "unread" || prefs.view === "running" || prefs.view === "pinned"
    || prefs.view === "recent" || prefs.view === "archived" ? prefs.view : "all";
  return { view, sort: prefs.sortVersion === 2 && prefs.sort === "pinned" ? "pinned" : "updated", sortVersion: 2 };
}

import { filterThreads } from "./model.ts";
import type { Catalog, View } from "./types";

export function navigationViewCount(catalog: Catalog, view: View) {
  return filterThreads(catalog.threads, view, "", "", "updated").length;
}

// Retired group and arrangement views must never restore an empty dead end.
export function normalizeNavigationPrefs(value: unknown): { view: View; project: string; sort: "smart"; sortVersion: 3 } {
  const prefs = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const view: View = prefs.view === "unread" || prefs.view === "running" || prefs.view === "created" || prefs.view === "priority"
    || prefs.view === "codex-pinned" || prefs.view === "archived" ? prefs.view : "all";
  const project = view === "all" && prefs.sortVersion === 3 && typeof prefs.project === "string" && prefs.project.length <= 256 ? prefs.project : "";
  return { view, project, sort: "smart", sortVersion: 3 };
}

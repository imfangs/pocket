import { t as tr } from "./i18nCore.ts";
import { filterThreads } from "./model.ts";
import { codexPinned, pocketPriority } from "./priority.ts";
import { UNASSIGNED_PROJECT } from "./projectNavigation.ts";
import { pocketHidden } from "./hiddenThreads.ts";
import type { ActivityFilter, Catalog, NavigationScope, Thread, ThreadSort, View } from "./types";
import type { TaskStatus } from "./taskStatuses";

// Match each menu destination's full scope, independent of search/activity
// filters. Source failures retain the supplied catalog rather than inventing 0.
export function sidebarNavigationCounts(threads: readonly Thread[]) {
  const counts = { all: 0, priority: 0, codexPinned: 0, hidden: 0, projects: new Map<string, number>() };
  for (const thread of threads) {
    if (thread.sourceExcluded) continue;
    if (pocketHidden(thread)) { counts.hidden++; continue; }
    if (thread.archived) continue;
    counts.all++;
    if (pocketPriority(thread)) counts.priority++;
    if (codexPinned(thread)) counts.codexPinned++;
    const project = thread.projectId || UNASSIGNED_PROJECT;
    counts.projects.set(project, (counts.projects.get(project) || 0) + 1);
  }
  return counts;
}

export function navigationViewCount(catalog: Catalog, view: View) {
  return filterThreads(catalog.threads, view, "", "", "updated").length;
}

export interface NavigationPrefs {
  scope: NavigationScope;
  project: string;
  activity: ActivityFilter;
  sort: ThreadSort;
  sortVersion: 4;
  // The shortcut owns no second selection state: scope remains authoritative.
  // Keep only its return destination so toggling off also survives a reload.
  priorityReturn?: { scope: "all" | "codex-pinned"; project: string };
}
const isScope = (value: unknown): value is NavigationScope => value === "all" || value === "priority"
  || value === "codex-pinned" || value === "archived" || value === "hidden";
const collectionOnly = (scope: NavigationScope) => scope === "archived" || scope === "hidden";

// Migrate the former mutually exclusive views into independent dimensions.
// Retired groups/arrangements never restore an empty dead end. Only persisted
// scope information can be recovered; the old in-memory return view was lost
// on reload, so never invent a previous category for those snapshots.
export function normalizeNavigationPrefs(value: unknown): NavigationPrefs {
  const prefs = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const current = prefs.sortVersion === 4;
  const scope = isScope(prefs.scope) ? prefs.scope : isScope(prefs.view) ? prefs.view : "all";
  const project = scope === "all" && (current || prefs.sortVersion === 3) && typeof prefs.project === "string" && prefs.project.length <= 256 ? prefs.project : "";
  const activity = collectionOnly(scope) ? "all" : current
    ? prefs.activity === "unread" || prefs.activity === "running" ? prefs.activity : "all"
    : prefs.view === "unread" || prefs.view === "running" ? prefs.view : "all";
  const sort = current ? prefs.sort === "created" || prefs.sort === "activity" ? prefs.sort : "smart"
    : prefs.view === "created" ? "created" : "smart";
  const result: NavigationPrefs = { scope, project, activity, sort, sortVersion: 4 };
  const back = prefs.priorityReturn;
  if (current && scope === "priority" && back && typeof back === "object") {
    const target = back as Record<string, unknown>;
    if ((target.scope === "all" || target.scope === "codex-pinned") && typeof target.project === "string" && target.project.length <= 256)
      result.priorityReturn = { scope: target.scope, project: target.scope === "all" ? target.project : "" };
  }
  return result;
}

export type NavigationChange = { type: "scope"; scope: NavigationScope }
  | { type: "project"; project: string }
  | { type: "activity"; activity: Exclude<ActivityFilter, "all"> }
  | { type: "sort"; sort?: Exclude<ThreadSort, "smart"> }
  | { type: "togglePriority" }
  | { type: "clearActivity" };

export function changeNavigation(current: NavigationPrefs, change: NavigationChange): NavigationPrefs {
  const { priorityReturn, ...base } = current;
  // Explicit menu navigation replaces any earlier shortcut return target.
  if (change.type === "scope") return { ...base, scope: change.scope, project: "",
    activity: collectionOnly(change.scope) ? "all" : current.activity };
  if (change.type === "project") return { ...base, scope: "all", project: change.project };
  if (change.type === "togglePriority") {
    if (collectionOnly(current.scope)) return current;
    if (current.scope === "priority") return { ...base, ...(priorityReturn || { scope: "all", project: "" }) };
    return { ...base, scope: "priority", project: "", priorityReturn: { scope: current.scope, project: current.project } };
  }
  if (change.type === "sort") {
    const sort = change.sort ?? "created";
    return { ...current, sort: current.sort === sort ? "smart" : sort };
  }
  if (change.type === "clearActivity") return { ...current, activity: "all" };
  if (collectionOnly(current.scope)) return current;
  return { ...current, activity: current.activity === change.activity ? "all" : change.activity };
}

export function navigationTitle(navigation: Pick<NavigationPrefs, "scope" | "project">, projects: Catalog["projects"]): string {
  if (navigation.scope === "all" && navigation.project) return navigation.project === UNASSIGNED_PROJECT
    ? tr("未归属项目") : projects.find(project => project.id === navigation.project)?.name || tr("项目");
  return tr({ all: "全部", priority: "关注", "codex-pinned": "置顶", archived: "已归档", hidden: "隐藏" }[navigation.scope]);
}

// Both chips describe the result of selecting that activity within the current
// category/project and search, regardless of which activity is selected now.
export function navigationActivityCounts(threads: readonly Thread[], navigation: NavigationPrefs, query: string,
  runtimeStates?: ReadonlyMap<string, TaskStatus>) {
  if (collectionOnly(navigation.scope)) return { unread: 0, running: 0 };
  const count = (activity: ActivityFilter) => filterThreads(threads, navigation.scope, query, navigation.project,
    "updated", runtimeStates, undefined, activity).length;
  return { unread: count("unread"), running: count("running") };
}

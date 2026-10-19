import { filterThreads } from "./model.ts";
import { codexPinned, pocketPriority } from "./priority.ts";
import { UNASSIGNED_PROJECT } from "./projectNavigation.ts";
import type { ActivityFilter, Catalog, NavigationScope, Thread, ThreadSort, View } from "./types";
import type { TaskStatus } from "./taskStatuses";

// Match each menu destination's full scope, independent of search/activity
// filters. Source failures retain the supplied catalog rather than inventing 0.
export function sidebarNavigationCounts(threads: readonly Thread[]) {
  const counts = { all: 0, priority: 0, codexPinned: 0, projects: new Map<string, number>() };
  for (const thread of threads) {
    if (thread.sourceExcluded || thread.archived) continue;
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
}
const isScope = (value: unknown): value is NavigationScope => value === "all" || value === "priority"
  || value === "codex-pinned" || value === "archived";

// Migrate the former mutually exclusive views into independent dimensions.
// Retired groups/arrangements never restore an empty dead end. Only persisted
// scope information can be recovered; the old in-memory return view was lost
// on reload, so never invent a previous category for those snapshots.
export function normalizeNavigationPrefs(value: unknown): NavigationPrefs {
  const prefs = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const current = prefs.sortVersion === 4;
  const scope = isScope(prefs.scope) ? prefs.scope : isScope(prefs.view) ? prefs.view : "all";
  const project = scope === "all" && (current || prefs.sortVersion === 3) && typeof prefs.project === "string" && prefs.project.length <= 256 ? prefs.project : "";
  const activity = scope === "archived" ? "all" : current
    ? prefs.activity === "unread" || prefs.activity === "running" ? prefs.activity : "all"
    : prefs.view === "unread" || prefs.view === "running" ? prefs.view : "all";
  const sort = (current ? prefs.sort === "created" : prefs.view === "created") ? "created" : "smart";
  return { scope, project, activity, sort, sortVersion: 4 };
}

export type NavigationChange = { type: "scope"; scope: NavigationScope }
  | { type: "project"; project: string }
  | { type: "activity"; activity: Exclude<ActivityFilter, "all"> }
  | { type: "sort" }
  | { type: "clearActivity" };

export function changeNavigation(current: NavigationPrefs, change: NavigationChange): NavigationPrefs {
  if (change.type === "scope") return { ...current, scope: change.scope, project: "",
    activity: change.scope === "archived" ? "all" : current.activity };
  if (change.type === "project") return { ...current, scope: "all", project: change.project };
  if (change.type === "sort") return { ...current, sort: current.sort === "created" ? "smart" : "created" };
  if (change.type === "clearActivity") return { ...current, activity: "all" };
  if (current.scope === "archived") return current;
  return { ...current, activity: current.activity === change.activity ? "all" : change.activity };
}

export function navigationTitle(navigation: Pick<NavigationPrefs, "scope" | "project">, projects: Catalog["projects"]): string {
  if (navigation.scope === "all" && navigation.project) return navigation.project === UNASSIGNED_PROJECT
    ? "未归属项目" : projects.find(project => project.id === navigation.project)?.name || "项目";
  return { all: "全部", priority: "关注", "codex-pinned": "置顶", archived: "已归档" }[navigation.scope];
}

// Both chips describe the result of selecting that activity within the current
// category/project and search, regardless of which activity is selected now.
export function navigationActivityCounts(threads: readonly Thread[], navigation: NavigationPrefs, query: string,
  runtimeStates?: ReadonlyMap<string, TaskStatus>) {
  if (navigation.scope === "archived") return { unread: 0, running: 0 };
  const count = (activity: ActivityFilter) => filterThreads(threads, navigation.scope, query, navigation.project,
    "updated", runtimeStates, undefined, activity).length;
  return { unread: count("unread"), running: count("running") };
}

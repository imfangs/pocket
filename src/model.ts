import { t as tr, currentLocale } from "./i18nCore.ts";
import type { ActivityFilter, Catalog, Thread, View } from "./types";
import type { TaskStatus } from "./taskStatuses";
import { smartThreadOrder, type SmartOrderOptions } from "./smartOrder.ts";
import { UNASSIGNED_PROJECT } from "./projectNavigation.ts";
import { lastMessageTime } from "./threadTime.ts";
import { codexPinned, pocketPriority } from "./priority.ts";
import { hasUnreadContent } from "./unread.ts";
import { pocketHidden } from "./hiddenThreads.ts";

function creationTime(thread: Thread): number {
  const value = thread.createdAt;
  return typeof value === "number" && value > 0 && Number.isFinite(new Date(value).getTime()) ? value : 0;
}

export function filterThreads(
  threads: readonly Thread[],
  view: View,
  query: string,
  project: string,
  sort: string,
  runtimeStates?: ReadonlyMap<string, TaskStatus>,
  ranking?: Pick<SmartOrderOptions, "now" | "draftIds" | "pocketActivity">,
  activity: ActivityFilter = view === "unread" || view === "running" ? view : "all",
) {
  const terms = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const filtered = threads
    .filter((t) => {
      if (t.sourceExcluded) return false;
      if (view === "hidden" ? !pocketHidden(t) : pocketHidden(t)) return false;
      if (view === "archived" && !t.archived) return false;
      if (view !== "archived" && view !== "hidden" && t.archived)
        return false;
      if (activity === "unread" && !hasUnreadContent(t, runtimeStates?.get(t.id))) return false;
      if (activity === "running" && (t.missing || t.separator || runtimeStates?.get(t.id) !== "running")) return false;
      if (project === UNASSIGNED_PROJECT ? !!t.projectId : project && t.projectId !== project) return false;
      if (view === "priority" && !pocketPriority(t)) return false;
      if (view === "codex-pinned" && !codexPinned(t)) return false;
      if (view === "pinned" && !pocketPriority(t) && !codexPinned(t)) return false;
      if (view === "recent" && !t.lastOpenedAt) return false;
      if (!terms.length) return true;
      const hay = [
        t.title,
        t.cwd,
        t.projectName,
      ]
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase();
      return terms.every((q) => hay.includes(q));
    });
  if (sort === "created" || view === "created") return filtered.sort((a, b) => creationTime(b) - creationTime(a) || a.id.localeCompare(b.id));
  if (sort === "smart" && view !== "archived" && view !== "hidden") return smartThreadOrder(filtered, { now: ranking?.now ?? Date.now(), draftIds: ranking?.draftIds, pocketActivity: ranking?.pocketActivity, runtimeStates });
  if (sort === "activity" || sort === "smart") return filtered.sort((a, b) => (lastMessageTime(b) ?? 0) - (lastMessageTime(a) ?? 0)
    || creationTime(b) - creationTime(a) || a.id.localeCompare(b.id));
  return filtered.sort((a, b) => {
      if (sort === "pinned" && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sort === "pinned" && a.pinned && b.pinned)
        return a.pinnedOrder - b.pinnedOrder || b.updatedAt - a.updatedAt;
      return b.updatedAt - a.updatedAt;
    });
}

// A successful scope refresh may remove a row being read or holding a draft.
// Keep those detail references; lists still reject their exclusion flags.
// Explicit exclusions also prevent a late lifecycle receipt reviving a row.
export function preserveOpenThread(current: Catalog, incoming: Catalog, selected: string | null,
  retainedIds: ReadonlySet<string> = new Set()): Catalog {
  const validIds = (value: unknown): value is string[] => Array.isArray(value)
    && value.every(id => typeof id === "string" && id.length > 0)
    && new Set(value).size === value.length;
  const validStates = (value: unknown, ids: string[] | undefined): value is { id: string; archived: boolean }[] =>
    !!ids && Array.isArray(value) && value.length === ids.length
    && value.every(state => state && typeof state === "object" && !Array.isArray(state)
      && Object.keys(state).every(key => key === "id" || key === "archived")
      && ids.includes(state.id) && typeof state.archived === "boolean")
    && new Set(value.map(state => state.id)).size === value.length;
  // An old/invalid response cannot withdraw the last explicit scope snapshot.
  // A new valid empty list can, so returning threads regain their normal row.
  const excludedThreadIds = validIds(incoming.excludedThreadIds) ? incoming.excludedThreadIds
    : validIds(current.excludedThreadIds) ? current.excludedThreadIds : undefined;
  const excludedThreadStates = validIds(incoming.excludedThreadIds)
    && validStates(incoming.excludedThreadStates, incoming.excludedThreadIds) ? incoming.excludedThreadStates
    : validIds(current.excludedThreadIds) && validStates(current.excludedThreadStates, current.excludedThreadIds)
      && validStates(current.excludedThreadStates, excludedThreadIds) ? current.excludedThreadStates : undefined;
  const excluded = new Set(excludedThreadIds || []);
  const archivedStates = new Map((excludedThreadStates || []).map(state => [state.id, state.archived]));
  const retained = (id: string) => id === selected || retainedIds.has(id);
  let changed = excludedThreadIds !== incoming.excludedThreadIds || excludedThreadStates !== incoming.excludedThreadStates;
  const threads: Thread[] = [];
  for (const thread of incoming.threads) {
    const sourceExcluded = thread.sourceExcluded || excluded.has(thread.id);
    if (sourceExcluded && !retained(thread.id)) {
      changed = true;
      continue;
    }
    const archived = archivedStates.get(thread.id);
    if (sourceExcluded && (!thread.sourceExcluded || archived !== undefined && archived !== thread.archived)) {
      threads.push({ ...thread, sourceExcluded: true, ...(archived !== undefined ? { archived } : {}) });
      changed = true;
    } else threads.push(thread);
  }
  const present = new Set(threads.map(thread => thread.id));
  for (const previous of current.threads) {
    if (!retained(previous.id) || present.has(previous.id)) continue;
    const archived = archivedStates.get(previous.id);
    const detail = incoming.sourceError ? previous : { ...previous, sourceExcluded: true };
    threads.push(archived !== undefined && archived !== detail.archived ? { ...detail, archived } : detail);
    present.add(previous.id);
    changed = true;
  }
  return changed ? { ...incoming, threads, excludedThreadIds, excludedThreadStates } : incoming;
}

export function ago(ms: number) {
  const d = Math.max(0, Date.now() - ms);
  if (d < 60000) return tr("刚刚");
  if (d < 3600000) return tr("{{count}} 分钟前", { count: Math.floor(d / 60000) });
  if (d < 86400000) return tr("{{count}} 小时前", { count: Math.floor(d / 3600000) });
  if (d < 7 * 86400000) return tr("{{count}} 天前", { count: Math.floor(d / 86400000) });
  return new Date(ms).toLocaleDateString(currentLocale(), {
    month: "short",
    day: "numeric",
  });
}

import type { Group, Thread, View } from "./types";
export function descendantIds(groups: Group[], id: string): Set<string> {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of groups)
      if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id);
        changed = true;
      }
  }
  return ids;
}
export function groupPath(groups: Group[], id: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = groups.find((g) => g.id === id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = groups.find((g) => g.id === current?.parentId);
  }
  return parts.join(" / ");
}
export function filterThreads(
  threads: Thread[],
  groups: Group[],
  view: View,
  groupId: string | null,
  query: string,
  project: string,
  showSeparators: boolean,
  sort: string,
) {
  const ids = groupId ? descendantIds(groups, groupId) : new Set<string>();
  const terms = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const groupPaths = new Map<string, string>();
  const searchableGroupPath = (id: string) => {
    if (!groupPaths.has(id)) groupPaths.set(id, groupPath(groups, id));
    return groupPaths.get(id)!;
  };
  return threads
    .filter((t) => {
      if (!showSeparators && t.separator) return false;
      if (view === "archived" && !t.archived) return false;
      if (view !== "archived" && t.archived)
        return false;
      if (view === "unread" && (!t.needsInput || t.missing || t.separator)) return false;
      if (project && t.projectId !== project) return false;
      if (view === "pinned" && !t.pinned) return false;
      if (view === "recent" && !t.lastOpenedAt) return false;
      if (["active", "later", "reference"].includes(view) && t.intent !== view)
        return false;
      if (view === "unassigned" && t.groupIds.length) return false;
      if (view === "group" && !t.groupIds.some((g) => ids.has(g))) return false;
      if (!terms.length) return true;
      const hay = [
        t.title,
        t.note,
        t.cwd,
        t.projectName,
        ...t.groupIds.map(searchableGroupPath),
      ]
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase();
      return terms.every((q) => hay.includes(q));
    })
    .sort((a, b) => {
      if (sort === "pinned" && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sort === "pinned" && a.pinned && b.pinned)
        return a.pinnedOrder - b.pinnedOrder || b.updatedAt - a.updatedAt;
      return b.updatedAt - a.updatedAt;
    });
}
export function ago(ms: number) {
  const d = Math.max(0, Date.now() - ms);
  if (d < 60000) return "刚刚";
  if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
  if (d < 7 * 86400000) return `${Math.floor(d / 86400000)} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
}
export const today = () => new Date().toLocaleDateString("en-CA");

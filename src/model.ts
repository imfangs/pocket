import type { Thread, View } from "./types";
import type { TaskStatus } from "./taskStatuses";
export function filterThreads(
  threads: Thread[],
  view: View,
  query: string,
  project: string,
  sort: string,
  runtimeStates?: ReadonlyMap<string, TaskStatus>,
) {
  const terms = query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return threads
    .filter((t) => {
      if (view === "archived" && !t.archived) return false;
      if (view !== "archived" && t.archived)
        return false;
      if (view === "unread" && (!t.needsInput || t.missing || t.separator)) return false;
      if (view === "running" && (t.missing || t.separator || runtimeStates?.get(t.id) !== "running")) return false;
      if (project && t.projectId !== project) return false;
      if (view === "pinned" && !t.pinned) return false;
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

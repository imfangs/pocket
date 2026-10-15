import type { Project, Thread } from "./types";

export const UNASSIGNED_PROJECT = "__unassigned__";

export interface ProjectNavigationItem {
  id: string;
  name: string;
  title: string;
  ariaLabel: string;
  suffix?: string;
}

function distinctSuffix(project: Project, peers: readonly Project[]) {
  const parts = (item: Project) => (item.paths.find(Boolean) || "").replaceAll("\\", "/").split("/").filter(Boolean);
  const own = parts(project);
  for (let length = 1; length <= own.length; length++) {
    const tail = own.slice(-length).join("/");
    if (peers.every(other => other.id === project.id || parts(other).slice(-length).join("/") !== tail)) return tail;
  }
  // Shared/missing directories still represent different native projects.
  // A short identity suffix is the last resort, never a reason to merge them.
  for (let length = Math.min(4, project.id.length); length <= project.id.length; length++) {
    const tail = project.id.slice(-length);
    if (peers.every(other => other.id === project.id || other.id.slice(-length) !== tail)) return `ID ${tail}`;
  }
  return `ID ${project.id}`;
}

// Project identity comes from Codex, never from a shared name or directory.
export function projectNavigationItems(
  projects: readonly Project[],
  threads: readonly Pick<Thread, "archived" | "separator" | "projectId" | "sourceExcluded">[] = [],
): ProjectNavigationItem[] {
  const seen = new Set<string>();
  const ordered = projects
    .filter(project => {
      if (project.separator || !project.id || seen.has(project.id)) return false;
      seen.add(project.id);
      return true;
    })
    .map((project, index) => ({ project, index }))
    .sort((a, b) => {
      const aOrder = Number.isFinite(a.project.order) ? a.project.order : Number.MAX_SAFE_INTEGER;
      const bOrder = Number.isFinite(b.project.order) ? b.project.order : Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || a.index - b.index;
    })
    .map(({ project }) => ({
      ...project,
      name: project.name.trim() || project.id,
      location: project.paths.filter(Boolean).join("、"),
    }));
  const nameKey = (name: string) => name.normalize("NFKC").toLocaleLowerCase();
  const names = new Map<string, number>();
  for (const project of ordered) {
    const key = nameKey(project.name);
    names.set(key, (names.get(key) || 0) + 1);
  }
  const items = ordered.map(project => {
    const duplicate = (names.get(nameKey(project.name)) || 0) > 1;
    const sameLocation = duplicate && ordered.some(other => other.id !== project.id
      && nameKey(other.name) === nameKey(project.name) && other.location === project.location);
    const detail = [project.location, duplicate && (!project.location || sameLocation) ? project.id : ""].filter(Boolean).join(" · ");
    return {
      id: project.id,
      name: project.name,
      title: detail ? `${project.name}\n${detail}` : project.name,
      ariaLabel: duplicate && detail ? `${project.name}，${detail}` : project.name,
      ...(duplicate ? { suffix: distinctSuffix(project, ordered.filter(other => nameKey(other.name) === nameKey(project.name))) } : {}),
    };
  });
  if (threads.some(thread => !thread.sourceExcluded && !thread.archived && !thread.separator && !thread.projectId)) {
    items.push({ id: UNASSIGNED_PROJECT, name: "未归属项目", title: "未归属项目", ariaLabel: "未归属项目" });
  }
  return items;
}

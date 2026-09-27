export type Intent = "none" | "active" | "later" | "reference";
export interface Group {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  position: number;
  sourceProjectId: string | null;
}
export interface Project {
  id: string;
  name: string;
  paths: string[];
  order: number;
  separator: boolean;
}
export interface Thread {
  id: string;
  hostId: string;
  title: string;
  cwd: string;
  projectId: string | null;
  projectName: string;
  archived: boolean;
  pinned: boolean;
  pinnedOrder: number;
  separator: boolean;
  source: string;
  createdAt: number;
  updatedAt: number;
  branch: string | null;
  missing: boolean;
  intent: Intent;
  note: string;
  reviewAt: string | null;
  groupIds: string[];
  lastOpenedAt: number | null;
  revision: number;
}
export interface Catalog {
  threads: Thread[];
  groups: Group[];
  projects: Project[];
  sourceInfo: {
    syncedAt: number;
    active: number;
    archived: number;
    total: number;
    scope: string;
  } | null;
  sourceError: string | null;
  csrfToken?: string;
}
export type View =
  | "all"
  | "pinned"
  | "active"
  | "later"
  | "reference"
  | "recent"
  | "archived"
  | "unassigned"
  | "group";
export const intentLabels: Record<Intent, string> = {
  none: "未标记",
  active: "正在推进",
  later: "稍后继续",
  reference: "留作参考",
};

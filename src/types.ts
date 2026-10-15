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
  titleRevision?: number;
  cwd: string;
  projectId: string | null;
  projectName: string;
  archived: boolean;
  pinned: boolean;
  pinnedOrder: number;
  pinRevision?: number;
  pinSource?: "pocket" | "codex";
  codexPinned?: boolean;
  pocketPriority?: boolean;
  separator: boolean;
  source: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt?: number | null;
  branch: string | null;
  missing: boolean;
  sourceExcluded?: boolean;
  intent: Intent;
  note: string;
  reviewAt: string | null;
  groupIds: string[];
  lastOpenedAt: number | null;
  revision: number;
  hasUnreadTurn?: boolean | null;
  needsInput?: boolean;
}
export interface Catalog {
  threads: Thread[];
  excludedThreadIds?: string[];
  excludedThreadStates?: { id: string; archived: boolean }[];
  groups: Group[];
  projects: Project[];
  sourceInfo: {
    syncedAt: number;
    active: number;
    archived: number;
    total: number;
    scope: string;
    unread?: { available: boolean; source: string; pending: number };
  } | null;
  sourceError: string | null;
  csrfToken?: string;
}
export type View = "all" | "unread" | "running" | "pinned" | "recent" | "archived";

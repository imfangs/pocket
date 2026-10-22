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
export interface ThreadAutomationSummary {
  count: number;
  activeCount: number;
  pausedCount: number;
  stale?: boolean;
}
export interface ThreadAutomation {
  id: string;
  name: string;
  prompt: string;
  status: "ACTIVE" | "PAUSED" | "UNKNOWN";
  scheduleLabel: string;
  scheduleSupported: boolean;
  createdAt?: number;
  updatedAt?: number;
}
export interface ThreadAutomationsSource {
  available: boolean;
  stale: boolean;
  timeZone: string;
  automations: ThreadAutomation[];
}
export interface PocketContent {
  scope: string;
  revision: number;
  version: string;
  messageId: string | null;
  known: true;
}
export interface Thread {
  pocketContent?: PocketContent | null;
  // A desktop read hint bound to the content version actually observed there.
  desktopReadContent?: PocketContent | null;
  // Derived by this Pocket client; never replaces the original native flag.
  pocketUnread?: boolean;
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
  savedModelSettings?: { model: string | null; effort: string | null };
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
  automationSummary?: ThreadAutomationSummary;
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
    pocketRead?: { available: boolean; scope: string };
  } | null;
  sourceError: string | null;
  csrfToken?: string;
}
export type View = "all" | "unread" | "running" | "created" | "priority" | "codex-pinned" | "pinned" | "recent" | "archived";
export type NavigationScope = "all" | "priority" | "codex-pinned" | "archived";
export type ActivityFilter = "all" | "unread" | "running";
export type ThreadSort = "smart" | "created" | "activity";

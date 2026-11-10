import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { currentMachineId, machineTaskUrl, type MachineId } from "./machineScope";
import { navigateTaskReference } from "./taskReferenceNavigation";
import type { TaskStatus } from "./taskStatuses";
import type { Thread } from "./types";
import "./message-task-card.css";

type References = { machine: MachineId | null; scope?: string; threads: ReadonlyMap<string, Thread>; states?: ReadonlyMap<string, TaskStatus> };
const TaskReferences = createContext<References>({ machine: null, threads: new Map() });

export function TaskReferencesProvider({ machine, scope, threads, excluded, states, children }: {
  machine: MachineId | null; scope?: string; threads: readonly Thread[]; excluded?: readonly string[];
  states?: ReadonlyMap<string, TaskStatus>; children: ReactNode;
}) {
  const value = useMemo<References>(() => {
    const blocked = new Set(excluded);
    return { machine, scope, states, threads: new Map(machine && scope && scope !== "unknown" ? threads.filter(thread =>
      !thread.separator && !thread.sourceExcluded && !blocked.has(thread.id)).map(thread => [thread.id, thread]) : []) };
  }, [machine, scope, threads, excluded, states]);
  return <TaskReferences.Provider value={value}>{children}</TaskReferences.Provider>;
}

export default function MessageTaskCard({ threadId }: { threadId: string }) {
  useLocale();
  const references = useContext(TaskReferences);
  const machine = currentMachineId();
  const thread = references.machine === machine && references.scope ? references.threads.get(threadId) : undefined;
  const status = thread && references.states?.get(threadId);
  const title = thread?.title?.trim() || t("打开会话");
  const location = thread?.projectName?.trim() || thread?.cwd?.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  const label = thread?.missing ? "会话不可用" : thread?.archived ? "已归档" : status === "running" ? "运行中"
    : status === "waiting_input" ? "等待回答" : status === "waiting_approval" ? "等待确认" : null;
  const body = <><span className="message-task-card-icon"><AppIcon icon={MessageSquare} kind="action" /></span>
    <span className="message-task-card-content"><span className="message-task-card-title">{title}</span>
      <span className="message-task-card-details">{location || t("会话详情暂未同步")}
        {label && <span className="message-task-card-status" data-state={status || undefined}>{t(label)}</span>}
      </span></span><AppIcon icon={ArrowUpRight} kind="auxiliary" className="message-task-card-arrow" /></>;
  if (!machine) return <div className="message-task-card" data-unavailable="">{body}</div>;
  const url = machineTaskUrl(threadId, machine);
  return <a className="message-task-card" href={url} title={title} aria-label={t("打开会话：{{title}}", { title })}
    onClick={event => navigateTaskReference(event, url)}>{body}</a>;
}

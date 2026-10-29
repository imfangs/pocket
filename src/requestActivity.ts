import type { MachineId } from "./machineScope";

type ActivityInput = { machine: MachineId; path: string; method: string; body?: unknown };
type RequestScope = { kind: "list" } | { kind: "directory" } | { kind: "thread"; threadId: string };
type ActiveRequest = RequestScope & { machine: MachineId };
const idle = () => {};
const validThreadId = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 512 && !/[\/\\?#\u0000-\u0020\u007f]/.test(value);

function requestScope(path: string, method: string): RequestScope | null {
  if (typeof path !== "string" || !path.startsWith("/api/") || path.includes("#")) return null;
  try {
    const url = new URL(path, "http://pocket.invalid"), pathname = decodeURIComponent(url.pathname);
    if (url.origin !== "http://pocket.invalid" || /[\\\u0000-\u001f]/.test(pathname)) return null;
    if (/^\/api\/(?:auth|notifications|feedback)(?:\/|$)/.test(pathname) || pathname === "/api/health") return null;
    const verb = method.toUpperCase();
    if (pathname === "/api/catalog" || pathname === "/api/sync" ||
        pathname === "/api/import" && verb === "POST" || /^\/api\/groups(?:\/|$)/.test(pathname)) return { kind: "directory" };
    // priorityThreadIds is a scheduling hint, not the exact server query set.
    // Lifecycle IDs identify requests, so their receipt cannot identify a thread.
    if (pathname === "/api/task-statuses" || /^\/api\/task-operations(?:\/|$)/.test(pathname) ||
        pathname === "/api/tasks" || pathname === "/api/tasks/create-options") return { kind: "list" };
    const task = /^\/api\/tasks\/([^/]+)(?:\/(.*))?$/.exec(pathname);
    if (task && validThreadId(task[1])) {
      const suffix = task[2] ?? "";
      // Native media and file readers have their own transfer controls. JSON
      // attachment metadata and PUT uploads remain real thread data requests.
      if (/^(?:files|images)(?:\/|$)/.test(suffix) || verb === "GET" &&
          /^attachments\/[^/]+$/.test(suffix) && url.searchParams.get("metadata") !== "1") return null;
      return { kind: "thread", threadId: task[1] };
    }
    const opening = /^\/api\/open\/([^/]+)$/.exec(pathname);
    if (opening && validThreadId(opening[1])) return { kind: "thread", threadId: opening[1] };
    // Unknown business requests may affect the list, but cannot light an
    // unrelated detail. Never infer an operation's owner from its body.
    return { kind: "list" };
  } catch { return null; }
}

export function createRequestActivity() {
  const active = new Map<symbol, ActiveRequest>(), listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => {
    try { listener(); } catch { /* Observation must never interrupt a request or another subscriber. */ }
  });
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    isPending(machine: MachineId | null, threadId?: string) {
      if (!machine || threadId !== undefined && !validThreadId(threadId)) return false;
      for (const request of active.values()) if (request.machine === machine && (threadId === undefined ||
        request.kind === "directory" || request.kind === "thread" && request.threadId === threadId)) return true;
      return false;
    },
    begin({ machine, path, method }: ActivityInput) {
      const scope = requestScope(path, method);
      if (!scope || machine !== "ged" && machine !== "wandou") return idle;
      const token = Symbol();
      // Store only routing scope and an opaque token, never the path, body,
      // headers, credentials, server result, or request/receipt identity.
      active.set(token, { ...scope, machine }); notify();
      return () => { if (active.delete(token)) notify(); };
    },
    clearMachine(machine: MachineId) {
      let changed = false;
      for (const [token, request] of active) if (request.machine === machine) { active.delete(token); changed = true; }
      if (changed) notify();
    },
  };
}

export type RequestActivity = ReturnType<typeof createRequestActivity>;
export const requestActivity = createRequestActivity();

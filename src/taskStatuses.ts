export type TaskStatus = "running" | "waiting_input" | "waiting_approval" | "idle" | "unknown";
export type TaskStatusResponse = {
  available: boolean;
  checkedAt: number;
  states: { threadId: string; status: TaskStatus; checkedAt: number }[];
};
export type TaskStatusesView = {
  runtimeStates: ReadonlyMap<string, TaskStatus>;
  runtimeUnavailable: boolean;
  runtimeLoading: boolean;
};

const statuses = new Set<TaskStatus>(["running", "waiting_input", "waiting_approval", "idle", "unknown"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function taskStatusMap(value: unknown): ReadonlyMap<string, TaskStatus> | null {
  if (!record(value) || value.available !== true || !timestamp(value.checkedAt) || !Array.isArray(value.states)) return null;
  const result = new Map<string, TaskStatus>();
  for (const item of value.states) {
    if (!record(item) || typeof item.threadId !== "string" || !item.threadId || !timestamp(item.checkedAt) ||
        !statuses.has(item.status as TaskStatus) || result.has(item.threadId)) return null;
    result.set(item.threadId, item.status as TaskStatus);
  }
  return result;
}

export function initialTaskStatuses(): TaskStatusesView {
  return { runtimeStates: new Map(), runtimeUnavailable: false, runtimeLoading: true };
}

type Options = {
  request: (signal: AbortSignal) => Promise<unknown>;
  onChange: (view: TaskStatusesView) => void;
  browser?: Window;
  visibility?: Document;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
  ttlMs?: number;
};
type PendingRead = { controller: AbortController; startedAt: number; promise?: Promise<void>; deadline?: number };

// One collection request serves the whole list. This observer has no access to
// catalog, draft, sort, or execution actions, and never infers idle from absence.
export function startTaskStatusPolling(options: Options) {
  const browser = options.browser ?? window, visibility = options.visibility ?? document;
  const now = options.now ?? (() => performance.now());
  const pollMs = options.pollMs ?? 10000, timeoutMs = options.timeoutMs ?? 18000, ttlMs = options.ttlMs ?? 30000;
  let stopped = false, receivedAt: number | null = null, refreshAfterPending = false;
  let pollTimer: number | undefined, expiryTimer: number | undefined;
  let pending: PendingRead | null = null;
  const ready = () => !stopped && visibility.visibilityState === "visible" && browser.navigator.onLine !== false;
  const clearPoll = () => { browser.clearTimeout(pollTimer); pollTimer = undefined; };
  const clearExpiry = () => { browser.clearTimeout(expiryTimer); expiryTimer = undefined; };
  const unavailable = () => {
    receivedAt = null; clearExpiry();
    if (!stopped) options.onChange({ runtimeStates: new Map(), runtimeUnavailable: true, runtimeLoading: false });
  };
  const expire = () => {
    if (stopped || receivedAt === null) return;
    const remaining = ttlMs - (now() - receivedAt);
    if (remaining <= 0) unavailable();
    else expiryTimer = browser.setTimeout(expire, remaining);
  };
  const refresh = (): Promise<void> => {
    if (!ready()) return Promise.resolve();
    if (receivedAt !== null && now() - receivedAt >= ttlMs) unavailable();
    if (pending) {
      if (pending.controller.signal.aborted) refreshAfterPending = true;
      return pending.promise ?? Promise.resolve();
    }
    clearPoll();
    const operation: PendingRead = { controller: new AbortController(), startedAt: now() };
    pending = operation;
    operation.deadline = browser.setTimeout(() => {
      if (pending !== operation || stopped) return;
      unavailable();
      operation.controller.abort(new DOMException("读取运行状态超时", "TimeoutError"));
    }, timeoutMs);
    operation.promise = Promise.resolve().then(async () => {
      try {
        if (operation.controller.signal.aborted) return;
        const response = await options.request(operation.controller.signal);
        if (!ready() || pending !== operation || operation.controller.signal.aborted) return;
        // A response queued across a suspended tab cannot renew an old green
        // badge just because its timeout callback has not run yet.
        if (now() - operation.startedAt >= timeoutMs) { unavailable(); return; }
        const states = taskStatusMap(response);
        if (!states) { unavailable(); return; }
        receivedAt = now();
        clearExpiry();
        expiryTimer = browser.setTimeout(expire, ttlMs);
        options.onChange({ runtimeStates: states, runtimeUnavailable: false, runtimeLoading: false });
      } catch {
        if (!stopped && pending === operation && !operation.controller.signal.aborted) unavailable();
      } finally {
        browser.clearTimeout(operation.deadline);
        if (pending === operation) pending = null;
        if (ready()) pollTimer = browser.setTimeout(() => { void refresh(); }, refreshAfterPending ? 0 : pollMs);
        refreshAfterPending = false;
      }
    });
    return operation.promise;
  };
  const resume = () => {
    clearPoll();
    if (!ready()) {
      unavailable();
      pending?.controller.abort();
      return;
    }
    if (receivedAt === null) options.onChange(initialTaskStatuses());
    void refresh();
  };
  visibility.addEventListener("visibilitychange", resume);
  browser.addEventListener("online", resume);
  browser.addEventListener("offline", resume);
  browser.addEventListener("pageshow", resume);
  resume();
  return {
    refresh,
    stop() {
      stopped = true;
      clearPoll(); clearExpiry();
      browser.clearTimeout(pending?.deadline);
      pending?.controller.abort();
      visibility.removeEventListener("visibilitychange", resume);
      browser.removeEventListener("online", resume);
      browser.removeEventListener("offline", resume);
      browser.removeEventListener("pageshow", resume);
    },
  };
}

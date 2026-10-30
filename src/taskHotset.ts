import type { PocketActivity } from "./smartOrder.ts";
import type { Thread } from "./types.ts";
import { taskStatusMap, type TaskStatus, type TaskStatusResponse } from "./taskStatuses.ts";
import { prioritizedReadThreads } from "./prefetchPriority.ts";
import { hasUnreadContent } from "./unread.ts";
import { codexPinned, pocketPriority } from "./priority.ts";

export const taskHotsetLimit = 32;
export const taskHotsetLifetimeMs = 30 * 60 * 1000;
const statusLifetimeMs = 30000;
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
const active = new Set(["running", "waiting_input", "waiting_approval"]);
export type TaskHotsetContext = {
  threads: readonly Thread[];
  activity: ReadonlyMap<string, PocketActivity>;
  selectedId: string | null;
  excludedThreadIds?: readonly string[];
  draftIds?: ReadonlySet<string>;
  runtimeStates?: ReadonlyMap<string, TaskStatus> | null;
};
type Interest = { createdAt?: number; visitedAt?: number; activeAt?: number };
const latest = (entry: Interest) => Math.max(entry.createdAt ?? 0, entry.visitedAt ?? 0, entry.activeAt ?? 0);

// One private, in-memory tracker per mounted App/machine. Interest is only a
// read-order hint: it never changes click history, ranking, or execution state.
export function createTaskHotset(now: () => number = Date.now) {
  let entries = new Map<string, Interest>(), eligible = new Set<string>(), selectedId: string | null = null;
  let threads = new Map<string, Thread>(), activity: ReadonlyMap<string, PocketActivity> = new Map();
  let draftIds: ReadonlySet<string> | undefined, runtimeContext: TaskHotsetContext["runtimeStates"];
  let observedRuntime = new Map<string, TaskStatus>(), observedRuntimeAt = -Infinity;
  let lastObservationAt = -Infinity;
  const recent = (value: unknown, at: number): value is number => typeof value === "number" && Number.isFinite(value)
    && value > 0 && value <= at && at - value < taskHotsetLifetimeMs;
  const runtime = (at: number) => runtimeContext === undefined
    ? at >= observedRuntimeAt && at - observedRuntimeAt < statusLifetimeMs ? observedRuntime : undefined : runtimeContext ?? undefined;
  const ranked = (at: number) => {
    const states = runtime(at);
    const candidates = [...threads.values()].filter(thread => thread.id === selectedId || entries.has(thread.id)
      || hasUnreadContent(thread, states?.get(thread.id)) || pocketPriority(thread) || codexPinned(thread));
    return prioritizedReadThreads(candidates, { now: at, selectedId, runtimeStates: states, draftIds, pocketActivity: activity }, taskHotsetLimit);
  };
  const trim = (at: number) => {
    entries = new Map([...entries].filter(([id, entry]) => eligible.has(id) && (id === selectedId || recent(latest(entry), at))));
    const retained = new Set(ranked(at).map(thread => thread.id));
    entries = new Map([...entries].filter(([id]) => retained.has(id)));
  };
  const remember = (id: string, next: Interest) => {
    const previous = entries.get(id) ?? {};
    entries.set(id, {
      createdAt: next.createdAt === undefined ? previous.createdAt : previous.createdAt === undefined
        ? next.createdAt : Math.min(previous.createdAt, next.createdAt),
      visitedAt: Math.max(previous.visitedAt ?? 0, next.visitedAt ?? 0),
      activeAt: Math.max(previous.activeAt ?? 0, next.activeAt ?? 0),
    });
  };
  return {
    update(context: TaskHotsetContext) {
      const at = now(), excluded = new Set(context.excludedThreadIds);
      const allowed = context.threads.filter(thread => validId(thread.id) && !excluded.has(thread.id)
        && !thread.archived && !thread.missing && !thread.separator && !thread.sourceExcluded);
      threads = new Map(allowed.map(thread => [thread.id, thread]));
      activity = context.activity; draftIds = context.draftIds; runtimeContext = context.runtimeStates;
      eligible = new Set(threads.keys());
      const nextSelected = context.selectedId && eligible.has(context.selectedId) ? context.selectedId : null;
      if (nextSelected !== selectedId) {
        // Leaving a long-open detail is also a recent view. This stays in the
        // private tracker and does not manufacture a Pocket ranking click.
        if (selectedId && eligible.has(selectedId)) remember(selectedId, { visitedAt: at });
        if (nextSelected) remember(nextSelected, { visitedAt: at });
        selectedId = nextSelected;
      }
      for (const thread of allowed) {
        const activity = context.activity.get(thread.id);
        const creationTimes = [thread.createdAt, activity?.createdAt].filter(value => typeof value === "number"
          && Number.isFinite(value) && value > 0) as number[];
        const originalCreation = creationTimes.length ? Math.min(...creationTimes) : undefined;
        const createdAt = recent(originalCreation, at) ? originalCreation : undefined;
        const visitedAt = recent(activity?.visitedAt, at) ? activity.visitedAt : undefined;
        if (createdAt !== undefined || visitedAt !== undefined) remember(thread.id, { createdAt, visitedAt });
      }
      trim(at);
    },
    // Called only for a collection accepted by the foreground polling feed.
    // A shared server-cache replay cannot renew the last observed activity.
    observe(value: unknown) {
      if (!taskStatusMap(value)) return;
      const response = value as TaskStatusResponse;
      if (response.checkedAt <= lastObservationAt || response.checkedAt <= 0) return;
      lastObservationAt = response.checkedAt;
      const at = now();
      observedRuntime = new Map(); observedRuntimeAt = at;
      for (const row of response.states) {
        if (!eligible.has(row.threadId) || row.checkedAt <= 0
          || row.checkedAt > response.checkedAt + 1000 || response.checkedAt - row.checkedAt >= statusLifetimeMs) continue;
        observedRuntime.set(row.threadId, row.status);
        if (active.has(row.status)) remember(row.threadId, { activeAt: at });
      }
      trim(at);
    },
    priorityThreadIds() {
      trim(now());
      return ranked(now()).map(thread => thread.id);
    },
  };
}

export function taskStatusRequestPath(ids: readonly string[]) {
  const selected = [...new Set(ids.filter(validId))].slice(0, taskHotsetLimit);
  return selected.length ? `/api/task-statuses?${new URLSearchParams({ priorityThreadIds: selected.join(",") })}`
    : "/api/task-statuses";
}

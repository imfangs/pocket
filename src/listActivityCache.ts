import type { History } from "./conversationFeed";
import { conversationIsWorking } from "./conversationWorking.ts";
import { taskStatusMap, type TaskStatus, type TaskStatusResponse, type TaskStatusesView } from "./taskStatuses.ts";
import type { Thread } from "./types";

// Page-local list presentation only. Neither runtime permissions nor detail
// animations receive this projection, and no cached timestamp becomes a clock.
export const listActivityCacheLimit = 128;
type ConfirmedStatus = Exclude<TaskStatus, "unknown">;
type Observation = { checkedAt: number; confirmed?: ConfirmedStatus };
type NativeListHistory = History & { pocketContent?: { scope?: string } | null };
export type NativeListObservation = (threadId: string, history: NativeListHistory, requestedAt: number) => void;

export function createListActivityCache(machine: string | null, scope?: string, now: () => number = () => performance.now()) {
  const enabled = !!machine && !!scope && scope !== "unknown";
  const observations = new Map<string, Observation>();
  // The current accepted collection is a full read snapshot, not bounded
  // fallback memory. Its per-row facts also survive a server-cache replay.
  let freshFacts = new Map<string, Observation>();
  let eligible = new Set<string>(), freshStates = new Map<string, TaskStatus>();
  let collectionAt = -Infinity, discardedThrough = -Infinity, collectionStale = false;
  const newer = (first?: Observation, second?: Observation) => !first ? second
    : !second || first.checkedAt >= second.checkedAt ? first : second;
  const remember = (threadId: string, status: TaskStatus, checkedAt: number, floor = discardedThrough,
    previous = newer(observations.get(threadId), freshFacts.get(threadId))) => {
    // An unknown read is a failed attempt, not a newer confirmed state. It
    // cannot prevent an intervening explicit idle/waiting fact from arriving.
    if (status === "unknown") return !previous || checkedAt >= previous.checkedAt;
    if (!previous && checkedAt <= floor || previous && checkedAt < previous.checkedAt) return false;
    if (
      previous && checkedAt === previous.checkedAt && status !== previous.confirmed) return false;
    observations.delete(threadId);
    observations.set(threadId, { checkedAt, confirmed: status });
    while (observations.size > listActivityCacheLimit) {
      // Keep known activity for weak-network fallback ahead of idle records.
      const oldest = [...observations].sort((a, b) => Number(a[1].confirmed !== "idle") - Number(b[1].confirmed !== "idle")
        || a[1].checkedAt - b[1].checkedAt)[0];
      discardedThrough = Math.max(discardedThrough, oldest[1].checkedAt);
      observations.delete(oldest[0]);
    }
    return true;
  };
  return {
    update(threads: readonly Thread[], excludedThreadIds?: readonly string[]) {
      const excluded = new Set(excludedThreadIds);
      eligible = new Set(threads.filter(thread => !thread.archived && !thread.missing && !thread.separator &&
        !thread.sourceExcluded && !excluded.has(thread.id)).map(thread => thread.id));
      for (const [id, observation] of observations) if (!eligible.has(id)) {
        discardedThrough = Math.max(discardedThrough, observation.checkedAt);
        observations.delete(id);
      }
      for (const [id, observation] of freshFacts) if (!eligible.has(id)) {
        discardedThrough = Math.max(discardedThrough, observation.checkedAt);
        freshFacts.delete(id);
      }
      for (const id of freshStates.keys()) if (!eligible.has(id)) freshStates.delete(id);
    },
    observe(value: TaskStatusResponse) {
      if (!enabled || !taskStatusMap(value)) return;
      if (value.checkedAt < collectionAt) { collectionStale = true; return; }
      collectionAt = value.checkedAt; collectionStale = false;
      const previousFacts = freshFacts, previousCache = new Map(observations), floor = discardedThrough;
      freshStates = new Map();
      freshFacts = new Map();
      for (const row of value.states) {
        if (!eligible.has(row.threadId) || row.checkedAt <= 0 || row.checkedAt > value.checkedAt + 1000 ||
          value.checkedAt - row.checkedAt >= 30000) continue;
        const previous = newer(previousCache.get(row.threadId), previousFacts.get(row.threadId));
        if (remember(row.threadId, row.status, row.checkedAt, floor, previous)) {
          freshStates.set(row.threadId, row.status);
          const confirmed = row.status === "unknown" ? previous : { checkedAt: row.checkedAt, confirmed: row.status };
          if (confirmed) freshFacts.set(row.threadId, confirmed);
        }
        else {
          // A newer idle/waiting tombstone also defeats the raw old running row.
          if (previous?.confirmed) {
            freshStates.set(row.threadId, previous.confirmed);
            freshFacts.set(row.threadId, previous);
          }
          collectionStale = true;
        }
      }
    },
    observeNativeHistory(threadId: string, history: NativeListHistory, requestedAt = now()) {
      const age = now() - requestedAt;
      if (!enabled || !eligible.has(threadId) || history.source !== "desktop" || history.resumeState !== "resumed" ||
        !Number.isFinite(history.checkedAt) || history.checkedAt <= 0 ||
        !Number.isFinite(age) || age < 0 || age >= 30000 ||
        history.pocketContent?.scope && history.pocketContent.scope !== scope) return false;
      let status: ConfirmedStatus | undefined;
      const turnId = history.activeTurnId;
      const stopped = !!turnId && history.stopRequest && history.stopRequest.targetTurnId === turnId &&
        ["stopped", "ended"].includes(history.stopRequest.status);
      const terminal = !!turnId && history.turnTiming?.turnId === turnId &&
        ["completed", "failed", "interrupted"].includes(history.turnTiming.status);
      if (stopped || terminal || history.runtime === "idle" && history.latestTurnStatus !== "inProgress") status = "idle";
      else if (history.pendingRequests?.length) status = history.pendingRequests.some(request => request.kind === "questions")
        ? "waiting_input" : "waiting_approval";
      else if (!history.canSend && history.hint === "任务正在等待审批或输入，请在 Mac 的 Codex 中处理。") status = "waiting_input";
      else if (conversationIsWorking(history, { observed: true })) status = "running";
      if (!status || !remember(threadId, status, history.checkedAt)) return false;
      freshStates.set(threadId, status);
      freshFacts.set(threadId, { checkedAt: history.checkedAt, confirmed: status });
      return true;
    },
    project(view: TaskStatusesView) {
      const fresh = !view.runtimeLoading && !view.runtimeUnavailable;
      const states = fresh ? new Map(enabled ? freshStates : view.runtimeStates) : new Map<string, TaskStatus>();
      let cachedActivity = false;
      if (enabled) for (const [id, observation] of observations) {
        if (observation.confirmed && observation.confirmed !== "idle" && (!states.has(id) || states.get(id) === "unknown")) {
          states.set(id, observation.confirmed); cachedActivity = true;
        }
      }
      return { listRuntimeStates: states, listRuntimeStale: cachedActivity || view.runtimeUnavailable || fresh && collectionStale,
        listRuntimeCached: cachedActivity || fresh && collectionStale && states.size > 0,
        listRuntimeUnavailable: view.runtimeUnavailable && !cachedActivity,
        listRuntimeLoading: view.runtimeLoading && !cachedActivity };
    },
  };
}

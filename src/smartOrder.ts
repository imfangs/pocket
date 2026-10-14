import type { Thread } from "./types";
import type { TaskStatus } from "./taskStatuses";
import { lastMessageTime } from "./threadTime.ts";

export type PocketActivity = { createdAt?: number; visitedAt?: number };

export type SmartOrderOptions = {
  now: number;
  // Pass only the current, unexpired runtime snapshot from taskStatuses.
  runtimeStates?: ReadonlyMap<string, TaskStatus>;
  draftIds?: ReadonlySet<string>;
  pocketActivity?: ReadonlyMap<string, PocketActivity>;
};

const day = 86400000;

function waitingForUser(status?: TaskStatus) {
  return status === "waiting_input" || status === "waiting_approval";
}

// A fresh executing state supersedes the catalog's older completion snapshot.
// Unknown/absent runtime evidence does not erase a recorded unread completion.
export function needsUserInput(thread: Thread, runtimeStatus?: TaskStatus) {
  if (thread.sourceExcluded || thread.archived || thread.missing || thread.separator) return false;
  if (waitingForUser(runtimeStatus)) return true;
  return runtimeStatus !== "running" && thread.needsInput === true;
}

function clockTime(now: number) {
  return Number.isFinite(now) && now > 0 ? now : 0;
}

function eventTime(value: number, now: number) {
  return Number.isFinite(value) && value > 0 && now > 0 ? Math.min(value, now) : 0;
}

function freshness(time: number, now: number, scale: number) {
  return time > 0 ? Math.exp(-(now - time) / scale) : 0;
}

// These are adjustable product heuristics, not model output or probabilities.
// Every preference contributes to the same bounded score. Pins express ongoing
// interest, but recent activity can outweigh them without changing pin state.
export function smartThreadScore(thread: Thread, options: SmartOrderOptions) {
  if (thread.sourceExcluded || thread.missing || thread.separator) return -1;
  const now = clockTime(options.now);
  const updated = eventTime(lastMessageTime(thread) ?? 0, now);
  const created = eventTime(thread.createdAt, now);
  const runtime = thread.archived ? undefined : options.runtimeStates?.get(thread.id);
  const waiting = waitingForUser(runtime);
  const completedUnread = !waiting && needsUserInput(thread, runtime);
  const activity = options.pocketActivity?.get(thread.id);
  return (waiting ? 180 : 0)
    + (completedUnread ? 160 * freshness(updated, now, 7 * day) : 0)
    + (thread.pinned ? thread.pinSource === "pocket" ? 90 : 60 : 0)
    + (options.draftIds?.has(thread.id) ? 85 : 0)
    + (runtime === "running" ? 70 : 0)
    + 100 * freshness(updated, now, 3 * day)
    + 12 * freshness(created, now, 2 * day)
    + 45 * freshness(eventTime(activity?.createdAt ?? 0, now), now, 2 * day)
    + 55 * freshness(eventTime(activity?.visitedAt ?? 0, now), now, day);
}

export function smartThreadOrder(threads: readonly Thread[], options: SmartOrderOptions): Thread[] {
  const now = clockTime(options.now);
  const ranked = threads.map(thread => ({
    thread,
    score: smartThreadScore(thread, options),
    updated: eventTime(lastMessageTime(thread) ?? 0, now),
    created: eventTime(thread.createdAt, now),
  }));
  ranked.sort((a, b) => b.score - a.score
    || b.updated - a.updated
    || b.created - a.created
    || (a.thread.id < b.thread.id ? -1 : a.thread.id > b.thread.id ? 1 : 0));
  return ranked.map(entry => entry.thread);
}

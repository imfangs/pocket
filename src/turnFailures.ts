import type { History, Message, SavedTranscript, TurnFailure } from "./conversationFeed";
import type { ProgressMessageEntry } from "./progressGroups";
import { normalizeTurnFailures } from "../shared/turn-failure.mjs";

export function turnFailures(value: unknown): TurnFailure[] {
  return normalizeTurnFailures(value);
}

// Failure facts are readable turn metadata, never a synthetic assistant
// message, permission, send receipt or evidence that a cached run is active.
export function displayedTurnFailures(history: History | null, saved: SavedTranscript | null): TurnFailure[] {
  const native = history?.source === "desktop";
  const recorded = turnFailures(saved?.turnFailures);
  const nativeFacts = turnFailures(history?.turnFailures);
  const failures = native ? [...new Map([...recorded, ...nativeFacts.map(failure => ({
    ...recorded.find(item => item.turnId === failure.turnId), ...failure,
  }))].map(failure => [failure.turnId, failure])).values()] : saved?.turnFailures !== undefined ? recorded : nativeFacts;
  const latest = history?.latestTurnId ?? history?.turnTiming?.turnId;
  const knownFailedId = native && history.latestTurnStatus === "failed" ? latest
    : !native && saved?.turnTiming?.status === "failed" ? saved.turnTiming.turnId : null;
  if (knownFailedId && knownFailedId.length <= 128 && !failures.some(failure => failure.turnId === knownFailedId)) failures.push({ turnId: knownFailedId });
  return failures.filter(failure => {
    if (!native) return true;
    if (history.activeTurnId === failure.turnId && history.latestTurnStatus === "inProgress") return false;
    if (latest === failure.turnId && history.latestTurnStatus && history.latestTurnStatus !== "failed") return false;
    const current = history.recentTurns?.find(turn => turn.id === failure.turnId);
    if (current && current.status !== "failed") return false;
    return true;
  });
}

export function turnFailurePlacement(entries: readonly ProgressMessageEntry[], failures: readonly TurnFailure[], latestTurnId?: string | null) {
  const last = new Map<string, number>();
  entries.forEach((entry, index) => {
    for (const message of entry.type === "progress" ? entry.messages : [entry.message]) if (message.turnId) last.set(message.turnId, index);
  });
  const after = new Map<number, TurnFailure[]>(), tail: TurnFailure[] = [];
  for (const failure of failures) {
    const index = last.get(failure.turnId);
    if (index !== undefined) after.set(index, [...(after.get(index) ?? []), failure]);
    // An earlier failure with no visible turn anchor cannot safely be moved
    // below a newer reply. Only the exact latest turn may use the tail fallback.
    else if (failure.turnId === latestTurnId) tail.push(failure);
  }
  return { after, tail };
}

// Tail fallback needs chronology, not whichever feed happened to answer last.
// A source can have a failed turn with no visible message, so the preceding
// native body is not by itself evidence that this failure is obsolete.
export function failureTailTurnId(history: History | null, saved: SavedTranscript | null, shown: readonly Message[]): string | null {
  const nativeId = history?.latestTurnId ?? history?.turnTiming?.turnId ?? null;
  const savedId = saved?.turnTiming?.turnId ?? null;
  if (history?.source !== "desktop") return savedId ?? nativeId;
  const last = shown.at(-1), nativeAt = history.turnTiming?.startedAt, savedAt = saved?.turnTiming?.startedAt;
  if (savedId && savedId !== nativeId && nativeAt != null && savedAt != null) {
    if (savedAt > nativeAt && last?.turnId === savedId) return savedId;
    if (nativeAt >= savedAt) return nativeId;
  }
  if (!last || last.turnId === nativeId) return nativeId;
  const turns = history.recentTurns ?? [], nativeIndex = turns.findIndex(turn => turn.id === nativeId), shownIndex = turns.findIndex(turn => turn.id === last.turnId);
  if (nativeIndex >= 0 && shownIndex >= 0 && nativeIndex >= shownIndex) return nativeId;
  if (history.messages.some(message => message.id === last.id && message.turnId === last.turnId)) return nativeId;
  // No exact/native-order proof and a divergent recorded tail: don't label a
  // newer displayed attempt with an old unanchored failure.
  return null;
}

const highDemand = new Set([
  "We’re currently experiencing high demand, which may cause temporary errors.",
  "We're currently experiencing high demand, which may cause temporary errors.",
]);
export function turnFailureSummary(failure: TurnFailure) {
  return highDemand.has(failure.message ?? "") ? "服务繁忙，本轮未能完成。"
    : failure.message ? failure.message.length <= 280 ? failure.message : "本轮未能完成。"
    : "未收到具体错误原因。";
}
export function turnFailureDetails(failure: TurnFailure) {
  return [failure.message, failure.code, failure.additionalDetails].filter(Boolean).join("\n\n");
}
export function failureHasDetails(failure: TurnFailure) {
  const details = turnFailureDetails(failure);
  return !!details && (details !== turnFailureSummary(failure));
}

import type { History, TurnTiming } from "./conversationFeed";

// This is a display signal for a fresh original-owner read, not permission to
// send or evidence that an accepted/queued query has started a model turn.
export function conversationIsWorking(history: History | null, {
  observed = false,
  online = true,
  available = true,
  connectionPending = false,
  readFailed = false,
  recordedTiming,
}: {
  observed?: boolean;
  online?: boolean;
  available?: boolean;
  connectionPending?: boolean;
  readFailed?: boolean;
  recordedTiming?: TurnTiming | null;
} = {}) {
  if (!observed || !online || !available || connectionPending || readFailed ||
      history?.source !== "desktop" || history.resumeState !== "resumed" ||
      history.runtime !== "active" || history.latestTurnStatus !== "inProgress" ||
      !history.activeTurnId || history.pendingRequests?.length || history.compaction?.active) return false;
  // Native activeFlags/goal confirmation can block on the user without a
  // projected request card. Exclude only that known owner wait condition;
  // a settings-write guard or unavailable send capability is not a run state.
  if (!history.canSend && history.hint === "任务正在等待审批或输入，请在 Mac 的 Codex 中处理。") return false;
  const stop = history.stopRequest;
  if (stop?.targetTurnId === history.activeTurnId &&
      ["pending", "accepted", "unknown", "stopped", "ended"].includes(stop.status)) return false;
  // A recorded terminal event can arrive before the desktop's next idle read.
  // It belongs only to the exact current turn; an older final cannot hide work.
  if (recordedTiming?.turnId === history.activeTurnId &&
      ["completed", "failed", "interrupted"].includes(recordedTiming.status)) return false;
  return true;
}

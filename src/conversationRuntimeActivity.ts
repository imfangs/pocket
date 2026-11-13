import type { History } from "./conversationFeed";
import { conversationIsWorking } from "./conversationWorking.ts";

export type RuntimeOperationKind = "command" | "tool" | "file" | "delegation";
export type RuntimeActivity = {
  turnId: string;
  lastEventAt: number | null;
  lastMessageAt: number | null;
  activeOperation: { kind: RuntimeOperationKind; startedAt: number | null } | null;
};
export type RuntimeObservation = {
  scope: string;
  turnId: string;
  observedAt: number;
  receivedAt: number;
  lastEventAt: number | null;
  lastMessageAt: number | null;
  waitBaselineAt: number | null;
  activeOperation: RuntimeActivity["activeOperation"];
  // Ephemeral comparison only, never persisted or rendered as diagnostics.
  visibleMessageId: string | null;
  visibleSignature: string | null;
  visibleChangedAt: number | null;
};
export type RuntimeFeedback = {
  state: "working" | "unconfirmed";
  turnId: string;
  operation: RuntimeOperationKind | null;
  detail: "operation" | "activity" | "messages" | "confirmed";
  ageMs: number | null;
  confirmedAgeMs: number | null;
};
export type RuntimeFeedbackInput = {
  scope: string;
  history: History | null;
  observation: RuntimeObservation | null;
  working: boolean;
  now: number;
  available?: boolean;
  allowUnconfirmed?: boolean;
};
export const runtimeTextSilenceMs = 120000;
export const runtimeObservationFreshMs = 60000;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const eventTime = (value: unknown, observedAt: number): number | null => finite(value) && value > 0 && value <= observedAt ? value : null;
const maxTime = (...values: (number | null)[]) => values.reduce<number | null>((latest, value) => value === null ? latest : Math.max(latest ?? value, value), null);

function activity(value: unknown, turnId: string, observedAt: number): RuntimeActivity | null {
  if (!record(value) || value.turnId !== turnId) return null;
  const raw = value.activeOperation;
  const operation = record(raw) && typeof raw.kind === "string" && ["command", "tool", "file", "delegation"].includes(raw.kind)
    ? { kind: raw.kind as RuntimeOperationKind, startedAt: eventTime(raw.startedAt, observedAt) } : null;
  return { turnId, lastEventAt: eventTime(value.lastEventAt, observedAt), lastMessageAt: eventTime(value.lastMessageAt, observedAt), activeOperation: operation };
}

// Capture only a genuine native active read. Parent owns request epochs and
// source identity; callers must not pass a disk/cache preview as a new read.
export function observeConversationRuntime(history: History & { runtimeActivity?: RuntimeActivity | null }, {
  scope, receivedAt, previous = null,
}: { scope: string; receivedAt: number; previous?: RuntimeObservation | null }): RuntimeObservation | null {
  if (!scope || !finite(receivedAt) || !conversationIsWorking(history, { observed: true })) return null;
  const turnId = history.activeTurnId!;
  const sampledAt = eventTime(history.turnTiming?.observedAt, Number.MAX_SAFE_INTEGER)
    ?? eventTime(history.checkedAt, Number.MAX_SAFE_INTEGER);
  if (sampledAt === null) return null;
  const known = previous?.scope === scope && previous.turnId === turnId ? previous : null;
  // A cached native sample or an older reply cannot renew observation age.
  if (known && sampledAt < known.observedAt) return known;
  const native = activity(history.runtimeActivity, turnId, sampledAt);
  const last = history.messages.slice().reverse().find(message => message.role === "assistant" && message.turnId === turnId &&
    message.phase !== "analysis" && !!message.text.trim());
  const lastMessageAt = maxTime(native?.lastMessageAt ?? null, eventTime(last?.timestamp, sampledAt));
  const signature = last && !last.truncated ? JSON.stringify([last.id, last.text, last.phase ?? ""]) : null;
  let visibleChangedAt: number | null = null;
  if (known && last && known.visibleMessageId === last.id) {
    visibleChangedAt = known.visibleSignature !== null && signature !== null && known.visibleSignature !== signature
      ? receivedAt : known.visibleChangedAt;
  } else if (known?.visibleMessageId && last && signature !== null && sampledAt > known.observedAt) {
    // Older adapters may timestamp a new commentary at turn start. Only a
    // complete, uniquely identified append after the retained native tail can
    // establish newly visible text; a replaced/paged window cannot do so.
    const visible = history.messages.filter(message => message.role === "assistant" && message.turnId === turnId &&
      message.phase !== "analysis" && !!message.text.trim());
    const previous = visible.flatMap((message, index) => message.id === known.visibleMessageId ? [index] : []);
    const current = visible.flatMap((message, index) => message.id === last.id ? [index] : []);
    if (previous.length === 1 && current.length === 1 && previous[0] < current[0]) visibleChangedAt = receivedAt;
  }
  const startedAt = history.turnTiming?.turnId === turnId ? eventTime(history.turnTiming.startedAt, sampledAt) : null;
  return {
    scope, turnId, observedAt: sampledAt,
    receivedAt: known && sampledAt === known.observedAt ? known.receivedAt : receivedAt,
    lastMessageAt, waitBaselineAt: lastMessageAt ?? startedAt,
    lastEventAt: maxTime(native?.lastEventAt ?? null, lastMessageAt, startedAt),
    activeOperation: native?.activeOperation ?? null,
    visibleMessageId: last?.id ?? null, visibleSignature: signature, visibleChangedAt,
  };
}

function knownNotWorking(history: History | null, turnId: string) {
  if (history?.pendingRequests?.length || history?.compaction?.active) return true;
  const stop = history?.stopRequest;
  if (stop?.targetTurnId === turnId && ["pending", "accepted", "unknown", "stopped", "ended"].includes(stop.status)) return true;
  if (history?.source !== "desktop") return false;
  return history.resumeState !== "resumed" || history.runtime !== "active" || history.latestTurnStatus !== "inProgress" ||
    !history.canSend && history.hint === "任务正在等待审批或输入，请在 Mac 的 Codex 中处理。";
}

function runtimeContext({ scope, history, observation, now, available = true }: RuntimeFeedbackInput) {
  if (!available || !observation || observation.scope !== scope || !finite(now) ||
    knownNotWorking(history, observation.turnId)) return null;
  const currentTurnId = history?.activeTurnId ?? history?.latestTurnId ?? history?.turnTiming?.turnId;
  if (currentTurnId && currentTurnId !== observation.turnId) return null;
  return { observation, elapsed: now >= observation.receivedAt ? now - observation.receivedAt : null };
}

// Authority is independent of the two-minute caption gate: a quiet short turn
// cannot keep animated running dots alive after its native sample expires.
export function conversationRuntimeIsCurrent(input: RuntimeFeedbackInput) {
  const context = runtimeContext(input);
  return !!context && input.working && input.history?.source === "desktop" && context.elapsed !== null &&
    context.elapsed <= runtimeObservationFreshMs;
}

// All event ages use the Mac's observation anchor plus local monotonic elapsed
// time. No phone wall clock and no poll/checkedAt becomes an activity event.
export function conversationRuntimeFeedback(input: RuntimeFeedbackInput): RuntimeFeedback | null {
  const context = runtimeContext(input);
  if (!context) return null;
  const { observation, elapsed } = context;
  const { working, now, allowUnconfirmed = false } = input;
  const since = (time: number | null) => time === null || elapsed === null ? null : Math.max(0, observation.observedAt - time + elapsed);
  const visibleAge = observation.visibleChangedAt !== null && now >= observation.visibleChangedAt ? now - observation.visibleChangedAt : null;
  const minAge = (left: number | null, right: number | null) => left === null ? right : right === null ? left : Math.min(left, right);
  const messageAge = minAge(since(observation.waitBaselineAt), visibleAge);
  const fresh = conversationRuntimeIsCurrent(input);
  if (!fresh && !working && !allowUnconfirmed) return null;
  if (messageAge !== null && messageAge < runtimeTextSilenceMs) return null;
  // Missing event/turn start evidence alone cannot manufacture a long wait.
  if (messageAge === null && fresh) return null;
  if (!fresh) return { state: "unconfirmed", turnId: observation.turnId, operation: null,
    detail: "confirmed", ageMs: elapsed, confirmedAgeMs: elapsed };
  const operation = observation.activeOperation;
  const operationAge = since(operation?.startedAt ?? null);
  const eventAge = minAge(since(observation.lastEventAt), visibleAge);
  return { state: "working", turnId: observation.turnId, operation: operation?.kind ?? null,
    detail: operationAge !== null ? "operation" : eventAge !== null ? "activity" : "messages",
    ageMs: operationAge ?? eventAge ?? messageAge, confirmedAgeMs: elapsed };
}

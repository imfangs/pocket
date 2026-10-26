export type UsageProperties = Record<string, string | number | boolean | null>;
type Context = { thread_id: string; visit_id: string };
type Timer = { started: number; foreground: number };
type Visit = Timer & Context & { contentVisible: boolean; focused: boolean };
type Submission = Timer & Context & { status?: string; visible: boolean; settled: boolean };
export type FeedbackReason = "unspecified" | "slow" | "unresponsive" | "position" | "hard_to_find" | "other";

/** Observation only. A failed sink never changes a request, draft or read watermark. */
export function createUsageJournal({ capture, now = () => performance.now(), id = () =>
  globalThis.crypto?.randomUUID?.() ?? `visit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }: {
  capture: (event: string, properties: UsageProperties) => boolean;
  now?: () => number;
  id?: () => string;
}) {
  let enabled = false, visible = true, foreground = 0, last = now();
  let visit: Visit | null = null;
  const submissions = new Map<string, Submission>();
  const advance = () => { const current = now(); if (visible) foreground += Math.max(0, current - last); last = current; };
  const timing = (timer: Timer) => {
    advance();
    return { elapsed_ms: Math.round(Math.max(0, now() - timer.started)), foreground_ms: Math.round(Math.max(0, foreground - timer.foreground)) };
  };
  const emit = (event: string, props: UsageProperties = {}) => {
    if (!enabled) return false;
    try { return capture(event, props); } catch { return false; }
  };
  const context = (threadId: string): Context => ({ thread_id: threadId, visit_id: visit?.thread_id === threadId ? visit.visit_id : "" });
  return {
    enable(value: boolean, isVisible = true) {
      advance(); enabled = value; visible = isVisible; last = now();
      if (!value) { visit = null; submissions.clear(); }
    },
    event: emit,
    visibility(isVisible: boolean) {
      if (isVisible === visible) return;
      advance(); visible = isVisible;
      emit("pocket_visibility_changed", { ...(visit ? context(visit.thread_id) : {}), visible: isVisible });
    },
    open(threadId: string) {
      if (!enabled) return null;
      advance();
      visit = { thread_id: threadId, visit_id: id(), started: now(), foreground, contentVisible: false, focused: false };
      emit("pocket_conversation_opened", context(threadId));
      return visit.visit_id;
    },
    close(visitId: string | null, properties: UsageProperties = {}) {
      if (!visit || visit.visit_id !== visitId) return;
      emit("pocket_conversation_closed", { ...context(visit.thread_id), ...timing(visit), content_visible: visit.contentVisible, ...properties });
      visit = null;
    },
    contentVisible(threadId: string, messageCount: number) {
      if (!visible || !visit || visit.thread_id !== threadId || visit.contentVisible) return;
      visit.contentVisible = true;
      emit("pocket_content_visible", { ...context(threadId), ...timing(visit), message_count: messageCount });
    },
    focus(threadId: string) {
      if (!visit || visit.thread_id !== threadId || visit.focused) return;
      visit.focused = true;
      emit("pocket_composer_focused", { ...context(threadId), ...timing(visit) });
    },
    submit(threadId: string, requestId: string, properties: UsageProperties) {
      if (!enabled) return;
      advance();
      // Checking an existing request is not a new send or a new funnel entry.
      if (properties.action === "check") {
        emit("pocket_submission_checked", { ...context(threadId), request_id: requestId });
        return;
      }
      if (submissions.has(requestId)) return;
      submissions.set(requestId, { ...context(threadId), started: now(), foreground, visible: false, settled: false });
      if (submissions.size > 100) submissions.delete(submissions.keys().next().value!);
      emit("pocket_submission_started", { ...context(threadId), request_id: requestId, ...properties });
    },
    receipt(threadId: string, requestId: string, status: string) {
      const item = submissions.get(requestId);
      if (!item || item.thread_id !== threadId || item.status === status ||
          !["accepted", "queued", "pending", "unknown", "rejected", "not_found", "cancelled"].includes(status)) return;
      // Match the submitted-query store: late responses cannot undo a terminal state.
      if (item.status === "accepted" || item.status === "cancelled") return;
      item.status = status;
      emit("pocket_submission_receipt", { thread_id: threadId, visit_id: item.visit_id, request_id: requestId, status, ...timing(item) });
    },
    messageVisible(threadId: string, requestId: string) {
      const item = submissions.get(requestId);
      if (!visible || !item || item.thread_id !== threadId || item.visible) return;
      item.visible = true;
      emit("pocket_submission_visible", { thread_id: threadId, visit_id: visit?.thread_id === threadId ? visit.visit_id : "",
        submission_visit_id: item.visit_id, request_id: requestId, ...timing(item) });
    },
    waitEnded(threadId: string, requestId: string, stillInView: boolean) {
      const item = submissions.get(requestId);
      if (!item || item.thread_id !== threadId || item.settled) return;
      item.settled = true;
      emit("pocket_submission_wait_ended", { thread_id: threadId, visit_id: item.visit_id, request_id: requestId, still_in_view: stillInView, ...timing(item) });
    },
    feedback(threadId: string): string | null {
      const feedbackId = id();
      return emit("pocket_feedback_marked", { ...context(threadId), feedback_id: feedbackId }) ? feedbackId : null;
    },
    feedbackDetails(threadId: string, feedbackId: string, reason: FeedbackReason, note: string) {
      return emit("pocket_feedback_details", { ...context(threadId), feedback_id: feedbackId, reason, note: note.trim().slice(0, 500) });
    },
  };
}

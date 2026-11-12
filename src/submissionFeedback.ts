import type { History, QueuedMessage } from "./conversationFeed";
import type { SubmissionReceipt } from "./submissionReceipt";
import { pendingSubmittedUpload, submittedUploadNeedsCheck } from "./submittedQueries.ts";
import type { AttachmentUploadProgress } from "./submittedQueries";

export const SEND_FEEDBACK_MS = 6000;
export type AcceptedFeedback = { requestId: string; source: "composer" | "queue"; expiresAt: number };

// This tracker belongs to one mounted conversation. Cached history alone never
// registers a success, and repeated receipts cannot restart its highlight.
export function createSubmissionFeedbackTracker(now = Date.now) {
  const acknowledged = new Set<string>(), observedQueue = new Set<string>();
  const receiptRequired = new Set<string>();
  const accept = (receipt: Pick<SubmissionReceipt, "requestId" | "status">, source: AcceptedFeedback["source"] = "composer"): AcceptedFeedback | null => {
    if (receipt.status !== "accepted" || !receipt.requestId || acknowledged.has(receipt.requestId)) return null;
    acknowledged.add(receipt.requestId);
    return { requestId: receipt.requestId, source, expiresAt: now() + SEND_FEEDBACK_MS };
  };
  return {
    accept,
    hasAccepted: (requestId: string) => acknowledged.has(requestId),
    trackQueued: (requestId: string, upload?: { uploadProgress?: AttachmentUploadProgress }) => {
      if (!requestId) return;
      observedQueue.add(requestId);
      if (upload?.uploadProgress) receiptRequired.add(requestId);
    },
    observeHistory(history: Pick<History, "source" | "messages" | "outbox">) {
      const confirmed: AcceptedFeedback[] = [];
      if (history.source === "desktop") for (const message of history.messages) {
        const id = message.clientMessageId;
        if (message.role !== "user" || !id || !observedQueue.has(id) || receiptRequired.has(id)
          || history.outbox?.some(item => item.id === id && item.uploadProgress)) continue;
        observedQueue.delete(id);
        const feedback = accept({ requestId: id, status: "accepted" }, "queue");
        if (feedback) confirmed.push(feedback);
      }
      for (const item of history.outbox ?? []) if (item.status !== "accepted") {
        observedQueue.add(item.id);
        if (item.uploadProgress) receiptRequired.add(item.id);
      }
      return confirmed;
    },
  };
}

export function queueFeedbackState(item: Pick<QueuedMessage, "status" | "uploadProgress" | "attachmentUploads">, options: { accepted?: boolean; paused?: boolean; editing?: boolean; busy?: boolean; disabled?: boolean; headBlocked?: boolean } = {}) {
  if (options.accepted || item.status === "accepted") return { state: "accepted", breathing: false };
  if (item.status === "unknown" || item.status === "rejected") return { state: item.status, breathing: false };
  if (options.editing || item.status === "editing") return { state: "editing", breathing: false };
  if (options.paused) return { state: "paused", breathing: false };
  if (pendingSubmittedUpload(item)) return submittedUploadNeedsCheck(item) ? { state: "unknown", breathing: false }
    : item.uploadProgress?.status === "failed" ? { state: "upload_failed", breathing: false }
    : { state: "uploading", breathing: !options.disabled };
  if (options.busy || item.status === "pending") return { state: "pending", breathing: false };
  return { state: "queued", breathing: !options.disabled && !options.headBlocked };
}

export function queueHeadState(head: Pick<QueuedMessage, "id" | "status" | "uploadProgress">, editingId?: string) {
  const editing = head.status === "editing" || head.id === editingId;
  return { editing, blocked: editing || head.status === "unknown" || head.status === "rejected" || pendingSubmittedUpload(head) };
}

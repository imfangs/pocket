import { api } from "./api.ts";
import { attachmentDraftController, attachmentRefs, readyAttachments, validateAttachment, type AttachmentDraftController, type DraftAttachment, type PublicAttachment } from "./attachments.ts";
import { currentMachineId, type MachineId } from "./machineScope.ts";
import type { QueryDraft } from "./queryDraft";
import type { SubmissionReceipt } from "./submissionReceipt.ts";
import { withSubmittedQueryPost, type SubmittedQueryStore, type SubmittedUploadActions } from "./submittedQueries.ts";

type Intent = { threadId: string; requestId: string; text: string; files: readonly DraftAttachment[]; autoDirect: boolean; enqueue: boolean };
type ReservationPhase = "posting" | "unknown" | "rejected" | "reserved";
type SubmissionState = "active" | "cancelling" | "accepted" | "cancelled" | "restored" | "disposed";
type UploadSubmission = Intent & { machine: MachineId | null; state: SubmissionState; reservation: ReservationPhase; unsubscribe?: () => void;
  timer?: ReturnType<typeof setTimeout>; read?: Promise<SubmissionReceipt>;
  recovery?: { attachments: readonly PublicAttachment[]; remaining: Set<string>; released: boolean } };
type Transport = {
  reserve: (intent: Intent, signal?: AbortSignal) => Promise<SubmissionReceipt>;
  receipt: (threadId: string, requestId: string, signal?: AbortSignal) => Promise<SubmissionReceipt>;
  cancel: (threadId: string, requestId: string, revision: number, signal?: AbortSignal) => Promise<unknown>;
};
const transport: Transport = {
  reserve: (intent, signal) => api(`/api/tasks/${intent.threadId}/messages`, "POST", {
    text: intent.text, requestId: intent.requestId, autoDirect: intent.autoDirect, ...(intent.enqueue ? { enqueue: true } : {}),
    attachmentUploads: intent.files.map(file => ({ id: file.id, name: file.name, size: file.size, mime: file.mime,
      ...(file.sourceSha256 ? { sourceSha256: file.sourceSha256 } : {}) })),
  }, { signal, timeoutMs: 18000 }),
  receipt: (threadId, requestId, signal) => api(`/api/tasks/${threadId}/messages/${requestId}`, "GET", undefined, { signal, timeoutMs: 10000 }),
  cancel: (threadId, requestId, revision, signal) => api(`/api/tasks/${threadId}/outbox/${requestId}`, "DELETE", { expectedRevision: revision }, { signal }),
};

// This owner outlives the inspector. The draft Map holds files separately from
// the stable submission body; remote receipt reads never repeat its POST.
export function createAttachmentSubmissionManager(drafts: Map<string, QueryDraft>, submissions: SubmittedQueryStore,
  uploads: AttachmentDraftController = attachmentDraftController(drafts), request: Transport = transport,
  options: { machine?: () => MachineId | null; intervalMs?: number } = {}) {
  const records = new Map<string, UploadSubmission>(), machine = options.machine ?? currentMachineId;
  const lifetime = new AbortController();
  let disposed = false, suspended = false, ownerCount = 0;
  const requireOwner = () => { if (disposed || suspended) throw new Error("会话已关闭，请重新打开后继续。"); };
  const key = (threadId: string, requestId: string) => JSON.stringify([threadId, requestId]);
  const hasReservation = (record: UploadSubmission) => record.reservation === "reserved";
  const current = (record: UploadSubmission) => !disposed && !suspended && ["active", "cancelling"].includes(record.state) && record.machine === machine();
  const stop = (record: UploadSubmission, state: SubmissionState) => {
    record.state = state; clearTimeout(record.timer); record.unsubscribe?.(); record.unsubscribe = undefined;
  };
  const finish = (record: UploadSubmission, state: "accepted" | "cancelled" | "restored") => {
    stop(record, state); records.delete(key(record.threadId, record.requestId));
  };
  const publish = (record: UploadSubmission) => {
    if (!current(record) || record.state !== "active") return;
    const items = uploads.getSubmission(record.threadId, record.requestId);
    if (!items.length) return;
    const unknown = items.some(item => item.status === "unknown"), failed = items.some(item => item.status === "failed");
    submissions.updateUpload(record.threadId, record.requestId, {
      progress: { total: record.files.length, uploaded: items.filter(item => item.status === "uploaded").length,
        status: failed ? "failed" : readyAttachments(items) ? "ready" : "uploading", ...(unknown ? { code: "attachment_upload_unknown" } : {}) },
      descriptors: items.map(item => ({ id: item.id, name: item.name, size: item.size, mime: item.mime,
        status: item.status === "removing" ? "unknown" : item.status, ...(item.error ? { error: item.error } : {}) })),
      attachments: attachmentRefs(items),
    });
  };
  const schedule = (record: UploadSubmission) => {
    clearTimeout(record.timer);
    if (current(record) && record.reservation !== "rejected" && !record.recovery)
      record.timer = setTimeout(() => { void check(record).catch(() => {}); }, options.intervalMs ?? 1500);
  };
  const apply = (record: UploadSubmission, receipt: SubmissionReceipt) => {
    if (!current(record) || receipt.requestId !== record.requestId) return;
    if (receipt.uploadProgress && receipt.status !== "not_found")
      record.reservation = "reserved";
    else if (record.reservation === "unknown" && receipt.status === "rejected") record.reservation = "rejected";
    const refs = receipt.attachmentUploads?.flatMap(item => item.attachment ? [validateAttachment(item.attachment, record.threadId, item.id)] : []);
    const local = uploads.getSubmission(record.threadId, record.requestId);
    const descriptors = receipt.attachmentUploads?.map(item => {
      const known = local.find(value => value.id === item.id);
      return known && ["unknown", "failed"].includes(known.status) && item.status !== "uploaded"
        ? { ...item, status: known.status as "unknown" | "failed", error: known.error } : item;
    });
    if (receipt.uploadProgress) submissions.updateUpload(record.threadId, record.requestId, {
      progress: receipt.uploadProgress, descriptors, ...(refs?.length ? { attachments: refs } : {}),
    });
    if (receipt.status === "accepted") {
      submissions.receipt(record.threadId, receipt);
      // Authenticated accepted metadata can settle a lost final PUT response.
      // It cannot create acceptance; the receipt above remains its authority.
      if (refs?.length === record.files.length) uploads.confirmSubmission(record.threadId, record.requestId, refs);
      stop(record, "accepted");
      const cleanup = () => {
        const items = uploads.getSubmission(record.threadId, record.requestId);
        if (!items.length || readyAttachments(items)) {
          try { uploads.completeSubmission(record.threadId, record.requestId); } catch { return; }
          finish(record, "accepted");
        }
      };
      record.unsubscribe = uploads.subscribeSubmission(record.threadId, record.requestId, cleanup);
      cleanup(); return;
    }
    if (record.state === "cancelling" && receipt.status !== "cancelled") { submissions.receipt(record.threadId, receipt); schedule(record); return; }
    submissions.receipt(record.threadId, receipt);
    if (["queued", "editing", "pending", "accepted"].includes(receipt.status) && receipt.uploadProgress) {
      if (receipt.status !== "editing") uploads.resumeSubmission(record.threadId, record.requestId);
    }
    if (receipt.status === "cancelled" && !record.recovery && !uploads.getSubmission(record.threadId, record.requestId).length) {
      uploads.completeSubmission(record.threadId, record.requestId); finish(record, "cancelled");
    }
    else schedule(record);
  };
  const check = (record: UploadSubmission): Promise<SubmissionReceipt> => {
    if (record.read) return record.read;
    if (!current(record)) return Promise.reject(new Error("提交所属电脑已变化，请重新核对。"));
    const pending = request.receipt(record.threadId, record.requestId, lifetime.signal).then(receipt => {
      if (receipt.requestId !== record.requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
      apply(record, receipt); return receipt;
    }).finally(() => { if (record.read === pending) record.read = undefined; schedule(record); });
    record.read = pending; return pending;
  };
  const cancel = async (threadId: string, requestId: string): Promise<number | void> => {
    requireOwner();
  const record = records.get(key(threadId, requestId));
  if (record && record.machine !== machine()) throw new Error("提交所属电脑已变化，请重新核对。");
  if (record) { record.state = "cancelling"; clearTimeout(record.timer); record.unsubscribe?.(); record.unsubscribe = undefined; }
  try {
    const receipt = await request.receipt(threadId, requestId, lifetime.signal);
    requireOwner();
    if (receipt.requestId !== requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
    if (receipt.status === "accepted") { if (record) apply(record, receipt); else submissions.receipt(threadId, receipt); throw new Error("这条消息已发送，无法取消。"); }
    if (record && receipt.uploadProgress && receipt.status !== "not_found") {
      record.reservation = "reserved";
      const known = receipt.attachmentUploads?.flatMap(item => item.attachment ? [validateAttachment(item.attachment, threadId, item.id)] : []);
      if (known?.length === record.files.length) uploads.confirmSubmission(threadId, requestId, known);
    }
    // A negative GET alone cannot prove that an original POST did not
    // arrive. Local cancellation requires its definite rejection too.
    const unreserved = record?.reservation === "rejected" && ["rejected", "not_found"].includes(receipt.status) && !receipt.uploadProgress;
    if (receipt.status !== "cancelled" && !unreserved && !record?.recovery) {
      if (!Number.isInteger(receipt.queueRevision)) throw new Error("提交状态仍待核对，请稍后再取消。");
      await request.cancel(threadId, requestId, receipt.queueRevision!, lifetime.signal);
      requireOwner();
    }
    // Ownership remains after uploads finish. A complete queued bundle keeps
    // ordinary cancel-to-draft semantics instead of deleting uploaded originals.
    const bundle = uploads.getSubmission(threadId, requestId);
    if (record && !record.recovery && hasReservation(record) && bundle.length === record.files.length && readyAttachments(bundle))
      record.recovery = { attachments: attachmentRefs(bundle), remaining: new Set(bundle.map(item => item.id)), released: false };
    if (record?.recovery) {
      clearTimeout(record.timer);
      const released = record.recovery.attachments.map(item => item.id), remainingBefore = record.recovery.remaining.size;
      let recoveryFailure: unknown;
      try {
        if (!record.recovery.released) {
          uploads.completeSubmission(threadId, requestId);
          record.recovery.released = true;
          await uploads.releaseQueued(threadId, released);
        } else {
          // Unclaim only once: a newer message can own a restored attachment
          // while the remaining original files still await recovery.
          await uploads.recover(threadId);
        }
      } catch (failure) { recoveryFailure = failure; }
      requireOwner();
      // A capacity-limited read can have delivered part of this message before
      // throwing. Those files may immediately enter a newer submission; their
      // successful handoff must not depend on remaining in the composer.
      for (const item of uploads.get(threadId)) if (released.includes(item.id)) record.recovery.remaining.delete(item.id);
      if (!record.recovery.remaining.size) {
        requireOwner();
        submissions.receipt(threadId, { requestId, status: "cancelled" });
        submissions.finishCancelledUpload(threadId, requestId);
        finish(record, "cancelled"); return remainingBefore;
      }
      submissions.updateUpload(threadId, requestId, {
        progress: { total: record.files.length, uploaded: record.files.length, status: "failed", code: "attachment_recovery_pending" },
        descriptors: record.recovery.attachments.map(item => ({ id: item.id, name: item.name, size: item.size, mime: item.mime, status: "uploaded" })),
      });
      submissions.receipt(threadId, { requestId, status: "cancelled" });
      throw Object.assign(new Error((recoveryFailure as Error)?.message || "发送已取消，附件暂未取回，请重试取消。"), { code: "attachment_recovery_pending" });
    }
    const cleaned = record ? await uploads.cancelSubmission(threadId, requestId) : true;
    requireOwner();
    if (!cleaned && record) {
      submissions.updateUpload(threadId, requestId, { progress: { total: record.files.length, uploaded: 0, status: "failed", code: "attachment_cleanup_pending" },
        descriptors: uploads.getSubmission(threadId, requestId).map(item => ({ id: item.id, name: item.name, size: item.size, mime: item.mime, status: "unknown", error: item.error })) });
      submissions.receipt(threadId, { requestId, status: "cancelled" });
      throw new Error("发送已取消，附件清理结果待核对，请重试取消。");
    }
    submissions.receipt(threadId, { requestId, status: "cancelled" });
    submissions.finishCancelledUpload(threadId, requestId);
    if (record) { uploads.completeSubmission(threadId, requestId); finish(record, "cancelled"); }
  } catch (failure) { if (record) schedule(record); throw failure; }
  };
  const manager = {
    uploads,
    hasSubmission(threadId: string, requestId: string) { return records.has(key(threadId, requestId)); },
    // App owns the lease, not an individual conversation. StrictMode replaces
    // an effect lease synchronously before this microtask can destroy its work.
    retainOwner(): () => void {
      if (disposed) throw new Error("会话已关闭，请重新打开后继续。");
      ownerCount++; suspended = false;
      for (const record of records.values()) schedule(record);
      let released = false;
      return () => {
        if (released || disposed) return;
        released = true;
        if (--ownerCount) return;
        suspended = true;
        for (const record of records.values()) clearTimeout(record.timer);
        queueMicrotask(() => { if (!ownerCount && suspended) manager.dispose(); });
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true; suspended = true; ownerCount = 0;
      for (const record of records.values()) stop(record, "disposed");
      records.clear(); lifetime.abort(); uploads.dispose();
      const stores = owners.get(drafts);
      if (stores?.get(submissions) === manager) stores.delete(submissions);
    },
    async restore(threadId: string, requestId: string, text: string, currentView: () => boolean = () => true) {
      requireOwner();
      const record = records.get(key(threadId, requestId));
      if (!record) return null;
      if (record.machine !== machine() || record.reservation === "reserved") throw new Error("请先核对原消息的提交结果。");
      if (record.reservation !== "rejected" || record.state !== "active") throw new Error("请先核对原消息的提交结果。");
      const receipt = await request.receipt(threadId, requestId, lifetime.signal);
      requireOwner();
      if (!currentView() || !["rejected", "not_found"].includes(receipt.status) || receipt.requestId !== requestId)
        throw new Error("请先核对原消息的提交结果。");
      const value = uploads.restoreSubmission(threadId, requestId, text);
      finish(record, "restored"); return value;
    },
    async submit(intent: Intent) {
      requireOwner();
      const identity = key(intent.threadId, intent.requestId);
      if (records.has(identity)) throw new Error("这条消息已提交，请核对原记录。");
      const files = uploads.takeSubmission(intent.threadId, intent.requestId, intent.files);
      const record: UploadSubmission = { ...intent, files: files.map(item => ({ ...item, file: undefined })), machine: machine(), state: "active", reservation: "posting" };
      records.set(identity, record);
      submissions.seed({ threadId: intent.threadId, requestId: intent.requestId, text: intent.text, status: "uploading",
        attachments: attachmentRefs(files), uploadProgress: { total: files.length, uploaded: attachmentRefs(files).length, status: "uploading" },
        attachmentUploads: files.map(file => ({ id: file.id, name: file.name, size: file.size, mime: file.mime,
          status: file.status === "removing" ? "unknown" : file.status })),
      });
      record.unsubscribe = uploads.subscribeSubmission(intent.threadId, intent.requestId, () => { publish(record); schedule(record); });
      publish(record);
      try {
        const receipt = await withSubmittedQueryPost(submissions, intent.threadId, intent.requestId, () => request.reserve({ ...intent, files }, lifetime.signal));
        if (receipt.requestId !== intent.requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
        if (record.reservation === "posting") record.reservation = ["rejected", "not_found"].includes(receipt.status) ? "rejected" : "unknown";
        apply(record, receipt); return receipt;
      } catch (failure) {
        if (current(record)) {
          const status = (failure as Error & { status?: number }).status;
          if (record.reservation !== "reserved") record.reservation = status && status < 500 ? "rejected" : "unknown";
          submissions.receipt(intent.threadId, { requestId: intent.requestId, status: status && status < 500 ? "rejected" : "unknown" });
          if (record.reservation === "rejected") { clearTimeout(record.timer); record.unsubscribe?.(); record.unsubscribe = undefined; }
          else schedule(record);
        }
        throw failure;
      }
    },
    actions(threadId: string): SubmittedUploadActions {
      const find = (requestId: string) => records.get(key(threadId, requestId));
      const actions: SubmittedUploadActions = {
        owns: requestId => records.has(key(threadId, requestId)),
        retry: async requestId => {
          requireOwner();
          const record = find(requestId);
          if (!record || record.state !== "active" || !current(record)) throw new Error("未完成的附件需重新选择，请取消后重新提交。");
          if (!hasReservation(record)) { await check(record); if (!hasReservation(record)) return; }
          uploads.retrySubmission(threadId, requestId); publish(record); schedule(record);
        },
        check: async requestId => {
          requireOwner();
          const record = find(requestId);
          if (record?.state === "cancelling" && current(record)) { await actions.cancel(requestId); return; }
          if (record && current(record)) { await uploads.checkSubmission(threadId, requestId); publish(record); await check(record); }
          else {
            const receipt = await request.receipt(threadId, requestId, lifetime.signal);
            requireOwner();
            submissions.receipt(threadId, receipt);
          }
        },
        cancel: requestId => cancel(threadId, requestId),
      };
      return actions;
    },
    async dismiss(threadId: string, requestId: string) {
      requireOwner();
      const record = records.get(key(threadId, requestId));
      const entry = submissions.getThread(threadId).find(item => item.requestId === requestId);
      if (record && entry && ["rejected", "not_found", "cancelled"].includes(entry.status)) await cancel(threadId, requestId);
      submissions.dismiss(threadId, requestId);
    },
  };
  return manager;
}
export type AttachmentSubmissionManager = ReturnType<typeof createAttachmentSubmissionManager>;
const owners = new WeakMap<Map<string, QueryDraft>, WeakMap<SubmittedQueryStore, AttachmentSubmissionManager>>();
export function attachmentSubmissionManager(drafts: Map<string, QueryDraft>, submissions: SubmittedQueryStore) {
  let stores = owners.get(drafts);
  if (!stores) { stores = new WeakMap(); owners.set(drafts, stores); }
  let manager = stores.get(submissions);
  if (!manager) { manager = createAttachmentSubmissionManager(drafts, submissions); stores.set(submissions, manager); }
  return manager;
}

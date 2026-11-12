import { api } from "./api.ts";
import { attachmentDraftController, attachmentRefs, readyAttachments, validateAttachment, type AttachmentDraftController, type DraftAttachment } from "./attachments.ts";
import { currentMachineId, type MachineId } from "./machineScope.ts";
import type { QueryDraft } from "./Conversation";
import type { SubmissionReceipt } from "./submissionReceipt.ts";
import { withSubmittedQueryPost, type SubmittedQueryStore, type SubmittedUploadActions } from "./submittedQueries.ts";

type Intent = { threadId: string; requestId: string; text: string; files: readonly DraftAttachment[]; autoDirect: boolean; enqueue: boolean };
type Record = Intent & { machine: MachineId | null; cancelled: boolean; reserved: boolean; done: boolean; unsubscribe?: () => void;
  timer?: ReturnType<typeof setTimeout>; read?: Promise<SubmissionReceipt>; revision?: number };
type Transport = {
  reserve: (intent: Intent) => Promise<SubmissionReceipt>;
  receipt: (threadId: string, requestId: string) => Promise<SubmissionReceipt>;
  cancel: (threadId: string, requestId: string, revision: number) => Promise<unknown>;
};
const transport: Transport = {
  reserve: intent => api(`/api/tasks/${intent.threadId}/messages`, "POST", {
    text: intent.text, requestId: intent.requestId, autoDirect: intent.autoDirect, ...(intent.enqueue ? { enqueue: true } : {}),
    attachmentUploads: intent.files.map(file => ({ id: file.id, name: file.name, size: file.size, mime: file.mime,
      ...(file.sourceSha256 ? { sourceSha256: file.sourceSha256 } : {}) })),
  }, { timeoutMs: 18000 }),
  receipt: (threadId, requestId) => api(`/api/tasks/${threadId}/messages/${requestId}`, "GET", undefined, { timeoutMs: 10000 }),
  cancel: (threadId, requestId, revision) => api(`/api/tasks/${threadId}/outbox/${requestId}`, "DELETE", { expectedRevision: revision }),
};

// This owner outlives the inspector. The draft Map holds files separately from
// the stable submission body; remote receipt reads never repeat its POST.
export function createAttachmentSubmissionManager(drafts: Map<string, QueryDraft>, submissions: SubmittedQueryStore,
  uploads: AttachmentDraftController = attachmentDraftController(drafts), request: Transport = transport,
  options: { machine?: () => MachineId | null; intervalMs?: number } = {}) {
  const records = new Map<string, Record>(), machine = options.machine ?? currentMachineId;
  const key = (threadId: string, requestId: string) => JSON.stringify([threadId, requestId]);
  const current = (record: Record) => !record.done && record.machine === machine();
  const stop = (record: Record) => { record.done = true; clearTimeout(record.timer); record.unsubscribe?.(); record.unsubscribe = undefined; };
  const publish = (record: Record) => {
    if (!current(record) || record.cancelled) return;
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
  const schedule = (record: Record) => {
    clearTimeout(record.timer);
    if (current(record)) record.timer = setTimeout(() => { void check(record).catch(() => {}); }, options.intervalMs ?? 1500);
  };
  const apply = (record: Record, receipt: SubmissionReceipt) => {
    if (!current(record) || receipt.requestId !== record.requestId) return;
    if (Number.isInteger(receipt.queueRevision)) record.revision = receipt.queueRevision;
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
      stop(record);
      const cleanup = () => {
        const items = uploads.getSubmission(record.threadId, record.requestId);
        if (!items.length || readyAttachments(items)) {
          try { uploads.completeSubmission(record.threadId, record.requestId); } catch { return; }
          record.unsubscribe?.(); record.unsubscribe = undefined; records.delete(key(record.threadId, record.requestId));
        }
      };
      record.unsubscribe = uploads.subscribeSubmission(record.threadId, record.requestId, cleanup);
      cleanup(); return;
    }
    if (record.cancelled && receipt.status !== "cancelled") { submissions.receipt(record.threadId, receipt); schedule(record); return; }
    submissions.receipt(record.threadId, receipt);
    if (["queued", "editing", "pending", "accepted"].includes(receipt.status) && receipt.uploadProgress) {
      record.reserved = true;
      if (receipt.status !== "editing") uploads.resumeSubmission(record.threadId, record.requestId);
    }
    if (receipt.status === "cancelled" && !uploads.getSubmission(record.threadId, record.requestId).length) stop(record);
    else schedule(record);
  };
  const check = (record: Record): Promise<SubmissionReceipt> => {
    if (record.read) return record.read;
    if (!current(record)) return Promise.reject(new Error("提交所属电脑已变化，请重新核对。"));
    const pending = request.receipt(record.threadId, record.requestId).then(receipt => {
      if (receipt.requestId !== record.requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
      apply(record, receipt); return receipt;
    }).finally(() => { if (record.read === pending) record.read = undefined; schedule(record); });
    record.read = pending; return pending;
  };
  return {
    uploads,
    hasSubmission(threadId: string, requestId: string) { return records.has(key(threadId, requestId)); },
    dispose() { for (const record of records.values()) stop(record); },
    async restore(threadId: string, requestId: string, text: string, currentView: () => boolean = () => true) {
      const record = records.get(key(threadId, requestId));
      if (!record || record.reserved || record.machine !== machine()) return null;
      const receipt = await request.receipt(threadId, requestId);
      if (!currentView() || !["rejected", "not_found"].includes(receipt.status) || receipt.requestId !== requestId)
        throw new Error("请先核对原消息的提交结果。");
      const value = uploads.restoreSubmission(threadId, requestId, text);
      stop(record); records.delete(key(threadId, requestId)); return value;
    },
    async submit(intent: Intent) {
      const identity = key(intent.threadId, intent.requestId);
      if (records.has(identity)) throw new Error("这条消息已提交，请核对原记录。");
      const files = uploads.takeSubmission(intent.threadId, intent.requestId, intent.files);
      const record: Record = { ...intent, files: files.map(item => ({ ...item, file: undefined })), machine: machine(), cancelled: false, reserved: false, done: false };
      records.set(identity, record);
      submissions.seed({ threadId: intent.threadId, requestId: intent.requestId, text: intent.text, status: "uploading",
        attachments: attachmentRefs(files), uploadProgress: { total: files.length, uploaded: attachmentRefs(files).length, status: "uploading" },
        attachmentUploads: files.map(file => ({ id: file.id, name: file.name, size: file.size, mime: file.mime,
          status: file.status === "removing" ? "unknown" : file.status })),
      });
      record.unsubscribe = uploads.subscribeSubmission(intent.threadId, intent.requestId, () => { publish(record); schedule(record); });
      publish(record);
      try {
        const receipt = await withSubmittedQueryPost(submissions, intent.threadId, intent.requestId, () => request.reserve({ ...intent, files }));
        if (receipt.requestId !== intent.requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
        apply(record, receipt); return receipt;
      } catch (failure) {
        if (current(record)) {
          const status = (failure as Error & { status?: number }).status;
          submissions.receipt(intent.threadId, { requestId: intent.requestId, status: status && status < 500 ? "rejected" : "unknown" });
          if (status && status < 500) { record.unsubscribe?.(); record.unsubscribe = undefined; }
          else schedule(record);
        }
        throw failure;
      }
    },
    actions(threadId: string): SubmittedUploadActions {
      const find = (requestId: string) => records.get(key(threadId, requestId));
      const actions: SubmittedUploadActions = {
        retry: async requestId => {
          const record = find(requestId);
          if (!record || record.cancelled || !current(record)) throw new Error("未完成的附件需重新选择，请取消后重新提交。");
          if (!record.reserved) { await check(record); if (!record.reserved) return; }
          uploads.retrySubmission(threadId, requestId); publish(record); schedule(record);
        },
        check: async requestId => {
          const record = find(requestId);
          if (record?.cancelled && current(record)) { await actions.cancel(requestId); return; }
          if (record && current(record)) { await uploads.checkSubmission(threadId, requestId); publish(record); await check(record); }
          else {
            const receipt = await request.receipt(threadId, requestId);
            submissions.receipt(threadId, receipt);
          }
        },
        cancel: async requestId => {
          const record = find(requestId);
          if (record && record.machine !== machine()) throw new Error("提交所属电脑已变化，请重新核对。");
          if (record) { record.cancelled = true; clearTimeout(record.timer); record.unsubscribe?.(); record.unsubscribe = undefined; }
          try {
            const receipt = await request.receipt(threadId, requestId);
            if (receipt.status === "accepted") { if (record) apply(record, receipt); else submissions.receipt(threadId, receipt); throw new Error("这条消息已发送，无法取消。"); }
            if (receipt.status !== "cancelled") {
              if (!Number.isInteger(receipt.queueRevision)) throw new Error("提交状态仍待核对，请稍后再取消。");
              await request.cancel(threadId, requestId, receipt.queueRevision!);
            }
            const cleaned = record ? await uploads.cancelSubmission(threadId, requestId) : true;
            if (!cleaned && record) {
              submissions.updateUpload(threadId, requestId, { progress: { total: record.files.length, uploaded: 0, status: "failed", code: "attachment_cleanup_pending" },
                descriptors: uploads.getSubmission(threadId, requestId).map(item => ({ id: item.id, name: item.name, size: item.size, mime: item.mime, status: "unknown", error: item.error })) });
              submissions.receipt(threadId, { requestId, status: "cancelled" });
              throw new Error("发送已取消，附件清理结果待核对，请重试取消。");
            }
            submissions.receipt(threadId, { requestId, status: "cancelled" });
            submissions.finishCancelledUpload(threadId, requestId);
            if (record) { stop(record); uploads.completeSubmission(threadId, requestId); records.delete(key(threadId, requestId)); }
          } catch (failure) { if (record) schedule(record); throw failure; }
        },
      };
      return actions;
    },
  };
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

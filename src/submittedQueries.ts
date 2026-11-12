import type { Message, QueuedMessage } from "./conversationFeed";
import { sameAttachments, validateAttachment, type PublicAttachment } from "./attachments.ts";

export type AttachmentUploadProgress = Readonly<{ total: number; uploaded: number; status: "uploading" | "ready" | "failed"; code?: string }>;
export type AttachmentUploadDescriptor = Readonly<{
  id: string; name: string; size: number; mime: string;
  status?: "missing" | "queued" | "uploading" | "uploaded" | "failed" | "unknown"; error?: string;
}>;
export type SubmittedUploadActions = {
  owns?: (requestId: string) => boolean;
  retry: (requestId: string) => Promise<void> | void;
  cancel: (requestId: string) => Promise<number | void> | number | void;
  check: (requestId: string) => Promise<void> | void;
};
export type SubmittedQueryStatus = "uploading" | "upload_failed" | "submitting" | "connecting" | "pending" | "queued" | "editing" | "accepted" | "unknown" | "rejected" | "not_found" | "cancelled" | "not_queued";
export type SubmittedQuery = Readonly<{
  threadId: string;
  requestId: string;
  text: string;
  status: SubmittedQueryStatus;
  createdAt: number;
  code?: string;
  queueRevision?: number;
  echoed?: boolean;
  dismissed?: boolean;
  bodyReleased?: boolean;
  attachments?: readonly PublicAttachment[];
  uploadProgress?: AttachmentUploadProgress;
  attachmentUploads?: readonly AttachmentUploadDescriptor[];
}>;
export type SubmittedQuerySeed = Pick<SubmittedQuery, "threadId" | "requestId" | "text" | "status" | "attachments" | "uploadProgress" | "attachmentUploads"> & { createdAt?: number; code?: string };
export type SubmittedQueryReceipt = { requestId: string; status: SubmittedQueryStatus; code?: string; uploadProgress?: AttachmentUploadProgress };
export type SubmittedUploadUpdate = { progress?: AttachmentUploadProgress; descriptors?: readonly AttachmentUploadDescriptor[]; attachments?: readonly PublicAttachment[] };

type UploadMetadata = Pick<SubmittedQuery, "uploadProgress" | "attachmentUploads" | "attachments">;
export function expectedSubmittedAttachmentCount(entry: UploadMetadata) {
  return Math.max(entry.uploadProgress?.total ?? 0, entry.attachmentUploads?.length ?? 0, entry.attachments?.length ?? 0);
}
export function completeSubmittedAttachments(entry: UploadMetadata, attachments: readonly PublicAttachment[] = []) {
  const expected = expectedSubmittedAttachmentCount(entry);
  return expected === (entry.attachments?.length ?? 0) && expected === attachments.length && sameAttachments(entry.attachments, attachments);
}
export function submittedQueryDisplayStatus(entry: Pick<SubmittedQuery, "status" | "uploadProgress">): SubmittedQueryStatus {
  if (!["uploading", "upload_failed", "queued", "submitting", "connecting", "not_queued"].includes(entry.status)) return entry.status;
  if (entry.uploadProgress?.status === "failed") return "upload_failed";
  if (entry.uploadProgress && entry.uploadProgress.status !== "ready") return "uploading";
  if (entry.uploadProgress?.status === "ready" && ["uploading", "upload_failed"].includes(entry.status)) return "queued";
  return entry.status;
}
const uploadRecoveryCodes = new Set(["attachment_cleanup_pending", "attachment_recovery_pending"]);
const uploadNeedsRecovery = (entry: Pick<SubmittedQuery, "uploadProgress">) => uploadRecoveryCodes.has(entry.uploadProgress?.code ?? "");
export function pendingSubmittedUpload(entry: Pick<SubmittedQuery, "status" | "uploadProgress">) {
  if (entry.status === "cancelled" && uploadNeedsRecovery(entry)) return true;
  return !["accepted", "cancelled"].includes(entry.status) && !!entry.uploadProgress && entry.uploadProgress.status !== "ready";
}
export function submittedUploadNeedsCheck(entry: Pick<SubmittedQuery, "attachmentUploads" | "uploadProgress">) {
  return entry.attachmentUploads?.some(item => item.status === "unknown") || entry.uploadProgress?.code === "attachment_upload_unknown";
}
export function submittedUploadCanRetry(entry: Pick<SubmittedQuery, "attachmentUploads" | "uploadProgress"> & { status?: SubmittedQueryStatus }) {
  return !["unknown", "pending"].includes(entry.status ?? "") && !submittedUploadNeedsCheck(entry) && !!entry.attachmentUploads?.some(item => item.status === "failed");
}
const copyProgress = (progress: AttachmentUploadProgress) => Object.freeze({ total: progress.total, uploaded: progress.uploaded, status: progress.status,
  ...(progress.code === undefined ? {} : { code: progress.code }) });
const copyDescriptors = (items: readonly AttachmentUploadDescriptor[]) => Object.freeze(items.map(item => Object.freeze({
  id: item.id, name: item.name, size: item.size, mime: item.mime,
  ...(item.status === undefined ? {} : { status: item.status }), ...(item.error === undefined ? {} : { error: item.error }),
})));
const mergeDescriptors = (known: readonly AttachmentUploadDescriptor[] | undefined, incoming: readonly AttachmentUploadDescriptor[] | undefined) => {
  if (!incoming) return known;
  if (!known?.length) return copyDescriptors(incoming);
  return copyDescriptors(known.map(item => {
    const next = incoming.find(value => value.id === item.id);
    // The server knows disk state, while this view knows whether a PUT result
    // was uncertain or failed locally. Missing bytes cannot clear that fact.
    if (!next || ["unknown", "failed"].includes(item.status ?? "") && ["missing", "queued", "uploading"].includes(next.status ?? "")) return item;
    return { ...item, status: next.status, error: next.error };
  }));
};
const progressWithLocalFailure = (progress: AttachmentUploadProgress | undefined, descriptors: readonly AttachmentUploadDescriptor[] | undefined) =>
  progress && progress.status !== "ready" && descriptors?.some(item => item.status === "failed")
    ? copyProgress({ ...progress, status: "failed" }) : progress;
// Keep only public capability metadata. Files and local filesystem fields stay
// with the upload controller, including when a caller passes a richer object.
const copyPublicAttachment = (item: PublicAttachment, threadId: string) => validateAttachment({
  id: item.id, name: item.name, size: item.size, mime: item.mime, kind: item.kind, url: item.url, sha256: item.sha256,
  ...(item.sourceSha256 === undefined ? {} : { sourceSha256: item.sourceSha256 }),
  ...(item.sourceSize === undefined ? {} : { sourceSize: item.sourceSize }),
  ...(item.previewUrl === undefined ? {} : { previewUrl: item.previewUrl }),
  ...(item.previewSha256 === undefined ? {} : { previewSha256: item.previewSha256 }),
  ...(item.previewMime === undefined ? {} : { previewMime: item.previewMime }),
  ...(item.previewSize === undefined ? {} : { previewSize: item.previewSize }),
}, threadId);
const sameUploadMetadata = (a: UploadMetadata, b: UploadMetadata) => sameAttachments(a.attachments, b.attachments)
  && JSON.stringify(a.uploadProgress) === JSON.stringify(b.uploadProgress) && JSON.stringify(a.attachmentUploads) === JSON.stringify(b.attachmentUploads);

const empty: readonly SubmittedQuery[] = Object.freeze([]);
const settled = new Set<SubmittedQueryStatus>(["accepted", "cancelled"]);
const definite = new Set<SubmittedQueryStatus>(["accepted", "rejected", "not_found", "cancelled"]);
const submissionKey = (threadId: string, requestId: string) => JSON.stringify([threadId, requestId]);
export const submittedQueryTextLimits = { entries: 20, bytes: 256 * 1024 } as const;

// Identity confirms which submission this is; exact complete text confirms the
// visible history can replace its full local copy. Text alone confirms neither.
export function completeSubmittedEcho(entry: Pick<SubmittedQuery, "requestId" | "text" | "status" | "attachments" | "bodyReleased" | "uploadProgress" | "attachmentUploads">, messages: readonly Message[]) {
  return !entry.bodyReleased && entry.status === "accepted" && messages.some(message => message.role === "user" && message.clientMessageId === entry.requestId
    && !message.truncated && message.text.trim() === entry.text.trim() && completeSubmittedAttachments(entry, message.attachments));
}

// Exact client message identity can carry known attachment display metadata
// while the transcript catches up. This never changes a submission receipt.
export function withSubmittedAttachments(messages: readonly Message[], entries: readonly SubmittedQuery[]): Message[] {
  return messages.map(message => {
    if (message.role !== "user" || !message.clientMessageId || message.attachments?.length) return message;
    const entry = entries.find(item => item.requestId === message.clientMessageId);
    return entry?.attachments?.length ? { ...message, attachments: [...entry.attachments] } : message;
  });
}

// Session memory only. A submission's text is captured separately from the next
// draft. Only a newer, saved outbox revision may replace its immutable snapshot.
export function createSubmittedQueryStore() {
  const threads = new Map<string, readonly SubmittedQuery[]>();
  const listeners = new Set<() => void>();
  const activePosts = new Map<string, Set<symbol>>();
  // Completion order belongs to retained text, not to requests still awaiting
  // an outcome. Identity tombstones have no TTL: old queue snapshots can arrive
  // after a conversation's reading cache has already been evicted.
  const completed = new Map<string, { threadId: string; requestId: string }>();
  const getThread = (threadId: string) => threads.get(threadId) ?? empty;
  const releasable = (entry: SubmittedQuery) => !entry.bodyReleased &&
    (entry.status === "accepted" && entry.echoed || entry.dismissed && definite.has(entry.status));
  const compact = () => {
    const candidates: { key: string; threadId: string; requestId: string; bytes: number }[] = [];
    for (const [key, identity] of completed) {
      const entry = getThread(identity.threadId).find(value => value.requestId === identity.requestId);
      if (!entry || !releasable(entry)) { completed.delete(key); continue; }
      // A POST owns its captured body until every overlapping owner settles.
      // It is not part of the bounded terminal-text cache until then.
      if (!activePosts.has(key)) candidates.push({ key, ...identity, bytes: entry.text.length * 2 });
    }
    let count = 0, bytes = 0;
    const released = new Map<string, Set<string>>();
    for (const entry of candidates.reverse()) {
      if (count < submittedQueryTextLimits.entries && bytes + entry.bytes <= submittedQueryTextLimits.bytes) {
        count++; bytes += entry.bytes; continue;
      }
      const ids = released.get(entry.threadId) ?? new Set<string>();
      ids.add(entry.requestId); released.set(entry.threadId, ids); completed.delete(entry.key);
    }
    for (const [threadId, ids] of released) threads.set(threadId, Object.freeze(getThread(threadId).map(entry =>
      ids.has(entry.requestId) ? Object.freeze({ ...entry, text: "", bodyReleased: true }) : entry)));
    return released.size > 0;
  };
  const change = (threadId: string, update: (entries: readonly SubmittedQuery[]) => readonly SubmittedQuery[]) => {
    const previous = getThread(threadId), next = update(previous);
    if (next === previous) return;
    threads.set(threadId, Object.freeze(next));
    for (const entry of next) {
      const key = submissionKey(threadId, entry.requestId);
      if (releasable(entry) && !completed.has(key)) completed.set(key, { threadId, requestId: entry.requestId });
    }
    compact();
    listeners.forEach(listener => listener());
  };
  const receipt = (threadId: string, result: SubmittedQueryReceipt) => change(threadId, entries => {
    const index = entries.findIndex(entry => entry.requestId === result.requestId);
    if (index < 0) return entries;
    const entry = entries[index];
    if (result.status === "not_found" && activePosts.has(submissionKey(threadId, result.requestId))) result = { requestId: result.requestId, status: "unknown" };
    // A dismissed definite outcome may receive a late acceptance, but stale
    // queued/unknown snapshots cannot resurrect discarded text or controls.
    if (entry.dismissed && !definite.has(result.status)) return entries;
    // An early native echo/acceptance wins over late HTTP or queue snapshots.
    if (settled.has(entry.status) && result.status !== entry.status) return entries;
    const uploadProgress = progressWithLocalFailure(entry.uploadProgress?.status === "ready" && result.uploadProgress?.status !== "ready" ? entry.uploadProgress
      : result.uploadProgress ? copyProgress(result.uploadProgress) : entry.uploadProgress, entry.attachmentUploads);
    const status = submittedQueryDisplayStatus({ status: result.status, uploadProgress });
    if (entry.status === status && entry.code === result.code && JSON.stringify(entry.uploadProgress) === JSON.stringify(uploadProgress)) return entries;
    return entries.map((value, i) => i === index ? Object.freeze({ ...entry, status, code: result.code, uploadProgress }) : value);
  });
  return {
    getThread,
    beginPost(threadId: string, requestId: string) {
      const key = submissionKey(threadId, requestId), token = Symbol();
      const posts = activePosts.get(key) ?? new Set<symbol>();
      posts.add(token); activePosts.set(key, posts);
      return () => {
        posts.delete(token);
        if (!posts.size && activePosts.get(key) === posts) {
          activePosts.delete(key);
          if (compact()) listeners.forEach(listener => listener());
        }
      };
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    seed(input: SubmittedQuerySeed) {
      const existing = getThread(input.threadId).find(entry => entry.requestId === input.requestId);
      change(input.threadId, entries => entries.some(entry => entry.requestId === input.requestId) ? entries
        : [...entries, Object.freeze({ ...input, status: submittedQueryDisplayStatus(input),
          ...(input.attachments ? { attachments: Object.freeze([...input.attachments]) } : {}),
          ...(input.uploadProgress ? { uploadProgress: copyProgress(input.uploadProgress) } : {}),
          ...(input.attachmentUploads ? { attachmentUploads: copyDescriptors(input.attachmentUploads) } : {}), createdAt: input.createdAt ?? Date.now() })]);
      if (existing?.queueRevision === undefined || settled.has(input.status)) receipt(input.threadId, input);
    },
    receipt,
    finishCancelledUpload(threadId: string, requestId: string) {
      change(threadId, entries => entries.map(entry => entry.requestId === requestId && entry.status === "cancelled"
        && uploadNeedsRecovery(entry)
        ? Object.freeze({ ...entry, uploadProgress: undefined, attachmentUploads: undefined }) : entry));
    },
    updateUpload(threadId: string, requestId: string, update: SubmittedUploadUpdate) {
      change(threadId, entries => {
        const index = entries.findIndex(entry => entry.requestId === requestId), entry = entries[index];
        if (!entry || entry.dismissed || entry.echoed || entry.bodyReleased || entry.status === "cancelled"
          && !(uploadNeedsRecovery(entry) && uploadRecoveryCodes.has(update.progress?.code ?? ""))) return entries;
        const descriptors = entry.status !== "accepted" && update.descriptors ? copyDescriptors(update.descriptors) : entry.attachmentUploads;
        const incoming = update.attachments ? [...new Map(update.attachments.map(item => {
          const copy = copyPublicAttachment(item, threadId); return [copy.id, copy] as const;
        })).values()] : undefined;
        for (const item of incoming ?? []) {
          if (descriptors?.length && !descriptors.some(descriptor => descriptor.id === item.id)
            || entry.attachments?.some(known => known.id === item.id && known.sha256 !== item.sha256)) throw new Error("附件回执不匹配，请核对上传状态。");
        }
        const attachments = incoming ? Object.freeze([...(entry.attachments ?? []), ...incoming.filter(item => !entry.attachments?.some(known => known.id === item.id))]) : entry.attachments;
        let uploadProgress = entry.status !== "accepted" && update.progress ? copyProgress(update.progress) : entry.uploadProgress;
        if (entry.uploadProgress?.status === "ready" && !uploadRecoveryCodes.has(update.progress?.code ?? "")) uploadProgress = entry.uploadProgress;
        else if (uploadProgress && entry.uploadProgress?.total === uploadProgress.total && entry.uploadProgress.uploaded > uploadProgress.uploaded)
          uploadProgress = copyProgress({ ...uploadProgress, uploaded: entry.uploadProgress.uploaded });
        const next = { ...entry, uploadProgress, attachmentUploads: descriptors, attachments };
        const status = entry.status === "accepted" ? "accepted" : submittedQueryDisplayStatus(next);
        if (entry.status === status && sameUploadMetadata(entry, next)) return entries;
        return entries.map((value, i) => i === index ? Object.freeze({ ...next, status }) : value);
      });
    },
    observeQueue(threadId: string, items: readonly QueuedMessage[]) {
      change(threadId, entries => {
        let next = entries;
        for (const item of items) {
          const index = next.findIndex(entry => entry.requestId === item.id), entry = next[index];
          if (!entry) {
            next = [...next, Object.freeze({ threadId, requestId: item.id, text: item.text, status: submittedQueryDisplayStatus(item), createdAt: item.createdAt, queueRevision: item.revision, attachments: item.attachments,
              uploadProgress: item.uploadProgress ? copyProgress(item.uploadProgress) : undefined, attachmentUploads: item.attachmentUploads ? copyDescriptors(item.attachmentUploads) : undefined })];
            continue;
          }
          if (entry.echoed || entry.dismissed || entry.bodyReleased || entry.status === "cancelled" || (entry.queueRevision ?? -1) > item.revision) continue;
          if (entry.status === "accepted") {
            // A saved edit can be acknowledged after auto-dispatch already
            // accepted it. Keep acceptance while adopting that newer revision.
            if ((entry.queueRevision ?? -1) < item.revision)
              next = next.map((value, i) => i === index ? Object.freeze({ ...entry, text: item.text, queueRevision: item.revision, attachments: item.attachments?.length && item.attachments.length >= (entry.attachments?.length ?? 0) ? item.attachments : entry.attachments }) : value);
            continue;
          }
          if (entry.queueRevision === item.revision && (
            (["pending", "unknown", "rejected", "editing"].includes(entry.status) && item.status === "queued") ||
            (["unknown", "rejected", "editing"].includes(entry.status) && item.status === "pending"))) continue;
          const text = (entry.queueRevision ?? -1) < item.revision ? item.text : entry.text;
          const attachments = item.attachments?.length && item.attachments.length >= (entry.attachments?.length ?? 0) ? item.attachments : entry.attachments;
          const attachmentUploads = mergeDescriptors(entry.attachmentUploads, item.attachmentUploads);
          const uploadProgress = progressWithLocalFailure(entry.uploadProgress?.status === "ready" || !item.uploadProgress || (entry.uploadProgress?.uploaded ?? -1) > item.uploadProgress.uploaded
            ? entry.uploadProgress : copyProgress(item.uploadProgress), attachmentUploads);
          const status = submittedQueryDisplayStatus({ status: item.status, uploadProgress });
          if (entry.text === text && entry.status === status && entry.queueRevision === item.revision && entry.code === item.code && sameUploadMetadata(entry, { attachments, uploadProgress, attachmentUploads })) continue;
          next = next.map((value, i) => i === index ? Object.freeze({ ...entry, text, status, queueRevision: item.revision, code: item.code, attachments, uploadProgress, attachmentUploads }) : value);
        }
        // Absence is never delivery evidence. Retain a row until an exact echo
        // appears or the user explicitly dismisses a definite failed/cancelled row.
        return next;
      });
      // Same-revision transitions can be a stale snapshot or a legitimate
      // preflight rollback. Ask the receipt endpoint instead of freezing the UI
      // in pending or trusting an ambiguous queued snapshot as current.
      return items.flatMap(item => {
        const entry = getThread(threadId).find(value => value.requestId === item.id);
        return entry && !entry.echoed && !entry.dismissed && entry.queueRevision === item.revision && entry.status !== item.status
          && !settled.has(entry.status) && !pendingSubmittedUpload(entry) ? [item.id] : [];
      });
    },
    observeMessages(threadId: string, messages: readonly Message[]) {
      change(threadId, entries => {
        if (!entries.some(entry => !entry.echoed && completeSubmittedEcho(entry, messages))) return entries;
        return entries.map(entry => !entry.echoed && completeSubmittedEcho(entry, messages) ? Object.freeze({ ...entry, echoed: true }) : entry);
      });
    },
    dismiss(threadId: string, requestId: string) {
      if (activePosts.has(submissionKey(threadId, requestId))) return;
      change(threadId, entries => entries.map(entry => entry.requestId === requestId && ["rejected", "not_found", "cancelled"].includes(entry.status)
        ? Object.freeze({ ...entry, dismissed: true }) : entry));
    },
    reloadBlocker() {
      return activePosts.size || [...threads.values()].some(entries => entries.some(entry => !entry.echoed && !entry.dismissed && entry.status !== "cancelled"
        && (entry.queueRevision === undefined || ["uploading", "upload_failed", "accepted", "pending", "unknown"].includes(entry.status))))
        ? "还有已提交内容尚未同步或待核对，请处理后再更新。" : null;
    },
    clear() { threads.clear(); activePosts.clear(); completed.clear(); listeners.forEach(listener => listener()); },
  };
}
export type SubmittedQueryStore = ReturnType<typeof createSubmittedQueryStore>;
export function seedSubmittedQuery(store: SubmittedQueryStore, input: SubmittedQuerySeed) { store.seed(input); }
export async function withSubmittedQueryPost<T>(store: SubmittedQueryStore | undefined, threadId: string, requestId: string, post: () => Promise<T>) {
  const finish = store?.beginPost(threadId, requestId);
  try { return await post(); } finally { finish?.(); }
}

export function visibleSubmittedQueries(entries: readonly SubmittedQuery[], messages: readonly Message[], outbox: readonly QueuedMessage[]) {
  const queued = new Set(outbox.map(item => item.id));
  return entries.filter(entry => !entry.echoed && !entry.dismissed && !completeSubmittedEcho(entry, messages) && !queued.has(entry.requestId));
}

export function submittedOutbox(entries: readonly SubmittedQuery[], messages: readonly Message[], outbox: readonly QueuedMessage[]) {
  return outbox.flatMap(item => {
    const entry = entries.find(value => value.requestId === item.id);
    if (entry?.echoed || entry?.dismissed || entry?.status === "cancelled" || completeSubmittedEcho(entry ?? { requestId: item.id, text: item.text, status: item.status, attachments: item.attachments,
      uploadProgress: item.uploadProgress, attachmentUploads: item.attachmentUploads }, messages)) return [];
    if (!entry) return [item];
    const display = { ...item, uploadProgress: entry.uploadProgress ?? item.uploadProgress, attachmentUploads: entry.attachmentUploads ?? item.attachmentUploads,
      attachments: entry.attachments ? [...entry.attachments] : item.attachments };
    if (entry.status === "accepted") return [{ ...display, text: entry.text, status: "accepted" as const }];
    if (["uploading", "upload_failed"].includes(entry.status)) return [{ ...display, text: entry.text, status: "queued" as const, revision: entry.queueRevision ?? item.revision }];
    if (entry.queueRevision !== undefined && entry.queueRevision >= item.revision && ["queued", "editing", "pending", "unknown", "rejected"].includes(entry.status))
      return [{ ...display, text: entry.text, revision: entry.queueRevision, status: entry.status as QueuedMessage["status"] }];
    return [display];
  });
}

export function submittedQueryLabel(entry: SubmittedQuery, connecting = false) {
  if (entry.status === "accepted") return "已发送";
  if (entry.status === "cancelled" && entry.uploadProgress?.code === "attachment_recovery_pending") return "附件暂未取回";
  if (pendingSubmittedUpload(entry) && submittedUploadNeedsCheck(entry)) return "上传结果待核对";
  if (submittedQueryDisplayStatus(entry) === "upload_failed") return "附件上传未完成";
  if (submittedQueryDisplayStatus(entry) === "uploading") return "上传中 {{uploaded}}/{{total}}";
  if (entry.status === "unknown") return "结果待核对";
  if (entry.status === "rejected") return "未能发送";
  if (entry.status === "not_found") return "未找到提交记录";
  if (entry.status === "cancelled") return "已取消发送";
  if (entry.status === "editing") return "编辑中，已暂停发送";
  if (entry.status === "not_queued") return "正在准备首条消息";
  if (entry.status === "connecting" || (entry.status === "queued" && connecting)) return "正在连接 Mac";
  if (entry.status === "queued") return "待发送";
  return "正在提交";
}

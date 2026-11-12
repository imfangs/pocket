import { api } from "./api.ts";
import type { QueryDraft } from "./queryDraft";
import type { PublicAttachment, DraftAttachment } from "./attachmentTypes";
export type { PublicAttachment, DraftAttachment } from "./attachmentTypes";
import { captureDraft } from "./draftTransaction.ts";
import { attachmentHashScheduler, attachmentUploadScheduler, type AttachmentUploadScheduler } from "./attachmentUploadScheduler.ts";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../shared/attachment-limits.mjs";
export { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../shared/attachment-limits.mjs";

const empty: readonly DraftAttachment[] = Object.freeze([]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const attachmentPath = (threadId: string, id: string) => `/api/tasks/${threadId}/attachments/${id}`;
export const hasDraftAttachments = (draft?: { attachments?: readonly unknown[] }) => !!draft?.attachments?.length;
export const canRemoveLocalAttachment = (item: DraftAttachment) => !item.attachment &&
  ["queued", "failed"].includes(item.status) && !item.checking && !item.deletePending;
export function attachmentSize(size: number) { return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${Math.ceil(size / 1024)} KB` : `${size} B`; }
export function safeAttachmentUrl(value: string) { return /^\/api\/tasks\/[a-z0-9-]+\/attachments\/[a-f0-9-]{36}(?:\?[^#]*)?$/i.test(value) ? value : ""; }
export function readyAttachments(items: readonly DraftAttachment[]) { return items.length <= MAX_ATTACHMENTS && items.every(item => item.status === "uploaded" && !!item.attachment); }
export function attachmentRefs(items: readonly DraftAttachment[]): PublicAttachment[] { return items.flatMap(item => item.status === "uploaded" && item.attachment ? [item.attachment] : []); }
export function sameAttachments(a: readonly PublicAttachment[] = [], b: readonly PublicAttachment[] = []) {
  return a.length === b.length && a.every(item => b.some(other => other.id === item.id && other.sha256 === item.sha256));
}
export function validateAttachment(value: PublicAttachment, threadId: string, id = value?.id, source?: Pick<DraftAttachment, "size" | "sourceSha256" | "file">) {
  if (!value || !uuid.test(id || "") || value.id !== id || typeof value.name !== "string" || !value.name ||
      !Number.isSafeInteger(value.size) || value.size < 0 || typeof value.mime !== "string" || !["image", "file"].includes(value.kind) ||
      !/^[a-f0-9]{64}$/i.test(value.sha256) || value.url !== attachmentPath(threadId, id) ||
      value.previewUrl !== undefined && value.previewUrl !== `${attachmentPath(threadId, id)}?preview=1` ||
      value.previewSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(value.previewSha256) ||
      value.previewSize !== undefined && (!Number.isSafeInteger(value.previewSize) || value.previewSize < 1) ||
      value.previewMime !== undefined && !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(value.previewMime)) throw new Error("附件回执不匹配，请核对上传状态。");
  if (source?.file && (value.sourceSize ?? value.size) !== source.size) throw new Error("附件大小与所选文件不一致，请核对上传状态。");
  if (source?.sourceSha256 && (value.sourceSha256 ?? value.sha256) !== source.sourceSha256) throw new Error("附件内容与所选文件不一致，请核对上传状态。");
  return Object.freeze({ ...value });
}
export async function fileSha256(file: File) {
  const bytes = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}
type Transport = {
  upload: (threadId: string, item: DraftAttachment, requestId?: string, signal?: AbortSignal) => Promise<PublicAttachment>;
  metadata: (threadId: string, id: string, signal?: AbortSignal) => Promise<PublicAttachment>;
  list: (threadId: string, signal?: AbortSignal) => Promise<{ attachments: PublicAttachment[] }>;
  remove: (threadId: string, id: string, signal?: AbortSignal) => Promise<unknown>;
};
const attachmentUploadTimeoutMs = 190000;
const boundedSignal = (signal: AbortSignal | undefined, timeout: number) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
const transport: Transport = {
  upload: (threadId, item, requestId, signal) => api(`${attachmentPath(threadId, item.id)}?name=${encodeURIComponent(item.name)}${requestId ? `&requestId=${encodeURIComponent(requestId)}` : ""}`, "PUT", item.file,
    { raw: true, contentType: item.mime, signal: boundedSignal(signal, attachmentUploadTimeoutMs), timeoutMs: attachmentUploadTimeoutMs }),
  metadata: (threadId, id, signal) => api(`${attachmentPath(threadId, id)}?metadata=1`, "GET", undefined, { signal: boundedSignal(signal, 15000) }),
  list: (threadId, signal) => api(`/api/tasks/${threadId}/attachments`, "GET", undefined, { signal: boundedSignal(signal, 15000) }),
  remove: (threadId, id, signal) => api(attachmentPath(threadId, id), "DELETE", undefined, { signal: boundedSignal(signal, 15000) }),
};

// Files stay in memory with the shared controller, independent of a composer.
// Sending transfers exact upload IDs to a request bundle before clearing input.
export function createAttachmentDraftController(drafts: Map<string, QueryDraft>, request: Transport = transport, digest = fileSha256,
  scheduler: AttachmentUploadScheduler = attachmentUploadScheduler, hashScheduler: AttachmentUploadScheduler = attachmentHashScheduler) {
  const listeners = new Map<string, Set<() => void>>(), active = new Map<string, Promise<void>>(), groups = new Map<string, object>();
  const lifetime = new AbortController();
  let disposed = false;
  const requireOwner = () => { if (disposed) throw new Error("会话已关闭，请重新打开后继续。"); };
  type Bundle = { threadId: string; requestId: string; items: readonly DraftAttachment[]; held: boolean; cancelled: boolean };
  const bundles = new Map<string, Bundle>(), owners = new Map<string, string>();
  const submissionListeners = new Map<string, Set<() => void>>(), cancelling = new Map<string, Promise<boolean>>();
  const schedulerOwner = crypto.randomUUID();
  const removing = new Set<string>(), claimed = new Set<string>(), recovering = new Map<string, Promise<void>>();
  const key = (threadId: string, id: string) => `${threadId}/${id}`;
  const scheduledKey = (threadId: string, id: string) => `${schedulerOwner}/${key(threadId, id)}`;
  const cancelQueued = (threadId: string, id: string) => {
    const identity = scheduledKey(threadId, id);
    hashScheduler.cancel(identity); scheduler.cancel(identity);
  };
  const get = (threadId: string) => disposed ? empty : drafts.get(threadId)?.attachments ?? empty;
  const bundleFor = (threadId: string, id: string) => bundles.get(owners.get(key(threadId, id)) ?? "");
  const find = (threadId: string, id: string) => (bundleFor(threadId, id)?.items ?? get(threadId)).find(item => item.id === id);
  const getSubmission = (threadId: string, requestId: string) => bundles.get(key(threadId, requestId))?.items ?? empty;
  const notify = (threadId: string) => { if (!disposed) listeners.get(threadId)?.forEach(listener => listener()); };
  const notifySubmission = (threadId: string, requestId: string) => { if (!disposed) submissionListeners.get(key(threadId, requestId))?.forEach(listener => listener()); };
  const change = (threadId: string, edit: (items: readonly DraftAttachment[]) => readonly DraftAttachment[]) => {
    if (disposed) return;
    const previous = get(threadId), next = edit(previous);
    if (previous === next) return;
    const draft = { ...(drafts.get(threadId) ?? { text: "" }), attachments: next.length ? next : undefined };
    if (draft.text || draft.requestId || next.length) drafts.set(threadId, draft); else drafts.delete(threadId);
    notify(threadId);
  };
  const editItems = (threadId: string, id: string, edit: (items: readonly DraftAttachment[]) => readonly DraftAttachment[]) => {
    if (disposed) return;
    const bundle = bundleFor(threadId, id);
    if (!bundle) { change(threadId, edit); return; }
    const next = edit(bundle.items);
    if (next === bundle.items) return;
    bundle.items = Object.freeze(next); notifySubmission(threadId, bundle.requestId);
  };
  const update = (threadId: string, id: string, edit: (item: DraftAttachment) => DraftAttachment) => editItems(threadId, id, items => {
    if (!items.some(item => item.id === id)) return items;
    return items.map(item => item.id === id ? Object.freeze(edit(item)) : item);
  });
  const drop = (threadId: string, id: string) => editItems(threadId, id, items => items.some(item => item.id === id) ? items.filter(item => item.id !== id) : items);
  const run = (threadId: string, id: string) => {
    if (disposed) return Promise.resolve();
    const identity = key(threadId, id);
    if (active.has(identity)) return active.get(identity)!;
    let group = groups.get(threadId);
    if (!group) { group = {}; groups.set(threadId, group); }
    let finish!: () => void, fail!: (failure: unknown) => void;
    const task = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; })
      .finally(() => { active.delete(identity); pump(threadId); });
    // Register before any synchronous status callback can request removal.
    active.set(identity, task);
    void (async () => {
      let item = find(threadId, id), bundle = bundleFor(threadId, id);
      if (!item?.file || item.status !== "queued") return;
      if (bundle?.held || bundle?.cancelled) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        update(threadId, id, current => ({ ...current, status: "failed", error: "当前离线，联网后可重试上传。" })); return;
      }
      try {
        if (!item.sourceSha256) await hashScheduler.schedule(group, scheduledKey(threadId, id), async () => {
          const current = find(threadId, id), owner = bundleFor(threadId, id);
          if (!current?.file || owner?.held || owner?.cancelled || removing.has(identity)) return;
          const sourceSha256 = await digest(current.file);
          update(threadId, id, value => ({ ...value, sourceSha256 }));
        });
        item = find(threadId, id); bundle = bundleFor(threadId, id);
        if (!item?.sourceSha256 || removing.has(identity) || bundle?.held || bundle?.cancelled) return;
        await scheduler.schedule(group, scheduledKey(threadId, id), async () => {
          let current = find(threadId, id), owner = bundleFor(threadId, id);
          if (!current?.file || current.status !== "queued" || owner?.held || owner?.cancelled || removing.has(identity)) return;
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            update(threadId, id, value => ({ ...value, status: "failed", error: "当前离线，联网后可重试上传。" })); return;
          }
          update(threadId, id, value => ({ ...value, status: "uploading", error: undefined }));
          current = find(threadId, id); owner = bundleFor(threadId, id);
          if (!current || removing.has(identity)) return;
          if (owner?.held || owner?.cancelled) { update(threadId, id, value => ({ ...value, status: "queued" })); return; }
          try {
            const uploaded = validateAttachment(await request.upload(threadId, current, owner?.requestId, lifetime.signal), threadId, id, current);
            update(threadId, id, value => ({ ...value, attachment: uploaded, status: removing.has(identity) ? "removing" : "uploaded", error: undefined }));
          } catch (failure) {
            if (disposed) return;
            const status = (failure as Error & { status?: number }).status, definite = !!status && status < 500 && status !== 409;
            update(threadId, id, value => ({ ...value, status: definite ? "failed" : removing.has(identity) ? "removing" : "unknown",
              error: definite ? (failure as Error).message || "上传未完成，可重试。" : "上传结果待确认，请核对状态。" }));
            if (!definite && !removing.has(identity)) {
              try {
                const source = find(threadId, id);
                if (!source) return;
                const uploaded = validateAttachment(await request.metadata(threadId, id, lifetime.signal), threadId, id, source);
                update(threadId, id, value => ({ ...value, attachment: uploaded, status: removing.has(identity) ? "removing" : "uploaded", error: undefined }));
              } catch { /* Keep the original upload ID and File for a read-only check. */ }
            }
          }
        });
      } catch (failure) {
        update(threadId, id, value => ({ ...value, status: "failed", error: (failure as Error).message || "上传准备未完成，可重试。" }));
      }
    })().then(finish, fail);
    return task;
  };
  const pump = (threadId: string) => {
    if (disposed) return;
    const items = [...get(threadId), ...[...bundles.values()].filter(bundle => bundle.threadId === threadId && !bundle.held && !bundle.cancelled).flatMap(bundle => bundle.items)];
    items.filter(item => item.status === "queued").forEach(item => { void run(threadId, item.id); });
  };
  const controller = {
    get,
    getSubmission,
    hasSubmission: (threadId: string, requestId: string) => bundles.has(key(threadId, requestId)),
    notify,
    // Drop this browser owner's bytes and scheduled work without issuing a
    // remote DELETE or rewriting the Mac's persisted submission outcome.
    dispose() {
      if (disposed) return;
      const identities = new Set([...active.keys(), ...owners.keys()]);
      for (const [threadId, draft] of drafts) for (const item of draft.attachments ?? []) identities.add(key(threadId, item.id));
      disposed = true;
      for (const identity of identities) {
        hashScheduler.cancel(`${schedulerOwner}/${identity}`); scheduler.cancel(`${schedulerOwner}/${identity}`);
      }
      lifetime.abort();
      for (const [threadId, draft] of drafts) if (draft.attachments?.length) {
        const { attachments: _files, ...remaining } = draft;
        drafts.set(threadId, remaining);
      }
      listeners.clear(); submissionListeners.clear(); bundles.clear(); owners.clear(); active.clear(); groups.clear();
      cancelling.clear(); removing.clear(); claimed.clear(); recovering.clear();
      if (controllers.get(drafts) === controller) controllers.delete(drafts);
    },
    subscribe(threadId: string, listener: () => void) {
      if (disposed) return () => {};
      const subscribers = listeners.get(threadId) ?? new Set(); subscribers.add(listener); listeners.set(threadId, subscribers);
      return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(threadId); };
    },
    subscribeSubmission(threadId: string, requestId: string, listener: () => void) {
      if (disposed) return () => {};
      const identity = key(threadId, requestId), subscribers = submissionListeners.get(identity) ?? new Set();
      subscribers.add(listener); submissionListeners.set(identity, subscribers);
      return () => { subscribers.delete(listener); if (!subscribers.size) submissionListeners.delete(identity); };
    },
    takeSubmission(threadId: string, requestId: string, expectedItems: readonly DraftAttachment[]) {
      requireOwner();
      const identity = key(threadId, requestId), existing = bundles.get(identity);
      if (existing) return existing.items;
      if (!uuid.test(requestId) || !expectedItems.length || expectedItems.length > MAX_ATTACHMENTS || new Set(expectedItems.map(item => item.id)).size !== expectedItems.length)
        throw new Error("附件提交身份不匹配，请重新确认原草稿。");
      const current = get(threadId), selected = expectedItems.map(expected => current.find(item => item.id === expected.id));
      if (selected.some((item, index) => !item || item.file !== expectedItems[index].file || item.attachment?.sha256 !== expectedItems[index].attachment?.sha256 && expectedItems[index].attachment))
        throw new Error("附件草稿已变化，请重新确认原草稿。");
      if (selected.some(item => item?.status === "removing" || item?.deletePending))
        throw new Error("附件正在移除，请稍后再发送。");
      const items = Object.freeze(selected as DraftAttachment[]);
      bundles.set(identity, { threadId, requestId, items, held: true, cancelled: false });
      items.forEach(item => { const upload = key(threadId, item.id); owners.set(upload, identity); claimed.add(upload); cancelQueued(threadId, item.id); });
      change(threadId, latest => latest.filter(item => !items.some(selected => selected.id === item.id)));
      notifySubmission(threadId, requestId);
      return items;
    },
    restoreSubmission(threadId: string, requestId: string, text: string) {
      requireOwner();
      const identity = key(threadId, requestId), bundle = bundles.get(identity), previous = drafts.get(threadId);
      if (!bundle || bundle.cancelled || !bundle.held) throw new Error("请先核对原消息并暂停附件上传，再重新编辑。");
      if (previous?.text || previous?.requestId || hasDraftAttachments(previous)) throw new Error("输入框已有新草稿，请先处理后再重新编辑这条消息。");
      const owner = captureDraft(drafts, threadId), items = bundle.items;
      const restored: QueryDraft = { text, attachments: items.length ? items : undefined };
      if (!owner.set(restored)) throw new Error("草稿已变化，原消息仍保留在这里。");
      for (const [upload, requestOwner] of owners) if (requestOwner === identity) { owners.delete(upload); claimed.delete(upload); }
      bundles.delete(identity); submissionListeners.delete(identity);
      notify(threadId); pump(threadId);
      return restored;
    },
    resumeSubmission(threadId: string, requestId: string) {
      if (disposed) return;
      const bundle = bundles.get(key(threadId, requestId));
      if (!bundle || bundle.cancelled) return;
      bundle.held = false; pump(threadId);
    },
    retrySubmission(threadId: string, requestId: string) {
      if (disposed) return;
      const bundle = bundles.get(key(threadId, requestId));
      if (!bundle || bundle.cancelled) return;
      bundle.items.forEach(item => { if (item.status === "failed") controller.retry(threadId, item.id); });
    },
    async checkSubmission(threadId: string, requestId: string) {
      if (disposed) return;
      await Promise.all(getSubmission(threadId, requestId).filter(item => item.status === "unknown").map(item => controller.check(threadId, item.id)));
    },
    cancelSubmission(threadId: string, requestId: string) {
      if (disposed) return Promise.resolve(false);
      const identity = key(threadId, requestId);
      if (cancelling.has(identity)) return cancelling.get(identity)!;
      const bundle = bundles.get(identity);
      if (!bundle) return Promise.resolve(true);
      bundle.cancelled = true; bundle.held = true;
      bundle.items.forEach(item => cancelQueued(threadId, item.id));
      const task = Promise.all(bundle.items.map(item => controller.remove(threadId, item.id))).then(() => !getSubmission(threadId, requestId).length)
        .finally(() => cancelling.delete(identity));
      cancelling.set(identity, task); return task;
    },
    completeSubmission(threadId: string, requestId: string) {
      const identity = key(threadId, requestId), bundle = bundles.get(identity);
      if (!bundle) return;
      if (bundle.cancelled && bundle.items.length || bundle.items.some(item => item.status !== "uploaded")) throw new Error("附件结果尚未确认，请保留原消息继续核对。");
      for (const [upload, owner] of owners) if (owner === identity) owners.delete(upload);
      bundles.delete(identity); submissionListeners.delete(identity);
    },
    confirmSubmission(threadId: string, requestId: string, files: readonly PublicAttachment[]) {
      if (disposed) return false;
      const bundle = bundles.get(key(threadId, requestId));
      if (!bundle || bundle.cancelled || files.length !== bundle.items.length) return false;
      const confirmed = bundle.items.map(item => {
        const file = files.find(value => value.id === item.id);
        if (!file || file.name !== item.name) throw new Error("附件回执不匹配，请核对上传状态。");
        return validateAttachment(file, threadId, item.id, item);
      });
      confirmed.forEach(file => update(threadId, file.id, item => ({ ...item, attachment: file, status: "uploaded", error: undefined })));
      return true;
    },
    add(threadId: string, files: readonly File[]) {
      requireOwner();
      if (get(threadId).length + files.length > MAX_ATTACHMENTS) throw new Error(`每条消息最多添加${MAX_ATTACHMENTS}个附件。`);
      if (files.some(file => file.size > MAX_ATTACHMENT_BYTES)) throw new Error("单个附件不能超过20 MB。");
      const additions: DraftAttachment[] = files.map(file => ({ id: crypto.randomUUID(), file, name: file.name || "附件", size: file.size,
        mime: file.type || "application/octet-stream", kind: file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name) ? "image" : "file", status: "queued" }));
      if (additions.length) { change(threadId, items => [...items, ...additions]); void pump(threadId); }
      return additions.map(item => item.id);
    },
    retry(threadId: string, id: string) {
      if (disposed) return;
      const item = find(threadId, id);
      if (!item?.file || item.status !== "failed" || active.has(key(threadId, id))) return;
      update(threadId, id, value => ({ ...value, status: "queued", error: undefined })); void pump(threadId);
    },
    async check(threadId: string, id: string) {
      if (disposed) return;
      const item = find(threadId, id);
      if (!item || item.checking || active.has(key(threadId, id)) || removing.has(key(threadId, id))) return;
      update(threadId, id, value => ({ ...value, checking: true }));
      try {
        const uploaded = validateAttachment(await request.metadata(threadId, id, lifetime.signal), threadId, id, item);
        const cancelled = bundleFor(threadId, id)?.cancelled;
        update(threadId, id, value => ({ ...value, attachment: uploaded, status: cancelled ? "unknown" : "uploaded", checking: false,
          deletePending: !!cancelled, error: cancelled ? "附件仍待移除，可重试取消。" : undefined }));
      } catch (failure) {
        if (disposed) return;
        const status = (failure as Error & { status?: number }).status;
        if (status === 404 && item.deletePending) { claimed.add(key(threadId, id)); drop(threadId, id); return; }
        update(threadId, id, value => ({ ...value, checking: false, error: status === 409 ? "附件仍在上传，请稍后核对。"
          : status === 404 ? "尚未找到上传结果，请稍后再核对。" : (failure as Error).message || "暂时无法核对附件。" }));
      }
    },
    async remove(threadId: string, id: string) {
      if (disposed) return;
      const identity = key(threadId, id), original = find(threadId, id);
      if (!original || removing.has(identity) || original.checking) return;
      removing.add(identity); update(threadId, id, item => ({ ...item, status: "removing", error: undefined }));
      cancelQueued(threadId, id);
      try {
        await active.get(identity);
        if (disposed) return;
        const item = find(threadId, id);
        if (!item) return;
        if (!item.attachment && (["queued", "failed"].includes(original.status) || item.status === "failed")) { drop(threadId, id); return; }
        if (!item.attachment && original.status === "uploading" && !item.error && item.status === "removing") { drop(threadId, id); return; }
        await request.remove(threadId, id, lifetime.signal);
        if (disposed) return;
        claimed.add(identity); drop(threadId, id);
      } catch (failure) {
        update(threadId, id, item => ({ ...item, status: "unknown", deletePending: true, error: "附件未能移除，请核对状态或重试移除。" }));
      } finally { removing.delete(identity); }
    },
    claim(threadId: string, ids: readonly string[]) { if (!disposed) ids.forEach(id => claimed.add(key(threadId, id))); },
    unclaim(threadId: string, ids: readonly string[]) { if (!disposed) ids.forEach(id => claimed.delete(key(threadId, id))); },
    async releaseQueued(threadId: string, ids: readonly string[]) {
      requireOwner();
      controller.unclaim(threadId, ids);
      // A list requested before cancellation can still describe bound files.
      // Finish it first, then read the released draft attachments afresh.
      await recovering.get(threadId)?.catch(() => {});
      requireOwner();
      await controller.recover(threadId);
      return get(threadId).filter(item => ids.includes(item.id)).length;
    },
    async restoreFiles(threadId: string, files: readonly PublicAttachment[]) {
      requireOwner();
      if (!files.length) return [];
      const result = await request.list(threadId, lifetime.signal);
      requireOwner();
      return files.map(file => {
        const found = result.attachments.find(item => item.id === file.id && item.sha256 === file.sha256);
        if (!found) throw new Error("部分附件已进入待发消息或不再可用，请刷新后查看。");
        const attachment = validateAttachment(found, threadId);
        return { id: attachment.id, name: attachment.name, size: attachment.size, mime: attachment.mime, kind: attachment.kind, status: "uploaded" as const, attachment };
      });
    },
    async restoreDraft(threadId: string, submission: { status: string; text: string; attachments?: readonly PublicAttachment[] }, currentView = () => true) {
      requireOwner();
      if (!["rejected", "not_found"].includes(submission.status)) throw new Error("请先核对原消息的发送结果。");
      const previous = drafts.get(threadId);
      if (previous?.text || previous?.requestId || hasDraftAttachments(previous)) throw new Error("输入框已有新草稿，请先处理后再重新编辑这条消息。");
      const owner = captureDraft(drafts, threadId);
      const restored = await controller.restoreFiles(threadId, submission.attachments ?? []);
      const value: QueryDraft = { text: submission.text, attachments: restored.length ? restored : undefined };
      if (!currentView() || !owner.set(value)) throw new Error("草稿或页面已变化，原消息仍保留在这里。");
      controller.unclaim(threadId, restored.map(file => file.id)); notify(threadId);
      return value;
    },
    recover(threadId: string) {
      requireOwner();
      if (recovering.has(threadId)) return recovering.get(threadId)!;
      const task = request.list(threadId, lifetime.signal).then(result => {
        if (disposed) return;
        const files = result.attachments.map(item => validateAttachment(item, threadId));
        let extra = 0;
        change(threadId, items => {
          const additions = files.filter(file => !claimed.has(key(threadId, file.id)) && !owners.has(key(threadId, file.id)) && !items.some(item => item.id === file.id))
            .map(attachment => ({ id: attachment.id, name: attachment.name, mime: attachment.mime, size: attachment.size, kind: attachment.kind, attachment, status: "uploaded" as const }));
          const capacity = Math.max(0, MAX_ATTACHMENTS - items.length);
          extra = Math.max(0, additions.length - capacity);
          return additions.length && capacity ? [...items, ...additions.slice(0, capacity)] : items;
        });
        if (extra) throw Object.assign(new Error(`另有${extra}个已上传附件，移除部分附件后可重新载入。`), { code: "attachment_recovery_limit" });
      }).finally(() => recovering.delete(threadId));
      recovering.set(threadId, task); return task;
    },
  };
  return controller;
}
export type AttachmentDraftController = ReturnType<typeof createAttachmentDraftController>;
const controllers = new WeakMap<Map<string, QueryDraft>, AttachmentDraftController>();
export function attachmentDraftController(drafts: Map<string, QueryDraft>) {
  let controller = controllers.get(drafts);
  if (!controller) { controller = createAttachmentDraftController(drafts); controllers.set(drafts, controller); }
  return controller;
}

import { api } from "./api.ts";
import type { QueryDraft } from "./Conversation";
import { captureDraft } from "./draftTransaction.ts";

export type PublicAttachment = {
  id: string; name: string; size: number; mime: string; kind: "image" | "file"; url: string; sha256: string;
  sourceSha256?: string; sourceSize?: number; previewUrl?: string;
};
export type DraftAttachment = {
  id: string; name: string; size: number; mime: string; kind: "image" | "file";
  status: "queued" | "uploading" | "uploaded" | "failed" | "unknown" | "removing";
  file?: File; attachment?: PublicAttachment; sourceSha256?: string; error?: string; checking?: boolean;
  deletePending?: boolean;
};
export const MAX_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
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
      value.previewUrl !== undefined && value.previewUrl !== `${attachmentPath(threadId, id)}?preview=1`) throw new Error("附件回执不匹配，请核对上传状态。");
  if (source?.file && (value.sourceSize ?? value.size) !== source.size) throw new Error("附件大小与所选文件不一致，请核对上传状态。");
  if (source?.sourceSha256 && (value.sourceSha256 ?? value.sha256) !== source.sourceSha256) throw new Error("附件内容与所选文件不一致，请核对上传状态。");
  return Object.freeze({ ...value });
}
export async function fileSha256(file: File) {
  const bytes = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}
type Transport = {
  upload: (threadId: string, item: DraftAttachment) => Promise<PublicAttachment>;
  metadata: (threadId: string, id: string) => Promise<PublicAttachment>;
  list: (threadId: string) => Promise<{ attachments: PublicAttachment[] }>;
  remove: (threadId: string, id: string) => Promise<unknown>;
};
const attachmentUploadTimeoutMs = 190000;
const transport: Transport = {
  upload: (threadId, item) => api(`${attachmentPath(threadId, item.id)}?name=${encodeURIComponent(item.name)}`, "PUT", item.file,
    { raw: true, contentType: item.mime, signal: AbortSignal.timeout(attachmentUploadTimeoutMs), timeoutMs: attachmentUploadTimeoutMs }),
  metadata: (threadId, id) => api(`${attachmentPath(threadId, id)}?metadata=1`, "GET", undefined, { signal: AbortSignal.timeout(15000) }),
  list: threadId => api(`/api/tasks/${threadId}/attachments`, "GET", undefined, { signal: AbortSignal.timeout(15000) }),
  remove: (threadId, id) => api(attachmentPath(threadId, id), "DELETE", undefined, { signal: AbortSignal.timeout(15000) }),
};

// Upload ownership lives with the shared draft Map, not a mounted composer.
// Each result edits only its upload ID and merges the latest independent text.
export function createAttachmentDraftController(drafts: Map<string, QueryDraft>, request: Transport = transport, digest = fileSha256) {
  const listeners = new Map<string, Set<() => void>>(), active = new Map<string, Promise<void>>(), pumping = new Set<string>();
  const removing = new Set<string>(), claimed = new Set<string>(), recovering = new Map<string, Promise<void>>();
  const key = (threadId: string, id: string) => `${threadId}/${id}`;
  const get = (threadId: string) => drafts.get(threadId)?.attachments ?? empty;
  const notify = (threadId: string) => listeners.get(threadId)?.forEach(listener => listener());
  const change = (threadId: string, edit: (items: readonly DraftAttachment[]) => readonly DraftAttachment[]) => {
    const previous = get(threadId), next = edit(previous);
    if (previous === next) return;
    const draft = { ...(drafts.get(threadId) ?? { text: "" }), attachments: next.length ? next : undefined };
    if (draft.text || draft.requestId || next.length) drafts.set(threadId, draft); else drafts.delete(threadId);
    notify(threadId);
  };
  const update = (threadId: string, id: string, edit: (item: DraftAttachment) => DraftAttachment) => change(threadId, items => {
    if (!items.some(item => item.id === id)) return items;
    return items.map(item => item.id === id ? Object.freeze(edit(item)) : item);
  });
  const drop = (threadId: string, id: string) => change(threadId, items => items.some(item => item.id === id) ? items.filter(item => item.id !== id) : items);
  const run = (threadId: string, id: string) => {
    const identity = key(threadId, id);
    if (active.has(identity)) return active.get(identity)!;
    const task = (async () => {
      let item = get(threadId).find(value => value.id === id);
      if (!item?.file || item.status !== "queued") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        update(threadId, id, current => ({ ...current, status: "failed", error: "当前离线，联网后可重试上传。" })); return;
      }
      update(threadId, id, current => ({ ...current, status: "uploading", error: undefined }));
      let attempted = false;
      try {
        const sourceSha256 = item.sourceSha256 ?? await digest(item.file);
        update(threadId, id, current => ({ ...current, sourceSha256 }));
        item = get(threadId).find(value => value.id === id);
        if (!item || removing.has(identity)) return;
        attempted = true;
        const uploaded = validateAttachment(await request.upload(threadId, item), threadId, id, item);
        update(threadId, id, current => ({ ...current, attachment: uploaded, status: removing.has(identity) ? "removing" : "uploaded", error: undefined }));
      } catch (failure) {
        const status = (failure as Error & { status?: number }).status;
        const definite = !attempted || !!status && status < 500 && status !== 409;
        update(threadId, id, current => ({ ...current, status: definite ? "failed" : removing.has(identity) ? "removing" : "unknown",
          error: definite ? (failure as Error).message || "上传未完成，可重试。" : "上传结果待确认，请核对状态。" }));
        if (!definite && !removing.has(identity)) {
          try {
            const current = get(threadId).find(value => value.id === id);
            if (!current) return;
            const uploaded = validateAttachment(await request.metadata(threadId, id), threadId, id, current);
            update(threadId, id, value => ({ ...value, attachment: uploaded, status: removing.has(identity) ? "removing" : "uploaded", error: undefined }));
          } catch { /* Keep the same upload ID and File for a later read-only check. */ }
        }
      }
    })().finally(() => { active.delete(identity); });
    active.set(identity, task); return task;
  };
  const pump = async (threadId: string) => {
    if (pumping.has(threadId)) return;
    pumping.add(threadId);
    try { for (;;) { const next = get(threadId).find(item => item.status === "queued"); if (!next) break; await run(threadId, next.id); } }
    finally { pumping.delete(threadId); }
  };
  const controller = {
    get,
    notify,
    subscribe(threadId: string, listener: () => void) {
      const subscribers = listeners.get(threadId) ?? new Set(); subscribers.add(listener); listeners.set(threadId, subscribers);
      return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(threadId); };
    },
    add(threadId: string, files: readonly File[]) {
      if (get(threadId).length + files.length > MAX_ATTACHMENTS) throw new Error("每条消息最多添加6个附件。");
      if (files.some(file => file.size > MAX_ATTACHMENT_BYTES)) throw new Error("单个附件不能超过20 MB。");
      const additions: DraftAttachment[] = files.map(file => ({ id: crypto.randomUUID(), file, name: file.name || "附件", size: file.size,
        mime: file.type || "application/octet-stream", kind: file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name) ? "image" : "file", status: "queued" }));
      if (additions.length) { change(threadId, items => [...items, ...additions]); void pump(threadId); }
      return additions.map(item => item.id);
    },
    retry(threadId: string, id: string) {
      const item = get(threadId).find(value => value.id === id);
      if (!item?.file || item.status !== "failed" || active.has(key(threadId, id))) return;
      update(threadId, id, value => ({ ...value, status: "queued", error: undefined })); void pump(threadId);
    },
    async check(threadId: string, id: string) {
      const item = get(threadId).find(value => value.id === id);
      if (!item || item.checking || active.has(key(threadId, id)) || removing.has(key(threadId, id))) return;
      update(threadId, id, value => ({ ...value, checking: true }));
      try {
        const uploaded = validateAttachment(await request.metadata(threadId, id), threadId, id, item);
        update(threadId, id, value => ({ ...value, attachment: uploaded, status: "uploaded", checking: false, deletePending: false, error: undefined }));
      } catch (failure) {
        const status = (failure as Error & { status?: number }).status;
        if (status === 404 && item.deletePending) { claimed.add(key(threadId, id)); drop(threadId, id); return; }
        update(threadId, id, value => ({ ...value, checking: false, error: status === 409 ? "附件仍在上传，请稍后核对。"
          : status === 404 ? "尚未找到上传结果，请稍后再核对。" : (failure as Error).message || "暂时无法核对附件。" }));
      }
    },
    async remove(threadId: string, id: string) {
      const identity = key(threadId, id), original = get(threadId).find(item => item.id === id);
      if (!original || removing.has(identity) || original.checking) return;
      removing.add(identity); update(threadId, id, item => ({ ...item, status: "removing", error: undefined }));
      try {
        await active.get(identity);
        let item = get(threadId).find(value => value.id === id);
        if (!item) return;
        if (!item.attachment && (["queued", "failed"].includes(original.status) || item.status === "failed")) { drop(threadId, id); return; }
        if (!item.attachment && original.status === "uploading" && !item.error && item.status === "removing") { drop(threadId, id); return; }
        await request.remove(threadId, id);
        claimed.add(identity); drop(threadId, id);
      } catch (failure) {
        update(threadId, id, item => ({ ...item, status: "unknown", deletePending: true, error: "附件未能移除，请核对状态或重试移除。" }));
      } finally { removing.delete(identity); }
    },
    claim(threadId: string, ids: readonly string[]) { ids.forEach(id => claimed.add(key(threadId, id))); },
    unclaim(threadId: string, ids: readonly string[]) { ids.forEach(id => claimed.delete(key(threadId, id))); },
    async releaseQueued(threadId: string, ids: readonly string[]) {
      controller.unclaim(threadId, ids);
      // A list requested before cancellation can still describe bound files.
      // Finish it first, then read the released draft attachments afresh.
      await recovering.get(threadId)?.catch(() => {});
      await controller.recover(threadId);
      return get(threadId).filter(item => ids.includes(item.id)).length;
    },
    async restoreFiles(threadId: string, files: readonly PublicAttachment[]) {
      if (!files.length) return [];
      const result = await request.list(threadId);
      return files.map(file => {
        const found = result.attachments.find(item => item.id === file.id && item.sha256 === file.sha256);
        if (!found) throw new Error("部分附件已进入待发消息或不再可用，请刷新后查看。");
        const attachment = validateAttachment(found, threadId);
        return { id: attachment.id, name: attachment.name, size: attachment.size, mime: attachment.mime, kind: attachment.kind, status: "uploaded" as const, attachment };
      });
    },
    async restoreDraft(threadId: string, submission: { status: string; text: string; attachments?: readonly PublicAttachment[] }, currentView = () => true) {
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
      if (recovering.has(threadId)) return recovering.get(threadId)!;
      const task = request.list(threadId).then(result => {
        const files = result.attachments.map(item => validateAttachment(item, threadId));
        let extra = 0;
        change(threadId, items => {
          const additions = files.filter(file => !claimed.has(key(threadId, file.id)) && !items.some(item => item.id === file.id))
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

import { openDB, type IDBPDatabase } from "idb";
import type { FeedbackAnnotation, FeedbackContext, FeedbackInput, FeedbackReason, FeedbackReceipt } from "../contracts.ts";
import type { FeedbackCapture } from "./capture.ts";

export type FeedbackDraft = {
  id: string; appId: string; context: FeedbackContext; note: string; reason: FeedbackReason;
  annotations: FeedbackAnnotation[]; autoDirect: boolean; touched: boolean;
  image?: FeedbackCapture & { id: string };
  phase: "editing" | "unknown";
  preparedInput?: FeedbackInput;
  receipt?: FeedbackReceipt;
  revision: number; updatedAt: number;
};
export type FeedbackDraftLease = { scope: string; epoch: string; id: string };
export type FeedbackDraftSession = { lease: FeedbackDraftLease; draft: FeedbackDraft };
type Meta = { scope: string; epoch: string; id?: string; bytes: number };
type Stored = Omit<FeedbackDraft, "image"> & { scope: string; imageKey?: string };
type StoredImage = Omit<NonNullable<FeedbackDraft["image"]>, "blob"> & { bytes: ArrayBuffer };
const databaseName = "feedback-kit-drafts-v1";
const validScope = (scope: string) => { if (!scope || scope.length > 2048) throw new Error("反馈草稿范围无效"); };
const imageKey = (scope: string, imageId: string) => JSON.stringify([scope, imageId]);
const clone = <T,>(value: T): T => structuredClone(value);
const bytes = (draft: FeedbackDraft) => JSON.stringify({ ...draft, image: undefined }).length * 2 + (draft.image?.blob.size ?? 0);

/** Drafts are separate from reading caches. A lease prevents late work from
 * recreating a draft after logout, completion, or a newer feedback. */
export function createFeedbackDraftStore(options: { name?: string; maxScopes?: number; maxBytes?: number } = {}) {
  let database: Promise<IDBPDatabase> | null = null, disposed = false;
  const pendingOpens = new Set<{ scope: string; valid: boolean }>();
  const buffers = new WeakMap<Blob, Promise<ArrayBuffer>>();
  const imageBytes = async (image?: FeedbackDraft["image"]): Promise<StoredImage | undefined> => {
    if (!image) return undefined;
    let pending = buffers.get(image.blob);
    if (!pending) {
      pending = image.blob.arrayBuffer().catch(error => { buffers.delete(image.blob); throw error; });
      buffers.set(image.blob, pending);
    }
    const { blob: _blob, ...rest } = image;
    return { ...rest, bytes: await pending };
  };
  const restoreImage = (image: StoredImage): NonNullable<FeedbackDraft["image"]> => {
    const { bytes, ...rest } = image;
    return { ...rest, blob: new Blob([bytes], { type: image.mime }) };
  };
  const db = () => {
    if (disposed) return Promise.reject(new Error("反馈草稿已关闭"));
    database ??= openDB(options.name ?? databaseName, 1, { upgrade(value) {
      value.createObjectStore("scopes", { keyPath: "scope" });
      value.createObjectStore("entries", { keyPath: "scope" });
      value.createObjectStore("images");
    } }).catch(error => { database = null; throw error; });
    return database;
  };
  const capacity = (all: Meta[], scope: string, size: number) => {
    if (all.filter(item => item.id && item.scope !== scope).length >= (options.maxScopes ?? 20) ||
        all.filter(item => item.scope !== scope).reduce((sum, item) => sum + item.bytes, 0) + size > (options.maxBytes ?? 64 * 1024 * 1024))
      throw new Error("反馈草稿空间不足，请先处理之前的反馈");
  };
  const stored = (scope: string, draft: FeedbackDraft): Stored => {
    const { image, ...rest } = draft;
    return { ...clone(rest), scope, ...(image ? { imageKey: imageKey(scope, image.id) } : {}) };
  };
  return {
    async open(scope: string, initial: FeedbackDraft): Promise<FeedbackDraftSession> {
      validScope(scope);
      const ticket = { scope, valid: true }; pendingOpens.add(ticket);
      try {
        const database = await db();
        let image: StoredImage | undefined, prepared = !initial.image;
        // Restore first. A new capture can be unreadable while WebKit is
        // offline, and is irrelevant when this scope already has a draft.
        for (;;) {
          if (disposed || !ticket.valid) throw new Error("反馈登录状态已变化");
          const tx = database.transaction(["scopes", "entries", "images"], "readwrite");
          try {
            const entries = tx.objectStore("entries"), scopes = tx.objectStore("scopes"), images = tx.objectStore("images");
            let meta = await scopes.get(scope) as Meta | undefined;
            const existing = await entries.get(scope) as Stored | undefined;
            if (existing && meta?.id === existing.id) {
              const savedImage = existing.imageKey ? await images.get(existing.imageKey) as StoredImage | undefined : undefined;
              if (existing.imageKey && !savedImage) throw new Error("反馈截图未能恢复，请先核对之前的发送状态");
              const { scope: _scope, imageKey: _key, ...draft } = existing;
              await tx.done;
              if (disposed || !ticket.valid) throw new Error("反馈登录状态已变化");
              return { lease: { scope, epoch: meta.epoch, id: existing.id }, draft: { ...clone(draft), ...(savedImage ? { image: restoreImage(savedImage) } : {}) } };
            }
            if (prepared) {
              const size = bytes(initial); capacity(await scopes.getAll() as Meta[], scope, size);
              meta = { scope, epoch: meta?.epoch ?? crypto.randomUUID(), id: initial.id, bytes: size };
              if (image) await images.put(image, imageKey(scope, image.id));
              await entries.put(stored(scope, initial)); await scopes.put(meta); await tx.done;
              if (disposed || !ticket.valid) throw new Error("反馈登录状态已变化");
              return { lease: { scope, epoch: meta.epoch, id: initial.id }, draft: clone(initial) };
            }
            await tx.done;
          } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
          // Blob reads must happen outside the transaction. The next pass
          // rechecks the scope because another opener may have saved meanwhile.
          image = await imageBytes(initial.image); prepared = true;
        }
      } finally { pendingOpens.delete(ticket); }
    },
    async save(lease: FeedbackDraftLease, draft: FeedbackDraft): Promise<boolean> {
      const database = await db(), next = stored(lease.scope, draft);
      const previous = await database.get("entries", lease.scope) as Stored | undefined;
      // Metadata-only edits reuse durable bytes. Rereading a structured-cloned
      // Blob can throw NotReadableError in offline WebKit even when IDB works.
      const image = next.imageKey && next.imageKey !== previous?.imageKey ? await imageBytes(draft.image) : undefined;
      const tx = database.transaction(["scopes", "entries", "images"], "readwrite");
      try {
        const scopes = tx.objectStore("scopes"), entries = tx.objectStore("entries"), images = tx.objectStore("images");
        const meta = await scopes.get(lease.scope) as Meta | undefined, current = await entries.get(lease.scope) as Stored | undefined;
        if (!meta || meta.epoch !== lease.epoch || meta.id !== lease.id || draft.id !== lease.id || !current ||
            current.id !== lease.id || draft.revision < current.revision) { await tx.done; return false; }
        if (draft.revision === current.revision) { await tx.done; return JSON.stringify(next) === JSON.stringify(current); }
        const size = bytes(draft); capacity(await scopes.getAll() as Meta[], lease.scope, size);
        if (next.imageKey) {
          if (image && next.imageKey !== current.imageKey) await images.put(image, next.imageKey);
          else if (!await images.get(next.imageKey)) throw new Error("反馈截图已变化，请重新打开后重试");
        }
        if (current.imageKey && current.imageKey !== next.imageKey) await images.delete(current.imageKey);
        await entries.put(next); await scopes.put({ ...meta, bytes: size }); await tx.done;
        return true;
      } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => {}); throw error; }
    },
    async remove(lease: FeedbackDraftLease): Promise<boolean> {
      const database = await db(), tx = database.transaction(["scopes", "entries", "images"], "readwrite");
      const meta = await tx.objectStore("scopes").get(lease.scope) as Meta | undefined;
      if (!meta || meta.epoch !== lease.epoch || meta.id !== lease.id) { await tx.done; return false; }
      const current = await tx.objectStore("entries").get(lease.scope) as Stored | undefined;
      if (current?.imageKey) await tx.objectStore("images").delete(current.imageKey);
      await tx.objectStore("entries").delete(lease.scope);
      await tx.objectStore("scopes").put({ scope: lease.scope, epoch: meta.epoch, bytes: 0 });
      await tx.done; return true;
    },
    async clearScope(scope: string) {
      validScope(scope);
      for (const ticket of pendingOpens) if (ticket.scope === scope) ticket.valid = false;
      const database = await db(), tx = database.transaction(["scopes", "entries", "images"], "readwrite");
      const current = await tx.objectStore("entries").get(scope) as Stored | undefined;
      if (current?.imageKey) await tx.objectStore("images").delete(current.imageKey);
      await tx.objectStore("entries").delete(scope);
      await tx.objectStore("scopes").put({ scope, epoch: crypto.randomUUID(), bytes: 0 });
      await tx.done;
    },
    async clearAll() {
      for (const ticket of pendingOpens) ticket.valid = false;
      const database = await db(), tx = database.transaction(["scopes", "entries", "images"], "readwrite");
      for (const name of ["scopes", "entries", "images"]) await tx.objectStore(name).clear();
      await tx.done;
    },
    async clearPrefix(prefix: string) {
      validScope(prefix);
      for (const ticket of pendingOpens) if (ticket.scope.startsWith(prefix)) ticket.valid = false;
      const database = await db(), tx = database.transaction(["scopes", "entries", "images"], "readwrite");
      const scopes = tx.objectStore("scopes"), entries = tx.objectStore("entries"), images = tx.objectStore("images");
      for (const meta of await scopes.getAll() as Meta[]) {
        if (!meta.scope.startsWith(prefix)) continue;
        const current = await entries.get(meta.scope) as Stored | undefined;
        if (current?.imageKey) await images.delete(current.imageKey);
        await entries.delete(meta.scope); await scopes.delete(meta.scope);
      }
      await tx.done;
    },
    async dispose() { disposed = true; for (const ticket of pendingOpens) ticket.valid = false; (await database?.catch(() => null))?.close(); database = null; },
  };
}
export type FeedbackDraftStore = ReturnType<typeof createFeedbackDraftStore>;

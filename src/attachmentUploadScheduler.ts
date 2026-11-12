import { MAX_ATTACHMENT_UPLOADS } from "../shared/attachment-limits.mjs";

type UploadJob = { id: string; run: () => Promise<void>; resolve: () => void; reject: (failure: unknown) => void };

// One scheduler is shared by every draft controller in this browser context.
// Round-robin groups keep a busy thread from consuming every newly free slot.
export function createAttachmentUploadScheduler(limit: number = MAX_ATTACHMENT_UPLOADS) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ATTACHMENT_UPLOADS) throw new Error("Invalid attachment upload concurrency.");
  const groups = new Map<object, UploadJob[]>(), order: object[] = [], queued = new Map<string, { group: object; job: UploadJob }>();
  let active = 0;
  const drain = () => {
    while (active < limit && order.length) {
      const group = order.shift()!, jobs = groups.get(group)!, job = jobs.shift()!;
      if (jobs.length) order.push(group); else groups.delete(group);
      queued.delete(job.id); active++;
      void (async () => {
        try { await job.run(); job.resolve(); } catch (failure) { job.reject(failure); }
        finally { active--; drain(); }
      })();
    }
  };
  return {
    schedule(group: object, id: string, run: () => Promise<void>) {
      if (queued.has(id)) throw new Error("An attachment upload is already queued.");
      const promise = new Promise<void>((resolve, reject) => {
        const job = { id, run, resolve, reject }, jobs = groups.get(group);
        if (jobs) jobs.push(job); else { groups.set(group, [job]); order.push(group); }
        queued.set(id, { group, job });
      });
      drain(); return promise;
    },
    cancel(id: string) {
      const entry = queued.get(id);
      if (!entry) return false;
      const jobs = groups.get(entry.group)!;
      jobs.splice(jobs.indexOf(entry.job), 1); queued.delete(id);
      if (!jobs.length) { groups.delete(entry.group); order.splice(order.indexOf(entry.group), 1); }
      entry.job.resolve(); return true;
    },
  };
}
export type AttachmentUploadScheduler = ReturnType<typeof createAttachmentUploadScheduler>;
export const attachmentUploadScheduler = createAttachmentUploadScheduler();
// Keep at most two source arrayBuffers live while SHA-256 is calculated.
// Hash preparation has its own budget and never occupies a network upload slot.
export const MAX_ATTACHMENT_HASHES = 2;
export const attachmentHashScheduler = createAttachmentUploadScheduler(MAX_ATTACHMENT_HASHES);

import { clientVersionHeaders } from "./clientVersion.ts";
import { checkMachineResponse, currentMachineId, machineApiPath, type MachineId } from "./machineScope.ts";
import { createRequestDeadline } from "./requestDeadline.ts";
import { imageReadPermissionMessage } from "./imageFailureDiagnostic.ts";
import { subscribeReadingCacheInvalidation } from "./readingCacheStorage.ts";
import { clearImageReadStorage, createImageReadStorage, imageReadCacheFence, imageReadCacheKey, imageReadCacheLimits,
  subscribeImageReadInvalidation, type ImageReadRecord, type ImageReadStorage, type ImageReadVariant } from "./imageReadCacheStorage.ts";

export { imageReadCacheLimits } from "./imageReadCacheStorage.ts";
export type ImageReadProof = { src: string; machine?: MachineId | null; sha256?: string; mime?: string; size?: number; variant?: ImageReadVariant };
export type ImageReadLease = { url: string; release(): void };
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const route = new RegExp(`^/api/tasks/(${uuid})/(?:images/[a-f0-9]{64}|files/[a-f0-9]{64}/image|attachments/${uuid}(\\?preview=1)?)$`, "i");
const hash = /^[a-f0-9]{64}$/i, mimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const attachmentImageBytes = 20 * 1024 * 1024;
const readLimit = (src: string) => src.includes("/attachments/") && !src.includes("?") ? attachmentImageBytes : imageReadCacheLimits.imageBytes;
export function imageReadSource(src: string) {
  const match = route.exec(src);
  return match ? { threadId: match[1].toLowerCase(), variant: match[2] ? "preview" as const : "original" as const } : null;
}
export class ImageReadError extends Error {
  readonly status: number; readonly permission: boolean;
  constructor(status = 0, permission = false) { super(permission ? imageReadPermissionMessage : "图片暂时无法显示"); this.name = "ImageReadError"; this.status = status; this.permission = permission; }
}
export function imageSignature(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}
async function validatedBlob(blob: Blob, proof: ImageReadProof) {
  if (blob.size < 1 || blob.size > readLimit(proof.src) || proof.size !== undefined && blob.size !== proof.size) throw new ImageReadError();
  const bytes = new Uint8Array(await blob.arrayBuffer()), mime = imageSignature(bytes);
  if (!mime || blob.type !== mime || proof.mime !== undefined && proof.mime !== mime) throw new ImageReadError();
  if (proof.sha256) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    if ([...digest].map(value => value.toString(16).padStart(2, "0")).join("") !== proof.sha256.toLowerCase()) throw new ImageReadError();
  }
  return blob;
}
async function boundedBody(response: Response, signal: AbortSignal, limit: number) {
  if (!response.body || Number(response.headers.get("Content-Length")) > limit) throw new ImageReadError(response.status);
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let length = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const result = await reader.read(); signal.throwIfAborted();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > limit) throw new ImageReadError(response.status);
      chunks.push(new Uint8Array(result.value));
    }
    return new Blob(chunks, { type: (response.headers.get("Content-Type") ?? "").split(";", 1)[0].trim().toLowerCase() });
  } finally { signal.removeEventListener("abort", cancel); cancel(); }
}
type Context = { scope: string | null; epoch: number; fence: string | null };
type Identity = { proof: ImageReadProof & { machine: string }; context: Context; key: string; threadId: string; variant: ImageReadVariant };
type Entry = { key: string; machine: string; blob: Blob; epoch: number; fence: string | null };
type Flight = { controller: AbortController; consumers: number; promise: Promise<Blob> };
type UrlEntry = { url: string; count: number; blob: Blob; machine: string; revoked: boolean };
type Options = { request?: typeof fetch; selectedMachine?: () => MachineId | null; storage?: ImageReadStorage | null;
  createStorage?: () => ImageReadStorage; clearStorage?: (machine?: string) => Promise<unknown>; memoryBytes?: number;
  createObjectURL?: (blob: Blob) => string; revokeObjectURL?: (url: string) => void; now?: () => number; timeoutMs?: number;
  onUnauthorized?: (machine: string) => void };

export function createImageReadCache({ request = (...args) => fetch(...args), selectedMachine = currentMachineId,
  storage, createStorage = createImageReadStorage, clearStorage = clearImageReadStorage, memoryBytes = imageReadCacheLimits.memoryBytes,
  createObjectURL = blob => URL.createObjectURL(blob), revokeObjectURL = url => URL.revokeObjectURL(url), now = Date.now,
  timeoutMs = imageReadCacheLimits.timeoutMs, onUnauthorized = machine => {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("navigator-auth-expired", { detail: { machine } }));
  } }: Options = {}) {
  const contexts = new Map<string, Context>(), memory = new Map<string, Entry>(), proofs = new Map<string, { proof: ImageReadProof; epoch: number }>();
  const flights = new Map<string, Flight>(), versions = new Map<string, number>(), urls = new Map<string, UrlEntry>(), liveUrls = new Set<UrlEntry>();
  const listeners = new Set<() => void>(), queue: { start(): void; abort(): void }[] = [];
  let epoch = 0, retrySequence = 0, disposed = false, active = 0, disk = storage, clears: Promise<unknown> = Promise.resolve();
  const notify = () => listeners.forEach(listener => { try { listener(); } catch { /* Independent readers still update. */ } });
  const closeDisk = () => { if (storage === undefined) { disk?.close(); disk = undefined; } };
  const getDisk = async () => { await clears; return disposed ? null : disk === undefined ? disk = createStorage() : disk; };
  const current = (identity: Identity) => !disposed && contexts.get(identity.proof.machine) === identity.context && selectedMachine() === identity.proof.machine &&
    identity.context.fence === imageReadCacheFence(identity.proof.machine);
  const proofKey = (machine: string, src: string) => JSON.stringify([machine, src]);
  const parse = (supplied: ImageReadProof): Identity => {
    const machine = supplied.machine ?? selectedMachine(), source = imageReadSource(supplied.src);
    const context = machine ? contexts.get(machine) : undefined;
    if (!source || !machine || machine !== selectedMachine() || !context || disposed) throw new ImageReadError();
    if (context.fence !== imageReadCacheFence(machine)) { revoke(machine); throw new ImageReadError(); }
    const registered = proofs.get(proofKey(machine, supplied.src));
    const proof: ImageReadProof & { machine: string } = { ...(registered?.epoch === context.epoch ? registered.proof : {}), src: supplied.src, machine };
    for (const field of ["sha256", "mime", "size", "variant"] as const) if (supplied[field] !== undefined) Object.assign(proof, { [field]: supplied[field] });
    if (proof.sha256 !== undefined && !hash.test(proof.sha256) || proof.mime !== undefined && !mimes.has(proof.mime) ||
        proof.size !== undefined && (!Number.isSafeInteger(proof.size) || proof.size < 1 || proof.size > readLimit(proof.src)) ||
        proof.variant !== undefined && proof.variant !== source.variant) throw new ImageReadError();
    const key = proof.sha256 && context.scope ? imageReadCacheKey(machine, context.scope, source.threadId, proof.sha256.toLowerCase(), source.variant)
      : JSON.stringify([machine, context.epoch, source.threadId, supplied.src]);
    return { proof, context, key, ...source };
  };
  const revoke = (machine?: string) => {
    epoch++;
    for (const [id] of contexts) if (!machine || id === machine) contexts.delete(id);
    for (const [key, item] of memory) if (!machine || item.machine === machine) memory.delete(key);
    for (const [key, item] of proofs) if (!machine || item.proof.machine === machine) proofs.delete(key);
    for (const [key] of versions) if (!machine || JSON.parse(key)[0] === machine) versions.delete(key);
    for (const [key, flight] of flights) if (!machine || JSON.parse(key)[0] === machine) { flight.controller.abort(); flights.delete(key); }
    // Hooks release their leases on this synchronous notification. Remaining
    // external leases are revoked on authorization loss as well.
    for (const item of liveUrls) if (!machine || item.machine === machine) { if (!item.revoked) revokeObjectURL(item.url); item.revoked = true; liveUrls.delete(item); }
    for (const [key, item] of urls) if (!machine || item.machine === machine) urls.delete(key);
    closeDisk(); notify();
  };
  const unsubscribe = subscribeImageReadInvalidation(revoke);
  const prune = () => {
    let bytes = [...memory.values()].reduce((sum, entry) => sum + entry.blob.size, 0);
    for (const [key, entry] of memory) {
      if (bytes <= memoryBytes && memory.size <= imageReadCacheLimits.entries) break;
      memory.delete(key); bytes -= entry.blob.size;
    }
  };
  const permit = (signal: AbortSignal) => new Promise<() => void>((resolve, reject) => {
    const item = { start: () => {
      signal.removeEventListener("abort", item.abort); active++;
      let released = false;
      resolve(() => { if (released) return; released = true; active--; queue.shift()?.start(); });
    }, abort: () => { const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(signal.reason); } };
    if (signal.aborted) { reject(signal.reason); return; }
    if (active < imageReadCacheLimits.concurrentReads) item.start(); else { queue.push(item); signal.addEventListener("abort", item.abort, { once: true }); }
  });
  const load = async (identity: Identity, controller: AbortController, force: boolean, version: number) => {
    const valid = () => current(identity) && !controller.signal.aborted && version === (versions.get(identity.key) ?? 0);
    const persistent = identity.proof.sha256 && identity.context.scope && identity.context.fence !== null &&
      (identity.proof.size === undefined || identity.proof.size <= imageReadCacheLimits.imageBytes);
    let target: ImageReadStorage | null | undefined;
    if (!force && persistent) {
      try {
        target = await getDisk();
        const record = valid() ? await target?.read(identity.key, identity.proof.machine) : null;
        if (record && record.schema === 1 && record.key === identity.key && record.machine === identity.proof.machine && record.scope === identity.context.scope &&
            record.threadId === identity.threadId && record.sha256 === identity.proof.sha256!.toLowerCase() && record.variant === identity.variant &&
            record.bytes === record.blob.size && record.mime === record.blob.type && record.fence === identity.context.fence) {
          await validatedBlob(record.blob, identity.proof);
          if (valid()) return record.blob;
        }
      } catch { /* Optional persistence can fail independently of the live read. */ }
    }
    if (!valid()) throw new DOMException("Image read cancelled", "AbortError");
    const deadline = createRequestDeadline(controller.signal, timeoutMs); let release = () => {}, response: Response | undefined;
    try {
      release = await permit(deadline.signal); deadline.signal.throwIfAborted();
      response = await request(machineApiPath(identity.proof.src, identity.proof.machine), { method: "GET", cache: "no-store", mode: "same-origin",
        credentials: "same-origin", redirect: "error", signal: deadline.signal, headers: { ...clientVersionHeaders(), Accept: "image/png,image/jpeg,image/gif,image/webp" } });
      checkMachineResponse(response, identity.proof.machine); deadline.signal.throwIfAborted();
      if (response.status !== 200) {
        let permission = false;
        if (response.status === 403 && /^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) {
          try { const data = JSON.parse(await (await boundedBody(response, deadline.signal, 1024)).text()); permission = data?.error === imageReadPermissionMessage; } catch { /* Only the fixed reason is shown. */ }
        }
        if (response.status === 401 && valid()) { void invalidate(identity.proof.machine); onUnauthorized(identity.proof.machine); }
        throw new ImageReadError(response.status, permission);
      }
      const blob = await validatedBlob(await boundedBody(response, deadline.signal, readLimit(identity.proof.src)), identity.proof);
      deadline.signal.throwIfAborted(); if (!valid()) throw new DOMException("Image read cancelled", "AbortError");
      if (persistent && blob.size <= imageReadCacheLimits.imageBytes) {
        target ??= await getDisk();
        if (valid() && target) {
          const record: ImageReadRecord = { schema: 1, key: identity.key, machine: identity.proof.machine, scope: identity.context.scope!, threadId: identity.threadId,
            sha256: identity.proof.sha256!.toLowerCase(), variant: identity.variant, mime: blob.type, bytes: blob.size, blob, accessedAt: now(), fence: identity.context.fence! };
          try { await target.write(record); } catch { /* Quota or private mode falls back to memory. */ }
        }
      }
      if (!valid()) throw new DOMException("Image read cancelled", "AbortError");
      return blob;
    } finally { release(); deadline.dispose(); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
  };
  const invalidate = (machine?: string) => {
    revoke(machine);
    // Start immediately so the tombstone and local notification precede any
    // new authorization; serialize all new disk instances behind completion.
    const clearing = clearStorage(machine); clears = Promise.allSettled([clears, clearing]); return clearing;
  };
  return {
    authorize(machine: string, scope: string | null) {
      if (disposed || machine !== selectedMachine() || scope !== null && (!scope || scope.length > 512)) return;
      const previous = contexts.get(machine);
      // A successful auth-only check proves the existing session, but knows
      // nothing new about its source. Keep a previously verified scope.
      if (previous?.scope && scope === null && previous.fence === imageReadCacheFence(machine)) return;
      if (previous && previous.scope === scope && previous.fence === imageReadCacheFence(machine)) return;
      if (previous && previous.scope !== null) void invalidate(machine);
      else if (previous) revoke(machine);
      const context = { scope, epoch: ++epoch, fence: imageReadCacheFence(machine) };
      contexts.set(machine, context);
      if (scope !== null && context.fence !== null) {
        const pending = clears;
        clears = pending.then(async () => {
          const valid = () => !disposed && contexts.get(machine) === context && context.fence === imageReadCacheFence(machine);
          if (!valid()) return;
          const target = disk === undefined ? disk = createStorage() : disk;
          if (target?.retainScope) await target.retainScope(machine, scope, valid);
        }).catch(() => { /* Optional IDB failure keeps the authenticated bounded L1 available. */ });
      }
      notify();
    },
    invalidate,
    register(proof: ImageReadProof) {
      const identity = parse(proof), key = proofKey(identity.proof.machine, proof.src);
      proofs.delete(key); proofs.set(key, { proof: identity.proof, epoch: identity.context.epoch });
      while (proofs.size > imageReadCacheLimits.entries) proofs.delete(proofs.keys().next().value!);
    },
    getProof(src: string, machine = selectedMachine()) {
      const item = machine ? proofs.get(proofKey(machine, src)) : undefined;
      return item?.epoch === (machine ? contexts.get(machine)?.epoch : undefined) ? item?.proof : undefined;
    },
    async invalidateSource(proof: ImageReadProof) {
      const identity = parse(proof); versions.delete(identity.key); versions.set(identity.key, ++retrySequence);
      memory.delete(identity.key); flights.get(identity.key)?.controller.abort(); flights.delete(identity.key);
      while (versions.size > imageReadCacheLimits.entries) versions.delete(versions.keys().next().value!);
      try { const target = await getDisk(); if (current(identity)) await target?.remove(identity.key); } catch { /* Force-read still skips old persistence. */ }
    },
    async acquire(proof: ImageReadProof, { signal, force = false }: { signal?: AbortSignal; force?: boolean } = {}): Promise<ImageReadLease> {
      signal?.throwIfAborted(); const identity = parse(proof); await clears; signal?.throwIfAborted();
      if (!current(identity)) throw new DOMException("Image read cancelled", "AbortError");
      const cached = !force ? memory.get(identity.key) : undefined;
      let blob = cached?.epoch === identity.context.epoch && cached.fence === identity.context.fence ? cached.blob : undefined;
      if (blob) { memory.delete(identity.key); memory.set(identity.key, cached!); }
      else {
        let flight = flights.get(identity.key);
        if (!flight) {
          const controller = new AbortController(), version = versions.get(identity.key) ?? 0;
          const next: Flight = { controller, consumers: 0, promise: Promise.resolve(new Blob()) };
          next.promise = load(identity, controller, force, version).then(loaded => {
            if (!current(identity) || controller.signal.aborted || version !== (versions.get(identity.key) ?? 0)) throw new DOMException("Image read cancelled", "AbortError");
            memory.delete(identity.key); memory.set(identity.key, { key: identity.key, machine: identity.proof.machine, blob: loaded, epoch: identity.context.epoch, fence: identity.context.fence }); prune(); return loaded;
          }).finally(() => { if (flights.get(identity.key) === next) flights.delete(identity.key); });
          void next.promise.catch(() => {}); flights.set(identity.key, next); flight = next;
        }
        const shared = flight; shared.consumers++;
        let abort: (() => void) | undefined;
        try {
          const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal?.reason); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); });
          blob = await (signal ? Promise.race([shared.promise, cancelled]) : shared.promise);
        } finally {
          if (abort) signal?.removeEventListener("abort", abort);
          if (--shared.consumers === 0 && flights.get(identity.key) === shared) { shared.controller.abort(); flights.delete(identity.key); }
        }
      }
      signal?.throwIfAborted(); if (!current(identity)) throw new DOMException("Image read cancelled", "AbortError");
      if (identity.proof.mime !== undefined && identity.proof.mime !== blob.type ||
          identity.proof.size !== undefined && identity.proof.size !== blob.size) throw new ImageReadError();
      // An explicit retry can hold an older lease in another view. Its URL
      // remains valid until that view releases it, independently of new bytes.
      const urlKey = JSON.stringify([identity.proof.machine, identity.key, identity.context.epoch, versions.get(identity.key) ?? 0]);
      let entry = urls.get(urlKey);
      if (!entry || entry.blob !== blob) { entry = { url: createObjectURL(blob), count: 0, blob, machine: identity.proof.machine, revoked: false }; urls.set(urlKey, entry); liveUrls.add(entry); }
      entry.count++; let released = false;
      return { url: entry.url, release() { if (released) return; released = true; if (--entry!.count === 0) {
        if (urls.get(urlKey) === entry) urls.delete(urlKey); liveUrls.delete(entry!);
        if (!entry!.revoked) { revokeObjectURL(entry!.url); entry!.revoked = true; }
      } } };
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version() { return epoch; },
    dispose() { if (disposed) return; revoke(); disposed = true; disk?.close(); unsubscribe(); listeners.clear(); },
  };
}

export const imageReadCache = createImageReadCache();
export const authorizeImageReadCache = imageReadCache.authorize;
export const invalidateImageReadCache = imageReadCache.invalidate;
export const registerImageReadProof = imageReadCache.register;
export const getRegisteredImageProof = imageReadCache.getProof;
// Reading-cache clear includes private images; this only observes revocation,
// never grants authentication or upgrades cached catalog metadata into proof.
subscribeReadingCacheInvalidation(event => { void invalidateImageReadCache(event.machine ?? undefined); });

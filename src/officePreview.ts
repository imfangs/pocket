import { OFFICE_PREVIEW_LIMITS as limits, OfficePreviewError, type OfficePreviewData, type OfficePreviewKind } from "./officePreviewTypes";
export * from "./officePreviewTypes";

type OfficeWorker = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror" | "onmessageerror">;
export function createOfficePreviewParser(factory: () => OfficeWorker, timeoutMs = limits.timeoutMs) {
  return (blob: Blob, kind: OfficePreviewKind, signal: AbortSignal): Promise<OfficePreviewData> => {
    if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    if (blob.size > limits.compressedBytes) return Promise.reject(new OfficePreviewError("limit"));
    return new Promise((resolve, reject) => {
      let worker: OfficeWorker | undefined, settled = false;
      const finish = (data?: OfficePreviewData, error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); signal.removeEventListener("abort", abort); worker?.terminate();
        if (error) reject(error); else resolve(data!);
      };
      const abort = () => finish(undefined, new DOMException("Cancelled", "AbortError"));
      const deadline = setTimeout(() => finish(undefined, new OfficePreviewError("timeout")), timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      try {
        worker = factory();
        worker.onmessage = event => {
          if (settled) return;
          const response = event.data;
          if (response?.ok === true && response.data?.kind === kind && Array.isArray(response.data.warnings)) finish(response.data);
          else finish(undefined, new OfficePreviewError(["limit", "unsupported", "invalid"].includes(response?.code) ? response.code : "invalid"));
        };
        worker.onerror = event => { event.preventDefault(); finish(undefined, new OfficePreviewError("invalid")); };
        worker.onmessageerror = () => finish(undefined, new OfficePreviewError("invalid"));
        // Each preview has a separate lifetime. Aborted workers cannot finish
        // a later source, and no private result cache outlives the modal.
        worker.postMessage({ blob, kind });
      } catch { finish(undefined, new OfficePreviewError("unsupported")); }
    });
  };
}
export const parseOfficePreview = createOfficePreviewParser(() => new Worker(new URL("./officePreview.worker.ts", import.meta.url), { type: "module" }));

export const apiRequestTimeoutMs = 25000;

// One budget owns the complete HTTP exchange, including body transfer and a
// known-CSRF recovery. A caller's narrower cancellation remains authoritative.
export function createRequestDeadline(parent?: AbortSignal, timeoutMs = apiRequestTimeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
    throw new RangeError("Invalid request timeout");
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason);
  const timer = parent?.aborted ? undefined : setTimeout(() => {
    controller.abort(new DOMException("连接较慢，请重试。", "TimeoutError"));
  }, timeoutMs);
  if (parent?.aborted) cancel(); else parent?.addEventListener("abort", cancel, { once: true });
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); parent?.removeEventListener("abort", cancel); },
  };
}

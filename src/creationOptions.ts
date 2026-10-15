import type { CreateLocation } from "./taskOperations";

export type CreationOptions = { available: boolean; locations: CreateLocation[] };
type ReaderOptions = {
  request: (signal: AbortSignal) => Promise<CreationOptions>;
  onData: (value: CreationOptions) => void;
  onError: (message: string) => void;
  onLoading: (loading: boolean) => void;
  timeoutMs?: number;
};

// The dialog may retry its read without resetting the user's input. Late or
// aborted responses never replace a newer read; reconnect gets one attempt.
export function createCreationOptionsReader(options: ReaderOptions) {
  let pending: Promise<void> | null = null, controller: AbortController | null = null;
  let disposed = false, failed = false, reconnected = false, reconnectAfterPending = false;
  const read = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    const current = new AbortController();
    controller = current;
    const timeout = setTimeout(() => current.abort(new DOMException("目录读取超时", "TimeoutError")), options.timeoutMs ?? 15000);
    options.onLoading(true);
    const operation = (async () => {
      try {
        // Race the signal as well as aborting fetch, so a stuck transport cannot
        // keep the form disabled or prevent an explicit retry indefinitely.
        const aborted = new Promise<never>((_, reject) => {
          current.signal.addEventListener("abort", () => reject(current.signal.reason), { once: true });
        });
        const data = await Promise.race([options.request(current.signal), aborted]);
        if (disposed || current.signal.aborted || controller !== current) return;
        failed = !data.available || !data.locations.length;
        options.onData(data);
        options.onError(failed ? "暂无可用工作目录，请重新读取。" : "");
      } catch (failure) {
        if (disposed || controller !== current) return;
        failed = true;
        options.onError((failure as Error)?.name === "TimeoutError"
          ? "读取目录超时，请重试。" : (failure as Error)?.message || "暂时无法读取工作目录，请重试。");
      } finally {
        clearTimeout(timeout);
        if (controller === current) {
          controller = null;
          if (!disposed) options.onLoading(false);
        }
      }
    })().finally(() => {
      if (pending === operation) pending = null;
      const followUp = reconnectAfterPending && failed && !disposed && !reconnected;
      reconnectAfterPending = false;
      if (followUp) { reconnected = true; void read(); }
    });
    pending = operation;
    return operation;
  };
  return {
    read,
    reconnect() {
      if (disposed || reconnected) return pending ?? Promise.resolve();
      if (pending) { reconnectAfterPending = true; return pending; }
      if (!failed) return Promise.resolve();
      reconnected = true;
      return read();
    },
    offline() { reconnected = false; reconnectAfterPending = false; },
    dispose() { disposed = true; controller?.abort(); },
  };
}

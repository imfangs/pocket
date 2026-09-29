export type SubmissionReceipt = {
  requestId: string;
  status: "accepted" | "queued" | "pending" | "unknown" | "rejected" | "not_found";
  code?: string;
};

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason);return; }
    const abort = () => { clearTimeout(timer);signal.removeEventListener("abort", abort);reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort);resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// This callback is a receipt GET, never the original POST. Unknown outcomes stop
// here and remain available for an explicit later check.
export async function waitForSubmission(
  initial: SubmissionReceipt,
  read: (signal: AbortSignal) => Promise<SubmissionReceipt>,
  signal: AbortSignal,
  options = { intervalMs: 1500, maxWaitMs: 65000 },
) {
  let receipt = initial;
  const started = Date.now();
  while (receipt.status === "pending" && Date.now() - started < options.maxWaitMs) {
    await delay(options.intervalMs, signal);
    receipt = await read(AbortSignal.any([signal, AbortSignal.timeout(10000)]));
    if (receipt.requestId !== initial.requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
  }
  return receipt;
}

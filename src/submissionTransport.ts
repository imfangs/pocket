import type { SubmissionReceipt } from "./submissionReceipt";

export const submissionTransportLimits = { postMs: 18000, readMs: 10000 } as const;

// A submitted POST survives navigation, but a lost HTTP response cannot hold
// the composer/reload guard forever. Cancelling its transport does not cancel
// the remote turn: the caller retains the original ID with an unknown result.
// A receipt-only GET belongs to the current view and can be abandoned safely.
export async function requestSubmissionReceipt(
  requestId: string,
  request: (signal: AbortSignal) => Promise<SubmissionReceipt>,
  options: { kind: "post" | "read"; viewSignal: AbortSignal; timeout?: (ms: number) => AbortSignal },
) {
  options.viewSignal.throwIfAborted();
  const deadline = (options.timeout ?? (ms => AbortSignal.timeout(ms)))(
    options.kind === "post" ? submissionTransportLimits.postMs : submissionTransportLimits.readMs,
  );
  const signal = options.kind === "post" ? deadline : AbortSignal.any([deadline, options.viewSignal]);
  const receipt = await request(signal);
  signal.throwIfAborted();
  if (receipt.requestId !== requestId) throw new Error("回执与当前消息不匹配，请重新核对。");
  return receipt;
}

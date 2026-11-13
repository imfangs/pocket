// @ts-check
// Let the original operation finish exactly once; HTTP waits only for a short
// acknowledgement window. Subsequent requests read the same durable receipt.
/**
 * @template {import('../shared/submission-contracts.ts').DispatchReceiptIdentity} T
 * @template {import('../shared/submission-contracts.ts').DispatchReceiptIdentity} R
 * @param {Promise<T>} operation The already-started original operation.
 * @param {() => R} receipt A read of that same durable request, never a replay.
 * @param {number} [waitMs]
 * @returns {Promise<{status: 200, data: T} | {status: 202, data: R}>}
 */
export async function dispatchResponse(operation, receipt, waitMs = 1000) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const pending = Symbol('pending');
  try {
    const result = await Promise.race([
      operation,
      new Promise(/** @param {(value: typeof pending) => void} resolve */ resolve => { timer = setTimeout(() => resolve(pending), waitMs); }),
    ]);
    return result === pending ? { status: 202, data: receipt() } : { status: 200, data: result };
  } finally { clearTimeout(timer); }
}

// Let the original operation finish exactly once; HTTP waits only for a short
// acknowledgement window. Subsequent requests read the same durable receipt.
export async function dispatchResponse(operation, receipt, waitMs = 1000) {
  let timer;
  const pending = Symbol('pending');
  try {
    const result = await Promise.race([
      operation,
      new Promise(resolve => { timer = setTimeout(() => resolve(pending), waitMs); }),
    ]);
    return result === pending ? { status: 202, data: receipt() } : { status: 200, data: result };
  } finally { clearTimeout(timer); }
}

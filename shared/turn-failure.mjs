const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, limit) : '';
const identity = value => typeof value === 'string' && value.trim() && value.length <= 128;

// A diagnostic only: never a message, permission, read watermark or receipt.
export function turnFailureFromError(turnId, error, timestamp) {
  if (!identity(turnId) || !record(error)) return null;
  const message = text(error.message, 2000), details = text(error.additionalDetails ?? error.additional_details, 4000);
  const code = text(error.code ?? error.codexErrorInfo ?? error.codex_error_info, 128);
  return { turnId, status: 'failed', ...(message ? { message } : {}),
    ...(/^[A-Za-z0-9_:-]+$/.test(code) ? { code } : {}),
    ...(details ? { additionalDetails: details } : {}),
    ...(typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= 8640000000000000 ? { timestamp } : {}) };
}

export function normalizeTurnFailures(value) {
  if (!Array.isArray(value)) return [];
  const result = new Map();
  for (const item of value.slice(-30)) {
    if (!record(item) || item.status !== undefined && item.status !== 'failed') continue;
    const failure = turnFailureFromError(item.turnId, item, item.timestamp);
    if (failure) result.set(failure.turnId, failure);
  }
  return [...result.values()];
}

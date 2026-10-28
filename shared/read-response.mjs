export const READ_VERSION_HEADER = 'X-Pocket-Read-Version';
export const CHECKED_AT_HEADER = 'X-Pocket-Checked-At';
export const SOURCE_SYNCED_AT_HEADER = 'X-Pocket-Source-Synced-At';
export const TURN_OBSERVED_AT_HEADER = 'X-Pocket-Turn-Observed-At';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
const conversationPath = /^\/api\/tasks\/[a-f0-9-]{36}\/(transcript|history)$/i;

export function readResponseKind(path, method = 'GET') {
  if (method === 'POST' && path === '/api/sync') return 'sync';
  if (method !== 'GET') return null;
  if (path === '/api/catalog') return 'catalog';
  return conversationPath.exec(path)?.[1].toLowerCase() ?? null;
}

export const isReadVersion = value => typeof value === 'string' && /^W\/"pocket-read-v1-[a-f0-9]{64}"$/.test(value);

function observations(kind, data) {
  if (!record(data)) return [];
  const fields = [];
  // These are response/scan observation times, not content, permission or
  // execution changes. Preserve their exact values separately on every reply.
  if (['history', 'transcript'].includes(kind) && timestamp(data.checkedAt))
    fields.push({ path: 'checkedAt', header: CHECKED_AT_HEADER, value: data.checkedAt });
  if (['catalog', 'sync'].includes(kind) && record(data.sourceInfo) && timestamp(data.sourceInfo.syncedAt))
    fields.push({ path: 'sourceInfo.syncedAt', parent: 'sourceInfo', key: 'syncedAt', header: SOURCE_SYNCED_AT_HEADER, value: data.sourceInfo.syncedAt });
  // desktop-bridge.py samples wall time here, even for a completed turn.
  // Rollout observedAt is a source-record timestamp and remains versioned.
  if (kind === 'history' && data.source === 'desktop' && record(data.turnTiming) && timestamp(data.turnTiming.observedAt))
    fields.push({ path: 'turnTiming.observedAt', parent: 'turnTiming', key: 'observedAt', header: TURN_OBSERVED_AT_HEADER, value: data.turnTiming.observedAt });
  return fields;
}

export function splitReadResponse(kind, data) {
  const fields = observations(kind, data), content = record(data) ? { ...data } : data;
  for (const field of fields) {
    if (field.parent) {
      content[field.parent] = { ...content[field.parent] };
      delete content[field.parent][field.key];
    } else delete content[field.path];
  }
  return { content, observationKeys: fields.map(field => field.path),
    headers: Object.fromEntries(fields.map(field => [field.header, String(field.value)])) };
}

// A not-modified response is usable only with all observations that belonged
// to its saved body. Missing or malformed metadata requires a full read.
export function hydrateReadResponse(kind, data, headers) {
  const fields = observations(kind, data), result = record(data) ? { ...data } : data;
  for (const field of fields) {
    const raw = headers.get(field.header);
    if (typeof raw !== 'string' || !/^(?:0|[1-9]\d*)$/.test(raw) || !timestamp(Number(raw))) return null;
    const value = Number(raw);
    if (field.parent) result[field.parent] = { ...result[field.parent], [field.key]: value };
    else result[field.path] = value;
  }
  return result;
}

import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { visibleContent, parseHistory } from './history.mjs';
import { resolveHistorySource, iterateHistoryChunks, readHistoryRanges } from './history-source.mjs';
import { AppError } from './store.mjs';
import { POCKET_CONTENT } from './pocket-content.mjs';

const defaults = Object.freeze({ maxMessages: 100000, maxReferences: 200000, maxRecords: 1000000,
  maxIndexBytes: 24 * 1024 * 1024, maxCachedIndexBytes: 32 * 1024 * 1024,
  maxSnapshots: 4, maxRecordBytes: 8 * 1024 * 1024, ttlMs: 15 * 60 * 1000 });
const limits = Object.fromEntries(Object.entries(defaults).map(([key, maximum]) =>
  [key, Math.max(1, Math.min(maximum, workerData?.limits?.[key] ?? maximum))]));
const sourceLimits = workerData?.limits?.sourceLimits;
const secret = randomBytes(32), snapshots = new Map();
const digest = () => createHash('sha256');
const changed = () => new AppError('历史分页位置已失效，请重新载入历史', 409);
const exceeded = () => new AppError('这份会话历史超过了单次读取限制', 413);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const validId = value => typeof value === 'string' && value.length <= 1024;

async function sourceFor(codexHome, threadId) {
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'), { readOnly: true });
  let row;
  try { row = db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(threadId); }
  finally { db.close(); }
  if (!row?.rollout_path) throw new AppError('暂时没有可读取的会话历史', 404);
  return resolveHistorySource({ filePath: row.rollout_path, codexHome, threadId }, { limits: sourceLimits });
}

function prune() {
  const now = Date.now();
  for (const [key, value] of snapshots) if (now - value.usedAt > limits.ttlMs) snapshots.delete(key);
  let bytes = [...snapshots.values()].reduce((sum, item) => sum + item.indexBytes, 0);
  while (snapshots.size > limits.maxSnapshots || bytes > limits.maxCachedIndexBytes) {
    const [key, oldest] = snapshots.entries().next().value;
    snapshots.delete(key); bytes -= oldest.indexBytes;
  }
}
function retain(snapshot) {
  snapshot.usedAt = Date.now();
  snapshots.delete(snapshot.key);
  snapshots.set(snapshot.key, snapshot);
  prune();
}

function cursor(snapshot, before) {
  const payload = Buffer.from(JSON.stringify([1, snapshot.key, before])).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
function decodeCursor(value) {
  try {
    const [payload, signed, extra] = value.split('.');
    const expected = createHmac('sha256', secret).update(payload).digest();
    const actual = Buffer.from(signed, 'base64url');
    if (extra || actual.length !== expected.length) throw new Error();
    const [version, key, before] = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (version !== 1 || typeof key !== 'string' || !Number.isSafeInteger(before) || before < 0) throw new Error();
    // A server/worker restart rotates its in-memory signing key. Well-formed
    // old tokens require the same reload path as an evicted snapshot.
    if (!timingSafeEqual(actual, expected)) throw changed();
    return { key, before };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('历史分页位置无效', 400);
  }
}

// Keep only record positions and display metadata. Raw text exists for one
// bounded record, and for the last assistant while resolving compacted wrappers.
async function indexSource(source, prefixEnd = null) {
  const rows = [], nativeIds = new Set(), summaries = new Set(), responses = new Map(), turns = new Map();
  let currentTurn = null, lastAssistant = null, records = 0, indexBytes = 0;
  let parts = [], length = 0, offset = 0, byteEnd = 0;
  const hash = digest(), prefixHash = prefixEnd == null ? null : digest();
  function remember(collection, key, value) {
    if (!collection.has(key)) indexBytes += Buffer.byteLength(String(key)) + 128;
    if (collection instanceof Map) collection.set(key, value);
    else collection.add(key);
  }
  function record(bytes, start, end) {
    if (++records > limits.maxRecords) throw exceeded();
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { return; } // A live append may finish with an incomplete record.
    const item = value.payload, timestamp = Date.parse(value.timestamp);
    const type = item?.type === 'turn_started' ? 'task_started' : item?.type === 'turn_complete' ? 'task_complete' : item?.type;
    if (value.type === 'event_msg' && type === 'item_completed' && item.item?.type === 'AgentMessage' && validId(item.item.id))
      remember(nativeIds, item.item.id);
    if (value.type === 'token_usage_record' && validId(item?.response_id) && lastAssistant)
      remember(responses, item.response_id, lastAssistant.row);
    if (value.type === 'compacted') {
      const summary = responses.get(item?.compaction_response_id);
      if (summary) remember(summaries, summary.offset);
      else if (lastAssistant?.text && typeof item?.message === 'string' && (
        item.message.trim() === lastAssistant.text.trim() ||
        item.message.trimEnd().endsWith('\n' + lastAssistant.text.trim())
      )) remember(summaries, lastAssistant.row.offset);
    }
    if (value.type === 'turn_context' && validId(item?.turn_id)) currentTurn = item.turn_id;
    if (value.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(type)) {
      const id = item.turn_id || (type === 'turn_aborted' ? currentTurn : null);
      if (validId(id) && Number.isFinite(timestamp)) {
        const turn = turns.get(id) || { startedAt: null, durationMs: null };
        if (type === 'task_started') {
          Object.assign(turn, { startedAt: timestamp, durationMs: null });
          currentTurn = id; lastAssistant = null;
        } else turn.durationMs = finite(item.duration_ms) ??
          (turn.startedAt == null ? null : finite(timestamp - turn.startedAt));
        remember(turns, id, turn);
      }
    }
    if (value.type === 'response_item' && item?.type === 'message' &&
      ['user', 'assistant'].includes(item.role) && item.phase !== 'analysis' && item.channel !== 'analysis') {
      const { text, hasMedia } = visibleContent(item);
      if (text || hasMedia) {
        const row = { offset: start, length: end - start,
          id: validId(item.id) && item.id ? item.id : `rollout:${start}`, role: item.role,
          turnId: validId(item.internal_chat_message_metadata_passthrough?.turn_id)
            ? item.internal_chat_message_metadata_passthrough.turn_id : currentTurn,
          phase: validId(item.phase) ? item.phase : undefined,
          timestamp: Number.isFinite(timestamp) ? timestamp : null, textLength: Math.min(text.length, 24000) };
        indexBytes += Buffer.byteLength(JSON.stringify(row)) + 128;
        if (rows.length >= limits.maxMessages || indexBytes > limits.maxIndexBytes) throw exceeded();
        rows.push(row);
        if (item.role === 'assistant') lastAssistant = { row, text };
      }
    }
    if (indexBytes > limits.maxIndexBytes || responses.size + nativeIds.size + turns.size + summaries.size > limits.maxReferences)
      throw exceeded();
  }
  for await (const chunk of iterateHistoryChunks(source, { limits: sourceLimits })) {
    hash.update(chunk);
    if (prefixHash && byteEnd < prefixEnd) prefixHash.update(chunk.subarray(0, Math.min(chunk.length, prefixEnd - byteEnd)));
    byteEnd += chunk.length;
    let begin = 0;
    while (begin < chunk.length) {
      const lf = chunk.indexOf(10, begin), end = lf < 0 ? chunk.length : lf + 1;
      const piece = chunk.subarray(begin, end);
      length += piece.length;
      if (length > limits.maxRecordBytes) throw exceeded();
      parts.push(piece);
      if (lf < 0) break;
      record(Buffer.concat(parts, length), offset, offset + length);
      offset += length; parts = []; length = 0; begin = end;
    }
  }
  if (length) record(Buffer.concat(parts, length), offset, offset + length);
  const messages = rows.filter(row => row.textLength && (!summaries.has(row.offset) || nativeIds.has(row.id)));
  const marked = new Set();
  for (let i = messages.length - 1; i >= 0; i--) {
    const row = messages[i], duration = turns.get(row.turnId)?.durationMs;
    if (row.role === 'assistant' && ['final', 'final_answer'].includes(row.phase) && duration != null && !marked.has(row.turnId)) {
      row.turnDurationMs = duration; marked.add(row.turnId);
    }
  }
  return { key: randomBytes(18).toString('hex'), source, messages, indexBytes, byteEnd,
    hash: hash.digest('hex'), prefixHash: prefixHash?.digest('hex'), validatedVersion: source.version, usedAt: Date.now() };
}

async function page({ codexHome, threadId, before: token, limit }) {
  prune();
  const position = token ? decodeCursor(token) : null;
  let snapshot = position ? snapshots.get(position.key) : null;
  if (position && (!snapshot || snapshot.source.threadId !== threadId)) throw changed();
  const source = await sourceFor(codexHome, threadId);
  if (position && (snapshot.source.codexHome !== source.codexHome || snapshot.source.identity !== source.identity)) throw changed();
  if (!snapshot) snapshot = [...snapshots.values()].find(value => value.source.threadId === threadId &&
    value.source.codexHome === source.codexHome && value.source.identity === source.identity && value.source.version === source.version);
  if (!snapshot) snapshot = await indexSource(source);
  else if (snapshot.validatedVersion !== source.version) {
    // A larger file is not sufficient proof of append-only history. Verify its
    // entire old prefix in the worker, and refresh cross-boundary visibility so
    // a newly appended compacted event cannot expose an older internal summary.
    if (source.compression !== 'none' || source.size <= snapshot.source.size) throw changed();
    const current = await indexSource(source, snapshot.byteEnd);
    if (current.prefixHash !== snapshot.hash || current.byteEnd < snapshot.byteEnd) throw changed();
    snapshot.messages = current.messages.filter(row => row.offset < snapshot.byteEnd);
    snapshot.validatedVersion = source.version;
  }
  const boundary = position?.before ?? snapshot.byteEnd;
  if (boundary > snapshot.byteEnd) throw changed();
  const selected = [];
  let budget = 160000, start = snapshot.messages.length;
  for (let i = snapshot.messages.length - 1; i >= 0; i--) {
    const row = snapshot.messages[i];
    if (row.offset >= boundary) continue;
    if (selected.length >= limit || row.textLength > budget) break;
    selected.push(row); budget -= row.textLength; start = i;
  }
  selected.reverse();
  const buffers = await readHistoryRanges(source, selected.map(row => ({ startOffset: row.offset, endOffset: row.offset + row.length })),
    { limits: sourceLimits });
  const messages = selected.map((row, index) => {
    let record;
    try { record = JSON.parse(buffers[index].toString('utf8')); }
    catch { throw changed(); }
    const { text } = visibleContent(record.payload);
    const { offset: _offset, length: _length, textLength: _textLength, ...message } = row;
    return { ...message, text: text.slice(0, 24000), truncated: text.length > 24000 };
  });
  retain(snapshot);
  const hasMore = selected.length > 0 && start > 0;
  return { source: 'rollout', messages, hasMore, nextCursor: hasMore ? cursor(snapshot, selected[0].offset) : null,
    page: { kind: token ? 'older' : 'recent' } };
}

async function recent({ codexHome, threadId }) {
  const source = await sourceFor(codexHome, threadId);
  const tail = [], maximum = 4 * 1024 * 1024 + 1;
  let kept = 0, size = 0;
  for await (const chunk of iterateHistoryChunks(source, { limits: sourceLimits })) {
    tail.push(chunk); kept += chunk.length; size += chunk.length;
    while (kept > maximum) {
      const remove = Math.min(tail[0].length, kept - maximum);
      if (remove === tail[0].length) tail.shift();
      else tail[0] = tail[0].subarray(remove);
      kept -= remove;
    }
  }
  // Retain one byte before the legacy 4 MiB boundary, then skip the clipped
  // record before decoding UTF-8. Native and fallback IDs remain identical.
  const buffer = Buffer.concat(tail, kept), start = Math.max(0, size - 4 * 1024 * 1024);
  const end = start ? buffer.indexOf(10) : -1;
  const skip = start ? (end < 0 ? buffer.length : end + 1) : 0;
  const offset = size - buffer.length + skip;
  const { [POCKET_CONTENT]: candidate, ...parsed } = parseHistory(buffer.subarray(skip).toString('utf8'), offset);
  return { data: { source: 'rollout', ...parsed, hasMore: start > 0 || parsed.hasMore,
    runtime: 'unavailable', canSend: false, hint: '历史已载入，连接后可发送。' },
  evidence: { candidate, file: source.file, version: source.contentVersion } };
}

// Stream/decode work is async, but its per-source indexes and memory budget are
// shared: serialize requests inside this worker as well as bounding the queue.
let active = Promise.resolve();
parentPort.on('message', request => {
  active = active.then(async () => {
    try {
      parentPort.postMessage({ id: request.id, ...(request.kind === 'recent'
        ? await recent(request) : { data: await page(request) }) });
    }
    catch (error) {
      parentPort.postMessage({ id: request.id, error: { status: error instanceof AppError ? error.status : 503,
        message: error instanceof AppError ? error.message : '历史读取暂时不可用，请重试' } });
    }
  });
});

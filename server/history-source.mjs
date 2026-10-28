import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import { AppError } from './store.mjs';
import { contentFileVersion } from './pocket-content.mjs';

// All offsets are bytes in the original JSONL, including LF bytes. A compressed
// source is never expanded on disk. Callers may lower, but not remove, limits.
export const HISTORY_SOURCE_LIMITS = Object.freeze({
  maxDecodedBytes: 512 * 1024 * 1024,
  maxCompressedBytes: 256 * 1024 * 1024,
  maxLineBytes: 32 * 1024 * 1024,
  maxHeaderBytes: 64 * 1024,
  maxRangeBytes: 32 * 1024 * 1024,
  maxRanges: 80,
  timeoutMs: 30000,
  maxExpansionRatio: 1024,
  ratioSlackBytes: 1024 * 1024,
  windowLogMax: 26,
});
const CHUNK_BYTES = 64 * 1024;
const error = (message, status, code) => Object.assign(new AppError(message, status), { code });
const changed = () => error('会话历史正在变化，请稍后重试', 409, 'HISTORY_SOURCE_CHANGED');
const limitExceeded = () => error('这份会话历史超过了单次读取限制', 413, 'HISTORY_SOURCE_LIMIT');
const timedOut = () => error('会话历史读取超时，请重试', 504, 'HISTORY_SOURCE_TIMEOUT');
const digest = values => createHash('sha256').update(JSON.stringify(values.map(String))).digest('hex');
const versionOf = value => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
const identityOf = (file, value) => digest([file, value.dev, value.ino, value.birthtimeNs]);
const inRoots = (file, home) => ['sessions', 'archived_sessions'].some(dir => file.startsWith(join(home, dir) + sep));

function limitsFor(options = {}) {
  const result = {};
  for (const [key, maximum] of Object.entries(HISTORY_SOURCE_LIMITS)) {
    const value = options[key] ?? options.limits?.[key] ?? maximum;
    if (!Number.isSafeInteger(value) || value < (key === 'ratioSlackBytes' ? 0 : 1))
      throw error('会话历史读取参数无效', 400, 'HISTORY_SOURCE_OPTIONS');
    result[key] = Math.min(value, maximum);
  }
  return result;
}

async function selectedFile(requestedFile, home) {
  let file;
  try { file = await realpath(requestedFile); }
  catch (cause) {
    // Do not search nearby files or fall back after permission/type failures.
    if (cause.code !== 'ENOENT' || requestedFile.endsWith('.zst')) throw cause;
    file = await realpath(requestedFile + '.zst');
  }
  if (!inRoots(file, home)) throw error('会话历史位置不在允许的来源目录', 403, 'HISTORY_SOURCE_LOCATION');
  return file;
}

async function openRegular(file) {
  // O_NONBLOCK prevents a substituted FIFO from hanging before fstat. Opening
  // the canonical path without following the final link closes the other race.
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const value = await handle.stat({ bigint: true });
    if (!value.isFile()) throw error('会话历史不是普通文件', 403, 'HISTORY_SOURCE_TYPE');
    if (value.size > BigInt(Number.MAX_SAFE_INTEGER)) throw limitExceeded();
    return { handle, stat: value };
  } catch (cause) { await handle.close(); throw cause; }
}

async function assertCurrent(source, handle) {
  try {
    const [opened, current, selected] = await Promise.all([
      handle.stat({ bigint: true }), stat(source.file, { bigint: true }),
      selectedFile(source.requestedFile, source.codexHome),
    ]);
    if (selected !== source.file || !opened.isFile() || !current.isFile() ||
      identityOf(source.file, opened) !== source.identity || identityOf(source.file, current) !== source.identity ||
      versionOf(opened) !== source.version || versionOf(current) !== source.version) throw changed();
  } catch (cause) {
    if (cause.code === 'HISTORY_SOURCE_CHANGED') throw cause;
    throw changed();
  }
}

/** Resolve exactly the saved path, or its .zst sibling only when absent. */
export async function resolveHistorySource({ filePath, codexHome, threadId }, options = {}) {
  if (typeof filePath !== 'string' || !filePath || typeof threadId !== 'string' || !threadId)
    throw error('暂时没有可读取的会话历史', 404, 'HISTORY_SOURCE_MISSING');
  const home = await realpath(codexHome);
  const requestedFile = isAbsolute(filePath) ? resolve(filePath) : resolve(home, filePath);
  const file = await selectedFile(requestedFile, home);
  const { handle, stat: value } = await openRegular(file);
  const source = Object.freeze({
    file, requestedFile, codexHome: home, threadId,
    compression: file.endsWith('.zst') ? 'zstd' : 'none',
    identity: identityOf(file, value), version: versionOf(value),
    contentVersion: contentFileVersion(value), size: Number(value.size),
  });
  try { await assertCurrent(source, handle); }
  finally { await handle.close(); }
  const limits = limitsFor(options);
  const pieces = [];
  let length = 0, complete = false;
  for await (const chunk of iterateHistoryChunks(source, { ...options, startOffset: 0, endOffset: undefined })) {
    const lf = chunk.indexOf(10);
    const part = lf < 0 ? chunk : chunk.subarray(0, lf);
    length += part.length;
    if (length > limits.maxHeaderBytes) throw limitExceeded();
    pieces.push(part);
    if (lf >= 0) { complete = true; break; }
  }
  try {
    const meta = JSON.parse(Buffer.concat(pieces, length).toString('utf8'));
    if (meta.type !== 'session_meta' || meta.payload?.id !== threadId || (!complete && !length)) throw new Error();
  } catch {
    throw error('会话历史身份不匹配', 409, 'HISTORY_SOURCE_SESSION');
  }
  return source;
}

function offset(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw error('会话历史读取位置无效', 400, 'HISTORY_SOURCE_OFFSET');
  return result;
}

/** Yield only the requested decoded interval; zstd must decode its prefix. */
export async function* iterateHistoryChunks(source, options = {}) {
  const limits = limitsFor(options);
  const startOffset = offset(options.startOffset, 0);
  const endOffset = offset(options.endOffset, Number.MAX_SAFE_INTEGER);
  if (endOffset < startOffset) throw error('会话历史读取位置无效', 400, 'HISTORY_SOURCE_OFFSET');
  if (!inRoots(source.file, source.codexHome)) throw error('会话历史位置不在允许的来源目录', 403, 'HISTORY_SOURCE_LOCATION');
  const { handle } = await openRegular(source.file);
  let input, decoder, terminalError, timer, signalListener;
  const stop = cause => {
    terminalError ||= cause;
    input?.destroy(terminalError);
    decoder?.destroy(terminalError);
  };
  const check = () => { if (terminalError) throw terminalError; };
  const rawChunks = async function* (start, end) {
    let position = start;
    while (position < end) {
      check();
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      check();
      if (bytesRead !== buffer.length) throw changed();
      position += bytesRead;
      yield buffer;
    }
  };
  try {
    await assertCurrent(source, handle);
    signalListener = () => stop(error('会话历史读取已取消', 499, 'HISTORY_SOURCE_ABORTED'));
    options.signal?.addEventListener('abort', signalListener, { once: true });
    if (options.signal?.aborted) signalListener();
    timer = setTimeout(() => stop(timedOut()), limits.timeoutMs);
    timer.unref?.();
    check();
    if (source.compression === 'zstd' && source.size > limits.maxCompressedBytes) throw limitExceeded();
    if (endOffset === startOffset) return;
    const compressed = source.compression === 'zstd';
    let stream;
    if (compressed) {
      if (typeof zlib.createZstdDecompress !== 'function')
        throw error('当前服务版本暂不支持压缩会话历史', 503, 'HISTORY_SOURCE_ZSTD_UNAVAILABLE');
      decoder = zlib.createZstdDecompress({ chunkSize: CHUNK_BYTES,
        params: { [zlib.constants.ZSTD_d_windowLogMax]: limits.windowLogMax } });
      input = Readable.from(rawChunks(0, source.size), { objectMode: false, highWaterMark: CHUNK_BYTES });
      input.on('error', cause => decoder.destroy(cause));
      // A corrupt frame must also stop the source reader; both errors are
      // observed, including destruction when a bounded prefix is sufficient.
      decoder.on('error', () => input.destroy());
      stream = input.pipe(decoder);
    } else stream = rawChunks(Math.min(startOffset, source.size), Math.min(endOffset, source.size));
    let decoded = compressed ? 0 : startOffset, consumed = 0;
    for await (const chunk of stream) {
      check();
      consumed += chunk.length;
      const next = decoded + chunk.length;
      if (consumed > limits.maxDecodedBytes || (compressed &&
        next > source.size * limits.maxExpansionRatio + limits.ratioSlackBytes)) throw limitExceeded();
      const begin = Math.max(0, startOffset - decoded), end = Math.min(chunk.length, endOffset - decoded);
      if (end > begin) yield chunk.subarray(begin, end);
      decoded = next;
      if (decoded >= endOffset) break;
    }
    check();
  } catch (cause) {
    if (terminalError) throw terminalError;
    if (cause instanceof AppError) throw cause;
    throw error('会话历史暂时无法解码，请重试', 409, 'HISTORY_SOURCE_DECODE');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', signalListener);
    input?.destroy();
    decoder?.destroy();
    try { await assertCurrent(source, handle); }
    finally { await handle.close(); }
  }
}

/** One record at a time; LF belongs to endOffset, never to text. */
export async function* iterateHistoryLines(source, options = {}) {
  const limits = limitsFor(options);
  let pending = [], length = 0, startOffset = offset(options.startOffset, 0), lineNumber = 0;
  for await (const chunk of iterateHistoryChunks(source, options)) {
    let begin = 0;
    while (begin < chunk.length) {
      const lf = chunk.indexOf(10, begin), end = lf < 0 ? chunk.length : lf;
      const part = chunk.subarray(begin, end);
      length += part.length;
      if (length > limits.maxLineBytes) throw limitExceeded();
      pending.push(part);
      if (lf < 0) break;
      const endOffset = startOffset + length + 1;
      yield { text: Buffer.concat(pending, length).toString('utf8'), startOffset, endOffset, lineNumber: ++lineNumber };
      startOffset = endOffset;
      pending = []; length = 0; begin = lf + 1;
    }
  }
  if (length) yield { text: Buffer.concat(pending, length).toString('utf8'),
    startOffset, endOffset: startOffset + length, lineNumber: ++lineNumber };
}

/** Read many indexed records with one decompression, retaining only records. */
export async function readHistoryRanges(source, ranges, options = {}) {
  const limits = limitsFor(options);
  const deadline = performance.now() + limits.timeoutMs;
  const rangeOptions = () => {
    const timeoutMs = Math.floor(deadline - performance.now());
    if (timeoutMs < 1) throw timedOut();
    return { ...options, timeoutMs };
  };
  if (!Array.isArray(ranges) || ranges.length > limits.maxRanges) throw limitExceeded();
  let total = 0;
  const ordered = ranges.map((range, index) => {
    const startOffset = offset(range.startOffset, 0), endOffset = offset(range.endOffset, startOffset);
    if (endOffset < startOffset) throw error('会话历史读取位置无效', 400, 'HISTORY_SOURCE_OFFSET');
    total += endOffset - startOffset;
    if (total > limits.maxRangeBytes) throw limitExceeded();
    return { startOffset, endOffset, index, buffer: Buffer.alloc(endOffset - startOffset), written: 0 };
  }).sort((a, b) => a.startOffset - b.startOffset);
  if (!ordered.length) return [];
  // A single bounded scan skips tool payloads between selected records. For
  // ordinary files each disjoint range uses positional reads instead.
  if (source.compression === 'none') {
    for (const range of ordered) {
      for await (const chunk of iterateHistoryChunks(source, { ...rangeOptions(), startOffset: range.startOffset, endOffset: range.endOffset })) {
        chunk.copy(range.buffer, range.written); range.written += chunk.length;
      }
    }
  } else {
    let position = ordered[0].startOffset;
    const endOffset = Math.max(...ordered.map(range => range.endOffset));
    for await (const chunk of iterateHistoryChunks(source, { ...rangeOptions(), startOffset: position, endOffset })) {
      const end = position + chunk.length;
      for (const range of ordered) {
        const from = Math.max(position, range.startOffset), to = Math.min(end, range.endOffset);
        if (to > from) { chunk.copy(range.buffer, from - range.startOffset, from - position, to - position); range.written += to - from; }
      }
      position = end;
    }
  }
  rangeOptions();
  if (ordered.some(range => range.written !== range.buffer.length)) throw changed();
  return ordered.sort((a, b) => a.index - b.index).map(range => range.buffer);
}

export async function readHistoryRange(source, { startOffset = 0, endOffset, ...options }) {
  if (endOffset == null) throw error('会话历史读取位置无效', 400, 'HISTORY_SOURCE_OFFSET');
  return (await readHistoryRanges(source, [{ startOffset, endOffset }], options))[0];
}

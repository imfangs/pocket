import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError } from './store.mjs';

export const MAX_MESSAGE_MEDIA_BYTES = 512 * 1024 * 1024;
export const MESSAGE_MEDIA_CHUNK_BYTES = 64 * 1024;
const changed = () => new AppError('文件正在更新，请稍后重试', 409);

function rangeFor(value, size) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 256) return false;
  const text = value.trim();
  if (!/^bytes=/i.test(text)) return null; // Unknown range units are ignored.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(text);
  if (!match || !match[1] && !match[2] || !size) return false;
  const length = BigInt(size);
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    return suffix > 0n ? { start: suffix >= length ? 0 : Number(length - suffix), end: size - 1 } : false;
  }
  const start = BigInt(match[1]), end = match[2] ? BigInt(match[2]) : length - 1n;
  if (start >= length || end < start) return false;
  return { start: Number(start), end: end >= length ? size - 1 : Number(end) };
}
function ifRangeMatches(value, etag) {
  // Last-Modified has only second precision. Without the earlier response's
  // validator history we cannot prove a date is strong after a same-second
  // rewrite, so dates (like weak/list ETags) safely request the full response.
  return typeof value === 'string' && value.trim() === etag;
}

// The caller supplies an already-authorized FD and a pathname/identity verifier.
// Readable.from provides Node backpressure; neither probing nor streaming allocates
// a buffer proportional to the media size. close() also covers a never-read stream.
export async function openMessageMediaStream({ file, before, name, verify, reserve, kind, sniffType, readError, method = 'GET', range, ifRange, signal }) {
  let stream = null, closed = false, closing, release;
  const closeFile = () => {
    if (!closing) closing = file.close().catch(() => {}).finally(() => { release?.(); release = undefined; });
    return closing;
  };
  const close = async () => { closed = true; stream?.destroy(); await closeFile(); };
  const abort = () => { void close(); };
  try {
    if (!['GET', 'HEAD'].includes(method)) throw new AppError('请求方法不支持', 405);
    signal?.throwIfAborted();
    const size = Number(before.size), type = await sniffType(file, name, size);
    await verify(); signal?.throwIfAborted();
    const etag = `"${kind}-${createHash('sha256').update(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(before[key])).join(':')).digest('hex')}"`;
    const modified = new Date(Number(before.mtimeMs)).toUTCString();
    const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const headers = {
      'Content-Type': type, 'Content-Length': String(size), 'Content-Disposition': `inline; filename*=UTF-8''${encodedName}`,
      'Accept-Ranges': 'bytes', 'ETag': etag, 'Last-Modified': modified,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    // If-Range failure discards Range before even validating its syntax/extent.
    const selected = method === 'HEAD' || ifRange !== undefined && !ifRangeMatches(ifRange, etag) ? null : rangeFor(range, size);
    if (selected === false) {
      headers['Content-Range'] = `bytes */${size}`; headers['Content-Length'] = '0';
      await closeFile(); return { status: 416, headers, stream: null, close };
    }
    const start = selected?.start ?? 0, end = selected?.end ?? size - 1, status = selected ? 206 : 200;
    if (selected) { headers['Content-Range'] = `bytes ${start}-${end}/${size}`; headers['Content-Length'] = String(end - start + 1); }
    if (method === 'HEAD') { await closeFile(); return { status, headers, stream: null, close }; }
    release = reserve();
    async function* chunks() {
      try {
        let position = start;
        while (!closed && position <= end) {
          await verify();
          if (closed) return;
          const bytes = Buffer.alloc(Math.min(MESSAGE_MEDIA_CHUNK_BYTES, end - position + 1));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
          if (closed) return;
          if (!bytesRead) throw changed();
          await verify();
          if (closed) return;
          position += bytesRead;
          yield bytesRead === bytes.length ? bytes : bytes.subarray(0, bytesRead);
        }
      } catch (error) {
        if (!closed) throw error instanceof AppError ? error : readError(error);
      } finally { await closeFile(); }
    }
    stream = Readable.from(chunks(), { objectMode: false, highWaterMark: MESSAGE_MEDIA_CHUNK_BYTES });
    stream.once('close', () => { signal?.removeEventListener('abort', abort); void closeFile(); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) await close();
    return { status, headers, stream, close };
  } catch (error) { await closeFile(); throw error; }
}

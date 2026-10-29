import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { messageVideoType } from '../shared/message-media.mjs';
import { AppError } from './store.mjs';

export const MAX_MESSAGE_VIDEO_BYTES = 512 * 1024 * 1024;
export const MESSAGE_VIDEO_CHUNK_BYTES = 64 * 1024;
const PROBE_BYTES = 4096;
const videoBrands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'M4VH', 'M4VP', 'F4V ', 'MSNV', 'qt  ']);
const unavailable = () => new AppError('视频暂时无法读取', 404);
const changed = () => new AppError('文件正在更新，请稍后重试', 409);

function vint(bytes, offset, id = false) {
  if (offset >= bytes.length || !bytes[offset]) return null;
  let length = 1, marker = 0x80;
  while (!(bytes[offset] & marker)) { marker >>= 1; length++; }
  if (length > (id ? 4 : 8) || offset + length > bytes.length) return null;
  let value = BigInt(id ? bytes[offset] : bytes[offset] & (marker - 1));
  for (let index = 1; index < length; index++) value = value * 256n + BigInt(bytes[offset + index]);
  if (!id && value === (1n << BigInt(7 * length)) - 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { value: Number(value), length };
}
function webmHeader(bytes) {
  if (bytes.length < 5 || bytes.readUInt32BE(0) !== 0x1a45dfa3) return false;
  const header = vint(bytes, 4);
  if (!header) return false;
  const end = 4 + header.length + header.value;
  if (end > bytes.length) return false;
  let offset = 4 + header.length, found = false;
  while (offset < end) {
    const id = vint(bytes, offset, true);
    if (!id) return false;
    const size = vint(bytes, offset + id.length);
    if (!size) return false;
    const start = offset + id.length + size.length;
    if (start + size.value > end) return false;
    if (id.value === 0x4282) {
      if (found || !bytes.subarray(start, start + size.value).equals(Buffer.from('webm'))) return false;
      found = true;
    }
    offset = start + size.value;
  }
  return found;
}
function isoHeader(bytes, size, quicktime) {
  if (bytes.length < 8) return false;
  const firstSize = bytes.readUInt32BE(0), kind = bytes.toString('ascii', 4, 8);
  let headerSize = 8, boxSize = firstSize;
  if (firstSize === 1) {
    if (bytes.length < 16 || bytes.readBigUInt64BE(8) > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    boxSize = Number(bytes.readBigUInt64BE(8)); headerSize = 16;
  }
  if (boxSize < headerSize || boxSize > size) return false;
  if (kind === 'ftyp') return boxSize >= headerSize + 8 && boxSize <= bytes.length &&
    (boxSize - headerSize) % 4 === 0 && videoBrands.has(bytes.toString('ascii', headerSize, headerSize + 4));
  // Older QuickTime files can begin with their movie atom or a wide atom.
  if (!quicktime) return false;
  if (kind === 'moov') return boxSize >= 16;
  if (kind !== 'wide' || boxSize !== 8 || bytes.length < 16 || !['mdat', 'moov'].includes(bytes.toString('ascii', 12, 16))) return false;
  const nextSize = bytes.readUInt32BE(8);
  return nextSize === 0 || nextSize >= 8 && nextSize <= size - 8;
}
async function videoType(file, name, size) {
  const type = messageVideoType(name);
  if (!type) throw new AppError('暂不支持播放此视频格式', 415);
  const bytes = Buffer.alloc(Math.min(PROBE_BYTES, size));
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== bytes.length) throw changed();
  if (!(type === 'video/webm' ? webmHeader(bytes) : isoHeader(bytes, size, type === 'video/quicktime')))
    throw new AppError('文件内容不是支持的视频容器', 415);
  return type;
}

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
// a buffer proportional to the video size. close() also covers a never-read stream.
export async function openMessageVideoStream({ file, before, name, verify, reserve, method = 'GET', range, ifRange, signal }) {
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
    const size = Number(before.size), type = await videoType(file, name, size);
    await verify(); signal?.throwIfAborted();
    const etag = `"video-${createHash('sha256').update(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(before[key])).join(':')).digest('hex')}"`;
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
          const bytes = Buffer.alloc(Math.min(MESSAGE_VIDEO_CHUNK_BYTES, end - position + 1));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
          if (closed) return;
          if (!bytesRead) throw changed();
          await verify();
          if (closed) return;
          position += bytesRead;
          yield bytesRead === bytes.length ? bytes : bytes.subarray(0, bytesRead);
        }
      } catch (error) {
        if (!closed) throw error instanceof AppError ? error : unavailable();
      } finally { await closeFile(); }
    }
    stream = Readable.from(chunks(), { objectMode: false, highWaterMark: MESSAGE_VIDEO_CHUNK_BYTES });
    stream.once('close', () => { signal?.removeEventListener('abort', abort); void closeFile(); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) await close();
    return { status, headers, stream, close };
  } catch (error) { await closeFile(); throw error; }
}

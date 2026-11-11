import { messageVideoType } from '../shared/message-media.mjs';
import { AppError } from './store.mjs';

import { openMessageMediaStream } from './message-media-stream.mjs';
export { MAX_MESSAGE_MEDIA_BYTES as MAX_MESSAGE_VIDEO_BYTES, MESSAGE_MEDIA_CHUNK_BYTES as MESSAGE_VIDEO_CHUNK_BYTES } from './message-media-stream.mjs';
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

export function openMessageVideoStream(options) {
  return openMessageMediaStream({ ...options, kind: 'video', sniffType: videoType, readError: unavailable });
}

import { messageAudioType } from '../shared/message-media.mjs';
import { openMessageMediaStream } from './message-media-stream.mjs';
import { AppError } from './store.mjs';

export { MAX_MESSAGE_MEDIA_BYTES as MAX_MESSAGE_AUDIO_BYTES } from './message-media-stream.mjs';
const PROBE_BYTES = 4096;
const changed = () => new AppError('文件正在更新，请稍后重试', 409);
export function messageAudioReadError(error) {
  if (error instanceof AppError || error?.name === 'AbortError') return error;
  if (error?.code === 'EPERM' || error?.code === 'EACCES')
    return new AppError('Mac 服务无权读取这个音频，请在电脑上检查文件访问权限', 403);
  return new AppError('音频暂时无法读取', 404);
}
async function readProbe(file, size, position = 0) {
  const bytes = Buffer.alloc(Math.min(PROBE_BYTES, Math.max(0, size - position)));
  let read = 0;
  while (read < bytes.length) {
    const result = await file.read(bytes, read, bytes.length - read, position + read);
    if (!result.bytesRead) break;
    read += result.bytesRead;
  }
  if (read !== bytes.length) throw changed();
  return bytes;
}
function waveHeader(bytes, size) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return false;
  const end = bytes.readUInt32LE(4) + 8;
  if (end < 44 || end > size) return false;
  let offset = 12, format = false;
  while (offset + 8 <= Math.min(bytes.length, end)) {
    const kind = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > end) return false;
    if (kind === 'fmt ') {
      if (format || length < 16 || start + 16 > bytes.length) return false;
      const encoding = bytes.readUInt16LE(start), channels = bytes.readUInt16LE(start + 2), rate = bytes.readUInt32LE(start + 4);
      if (![1, 3, 0xfffe].includes(encoding) || !channels || channels > 32 || !rate || !bytes.readUInt16LE(start + 12)) return false;
      format = true;
    }
    if (kind === 'data') return format && length > 0;
    offset = start + length + (length % 2);
  }
  return false;
}
function m4aHeader(bytes, size) {
  if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false;
  let header = 8, length = bytes.readUInt32BE(0);
  if (length === 1) {
    if (bytes.length < 24 || bytes.readBigUInt64BE(8) > BigInt(Number.MAX_SAFE_INTEGER)) return false;
    length = Number(bytes.readBigUInt64BE(8)); header = 16;
  }
  if (length < header + 8 || length > Math.min(bytes.length, size) || (length - header) % 4) return false;
  // Audio-specific brands prevent a renamed image/video ftyp from qualifying.
  const brands = new Set(['M4A ', 'M4B ', 'F4A ', 'F4B ']);
  if (brands.has(bytes.toString('ascii', header, header + 4))) return true;
  for (let offset = header + 8; offset < length; offset += 4)
    if (brands.has(bytes.toString('ascii', offset, offset + 4))) return true;
  return false;
}
function adtsFrame(bytes, size) {
  if (bytes.length < 7 || bytes[0] !== 0xff || (bytes[1] & 0xf6) !== 0xf0 || (bytes[2] >> 2 & 15) > 12) return null;
  const channels = (bytes[2] & 1) * 4 + (bytes[3] >> 6), length = ((bytes[3] & 3) << 11) | (bytes[4] << 3) | (bytes[5] >> 5);
  const header = bytes[1] & 1 ? 7 : 9;
  return channels && length >= header && length <= size ? { length } : null;
}
function mpegFrame(bytes, size) {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1] & 0xe0) !== 0xe0) return null;
  const version = bytes[1] >> 3 & 3, layer = bytes[1] >> 1 & 3, bitrateIndex = bytes[2] >> 4, frequency = bytes[2] >> 2 & 3;
  if (version === 1 || !layer || !bitrateIndex || bitrateIndex === 15 || frequency === 3 || (bytes[3] & 3) === 2) return null;
  const rates = version === 3 ? (layer === 3 ? [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448]
    : layer === 2 ? [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384]
      : [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320])
    : layer === 3 ? [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
  const sampleRate = [44100,48000,32000][frequency] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  let length = Math.floor((layer === 3 ? 12 : layer === 1 && version !== 3 ? 72 : 144) * rates[bitrateIndex] * 1000 / sampleRate) + (bytes[2] >> 1 & 1);
  if (layer === 3) length *= 4;
  return length >= 4 && length <= size ? { length, version, layer, frequency } : null;
}
async function framedAudio(file, bytes, size, type) {
  let start = 0;
  if (type === 'audio/mpeg' && bytes.toString('ascii', 0, 3) === 'ID3') {
    const version = bytes[3], masks = { 2: 0xc0, 3: 0xe0, 4: 0xf0 };
    if (bytes.length < 10 || !masks[version] || bytes[4] === 255 || bytes[5] & ~masks[version] || bytes.subarray(6, 10).some(value => value & 0x80)) return false;
    start = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + (version === 4 && bytes[5] & 0x10 ? 10 : 0);
    if (start >= size) return false;
    bytes = await readProbe(file, size, start);
  }
  const parse = type === 'audio/aac' ? adtsFrame : mpegFrame, frame = parse(bytes, size - start);
  if (!frame) return false;
  const nextPosition = start + frame.length;
  if (nextPosition === size) return true;
  const next = parse(await readProbe(file, size, nextPosition), size - nextPosition);
  return !!next && (type !== 'audio/mpeg' || next.version === frame.version && next.layer === frame.layer && next.frequency === frame.frequency);
}
function oggAudioHeader(bytes, size) {
  if (bytes.length < 28 || bytes.toString('ascii', 0, 4) !== 'OggS' || bytes[4] !== 0 || bytes[5] !== 2 || bytes.readUInt32LE(18) !== 0) return false;
  const segments = bytes[26], start = 27 + segments;
  if (!segments || start > bytes.length) return false;
  let length = 0, complete = false;
  for (let index = 0; index < segments; index++) { length += bytes[27 + index]; if (bytes[27 + index] < 255) { complete = true; break; } }
  if (!complete || start + length > Math.min(bytes.length, size)) return false;
  const packet = bytes.subarray(start, start + length);
  if (packet.length >= 19 && packet.toString('ascii', 0, 8) === 'OpusHead') return packet[8] === 1 && packet[9] > 0;
  if (packet.length >= 51 && packet[0] === 127 && packet.toString('ascii', 1, 5) === 'FLAC')
    return packet[5] === 1 && packet[6] === 0 && packet.readUInt16BE(7) > 0 && flacHeader(packet.subarray(9), size);
  return packet.length >= 30 && packet[0] === 1 && packet.toString('ascii', 1, 7) === 'vorbis'
    && packet.readUInt32LE(7) === 0 && packet[11] > 0 && packet.readUInt32LE(12) > 0 && packet[29] === 1;
}
function flacHeader(bytes, size) {
  if (bytes.length < 42 || size <= 42 || bytes.toString('ascii', 0, 4) !== 'fLaC' || (bytes[4] & 0x7f) !== 0 || bytes.readUIntBE(5, 3) !== 34) return false;
  const minimum = bytes.readUInt16BE(8), maximum = bytes.readUInt16BE(10), info = bytes.readBigUInt64BE(18);
  const rate = Number(info >> 44n), depth = Number(info >> 36n & 31n) + 1;
  return minimum >= 16 && maximum >= minimum && rate > 0 && depth >= 4 && depth <= 32;
}
async function audioType(file, name, size) {
  const type = messageAudioType(name);
  if (!type) throw new AppError('暂不支持播放此音频格式', 415);
  const bytes = await readProbe(file, size);
  const valid = type === 'audio/wav' ? waveHeader(bytes, size) : type === 'audio/mp4' ? m4aHeader(bytes, size)
    : type === 'audio/ogg' ? oggAudioHeader(bytes, size) : type === 'audio/flac' ? flacHeader(bytes, size)
      : await framedAudio(file, bytes, size, type);
  if (!valid) throw new AppError('文件内容不是支持的音频容器', 415);
  return type;
}
export function openMessageAudioStream(options) {
  return openMessageMediaStream({ ...options, kind: 'audio', sniffType: audioType, readError: messageAudioReadError });
}

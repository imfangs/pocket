import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii'), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, checksum]);
}

// Real PNG bytes, entirely synthetic: RGBA, filter 0, no interlace or metadata.
export function syntheticPng({ width = 1200, height = 800, color = [70, 100, 140, 255] } = {}) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 4096)
      || !Array.isArray(color) || color.length !== 4 || !color.every(value => Number.isInteger(value) && value >= 0 && value <= 255))
    throw new RangeError('Invalid synthetic PNG dimensions or RGBA color');
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const row = Buffer.alloc(width * 4 + 1); row.fill(Buffer.from(color), 1);
  const pixels = Buffer.alloc(row.length * height);
  for (let y = 0; y < height; y++) row.copy(pixels, y * row.length);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 9 })), chunk('IEND')]);
}

export const imageSha256 = bytes => createHash('sha256').update(bytes).digest('hex');

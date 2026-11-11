// Locally generated protocol samples. Only WAV contains complete PCM samples;
// the other fixtures validate container sniffing/transport, not codec decoding.
export function wav(samples = 3200) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 8000) * 1000), 44 + index * 2);
  return bytes;
}
export function mp3(id3Bytes = 0) {
  const prefix = id3Bytes ? Buffer.alloc(id3Bytes + 10) : Buffer.alloc(0);
  if (prefix.length) {
    prefix.write('ID3', 0); prefix[3] = 4;
    for (let index = 0; index < 4; index++) prefix[9 - index] = id3Bytes >>> (index * 7) & 127;
  }
  const frames = Buffer.alloc(417 * 2);
  for (const offset of [0, 417]) Buffer.from([0xff, 0xfb, 0x90, 0]).copy(frames, offset);
  return Buffer.concat([prefix, frames]);
}
export function m4a(size = 8192, brand = 'M4A ') {
  const bytes = Buffer.alloc(size, 17);
  bytes.writeUInt32BE(24, 0); bytes.write('ftyp', 4); bytes.write(brand, 8);
  bytes.writeUInt32BE(0, 12); bytes.write('isommp42', 16);
  if (size >= 32) { bytes.writeUInt32BE(size - 24, 24); bytes.write('mdat', 28); }
  return bytes;
}
export function aac() {
  const length = 64, bytes = Buffer.alloc(length * 2);
  for (const offset of [0, length]) Buffer.from([0xff, 0xf1, 0x50, 0x80 | length >> 11, length >> 3, (length & 7) << 5 | 31, 0xfc]).copy(bytes, offset);
  return bytes;
}
export function ogg(codec = 'opus') {
  const packet = Buffer.alloc(codec === 'flac' ? 51 : codec === 'vorbis' ? 30 : 19);
  if (codec === 'opus') { packet.write('OpusHead'); packet[8] = 1; packet[9] = 1; packet.writeUInt32LE(8000, 12); }
  else if (codec === 'flac') { packet[0] = 127; packet.write('FLAC', 1); packet[5] = 1; packet.writeUInt16BE(1, 7); flac().subarray(0, 42).copy(packet, 9); }
  else { packet[0] = 1; packet.write('vorbis', 1); packet[11] = 1; packet.writeUInt32LE(8000, 12); packet[29] = 1; }
  const bytes = Buffer.alloc(28 + packet.length);
  bytes.write('OggS'); bytes[5] = 2; bytes[26] = 1; bytes[27] = packet.length; packet.copy(bytes, 28);
  return bytes;
}
export function flac() {
  const bytes = Buffer.alloc(64);
  bytes.write('fLaC'); bytes[4] = 128; bytes.writeUIntBE(34, 5, 3);
  bytes.writeUInt16BE(16, 8); bytes.writeUInt16BE(16, 10);
  bytes.writeBigUInt64BE(8000n << 44n | 15n << 36n | 16n, 18);
  return bytes;
}

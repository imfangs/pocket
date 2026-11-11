import { Inflate, zipSync } from "fflate-modern/browser";
import { OFFICE_PREVIEW_LIMITS as limits, OfficePreviewError, type OfficeArchiveEntry } from "./officePreviewTypes";

type ZipEntry = OfficeArchiveEntry & { offset: number; method: number; crc: number; start: number; end: number };
const crcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
export function officeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
const invalid = (): never => { throw new OfficePreviewError("invalid"); };
const limit = (): never => { throw new OfficePreviewError("limit"); };

function nameFromBytes(bytes: Uint8Array, utf8: boolean): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch {
    // Older ZIP tools use a legacy encoding without the UTF-8 flag. Names are
    // display-only and are never passed to a filesystem.
    if (utf8) return invalid();
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
export function normalizeOfficeEntryName(value: string): string {
  if (!value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return invalid();
  const name = value.replace(/\\/g, "/");
  if (name.startsWith("/") || name.split("/").some(part => part === ".." || part.includes(":"))) return invalid();
  const normalized = name.split("/").filter(part => part && part !== ".").join("/") + (name.endsWith("/") ? "/" : "");
  if (!normalized || normalized === "/") return invalid();
  return normalized;
}

function indexZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length > limits.compressedBytes) return limit();
  if (bytes.length < 22) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) { eocd = offset; break; }
  }
  if (eocd < 0 || view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true)) return invalid();
  const count = view.getUint16(eocd + 10, true), centralSize = view.getUint32(eocd + 12, true), centralStart = view.getUint32(eocd + 16, true);
  if (count === 65535 || centralSize === 0xffffffff || centralStart === 0xffffffff) throw new OfficePreviewError("unsupported");
  if (count > limits.entries) return limit();
  if (count !== view.getUint16(eocd + 8, true) || centralStart + centralSize !== eocd) return invalid();
  const entries: ZipEntry[] = [], names = new Set<string>();
  let cursor = centralStart, declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > eocd || view.getUint32(cursor, true) !== 0x02014b50) return invalid();
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true), compressedSize = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true), end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || view.getUint16(cursor + 34, true) || size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) return invalid();
    if (flags & (1 | 0x40 | 0x2000) || (method !== 0 && method !== 8)) throw new OfficePreviewError("unsupported");
    // Unix symlinks are unnecessary for a content preview and are not followed.
    if (((view.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000) throw new OfficePreviewError("unsupported");
    const originalName = nameFromBytes(bytes.subarray(cursor + 46, cursor + 46 + nameLength), !!(flags & 0x800));
    const name = normalizeOfficeEntryName(originalName), directory = name.endsWith("/");
    if (names.has(name) || (directory && size !== 0)) return invalid();
    names.add(name);
    declaredTotal += size;
    if (size > limits.entryBytes || declaredTotal > limits.expandedBytes) return limit();
    if (offset + 30 > centralStart || view.getUint32(offset, true) !== 0x04034b50 || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== method) return invalid();
    const localNameLength = view.getUint16(offset + 26, true), localExtraLength = view.getUint16(offset + 28, true), start = offset + 30 + localNameLength + localExtraLength;
    if (start + compressedSize > centralStart || nameFromBytes(bytes.subarray(offset + 30, offset + 30 + localNameLength), !!(flags & 0x800)) !== originalName) return invalid();
    if (!(flags & 8) && (view.getUint32(offset + 14, true) !== crc || view.getUint32(offset + 18, true) !== compressedSize || view.getUint32(offset + 22, true) !== size)) return invalid();
    entries.push({ name, directory, size, compressedSize, offset, method, crc, start, end: start + compressedSize });
    cursor = end;
  }
  if (cursor !== eocd) return invalid();
  const ordered = [...entries].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++) if (ordered[i].offset < ordered[i - 1].end) return invalid();
  return entries;
}

export function readBoundedOfficeArchive(bytes: Uint8Array, retain = true): { entries: OfficeArchiveEntry[]; files: Map<string, Uint8Array>; expandedSize: number } {
  const entries = indexZip(bytes), files = new Map<string, Uint8Array>();
  let expandedSize = 0;
  for (const entry of entries) {
    let length = 0;
    const chunks: Uint8Array[] = [];
    const consume = (chunk: Uint8Array) => {
      length += chunk.length;
      // Enforce observed output as well as declared sizes. A false central
      // directory size cannot cause an unbounded JSZip/Office allocation.
      if (length > entry.size || length > limits.entryBytes || expandedSize + length > limits.expandedBytes) return limit();
      if (chunk.length) chunks.push(chunk);
    };
    const payload = bytes.subarray(entry.start, entry.end);
    try {
      if (entry.method === 0) consume(payload);
      else {
        const inflater = new Inflate(consume);
        // A tiny input step bounds one inflater allocation even for a forged
        // DEFLATE stream, before its observed-size callback can reject it.
        if (!payload.length) inflater.push(payload, true);
        for (let position = 0; position < payload.length; position += 512)
          inflater.push(payload.subarray(position, position + 512), position + 512 >= payload.length);
      }
    } catch (error) {
      if (error instanceof OfficePreviewError) throw error;
      return invalid();
    }
    if (length !== entry.size) return invalid();
    const data = new Uint8Array(length);
    let position = 0;
    for (const chunk of chunks) { data.set(chunk, position); position += chunk.length; }
    if (officeCrc32(data) !== entry.crc) return invalid();
    expandedSize += length;
    if (retain && !entry.directory) files.set(entry.name, data);
  }
  return { entries: entries.map(({ name, size, compressedSize, directory }) => ({ name, size, compressedSize, directory })), files, expandedSize };
}

export function safeOfficeZip(files: Map<string, Uint8Array>): ArrayBuffer {
  const input: Record<string, Uint8Array> = Object.create(null);
  for (const [name, data] of files) input[name] = data;
  // Re-encoding stored entries removes attacker-controlled ZIP metadata and
  // decompression work from the Office engines. It never writes to disk.
  const archive = zipSync(input, { level: 0 });
  return archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer;
}

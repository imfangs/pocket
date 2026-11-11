import { OFFICE_PREVIEW_LIMITS as limits, type OfficeImage } from "./officePreviewTypes";

type ImageInfo = { mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; width: number; height: number };
const ascii = (bytes: Uint8Array, offset: number, size: number) => String.fromCharCode(...bytes.subarray(offset, offset + size));
const fits = (width: number, height: number) => width > 0 && height > 0 && width <= limits.imageEdge && height <= limits.imageEdge && width * height <= limits.imagePixels;
export function officeImageInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 10 || bytes.length > limits.imageBytes) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let mime: ImageInfo["mime"], width = 0, height = 0;
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(bytes, 1, 7) === "PNG\r\n\x1a\n" && view.getUint32(8) === 13 && ascii(bytes, 12, 4) === "IHDR") {
    mime = "image/png"; width = view.getUint32(16); height = view.getUint32(20);
    // Animation may decode far more pixels than the header dimensions imply.
    let headers = 0;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset);
      if (offset + size + 12 > bytes.length) return null;
      if (ascii(bytes, offset + 4, 4) === "acTL") return null;
      if (ascii(bytes, offset + 4, 4) === "IHDR" && ++headers > 1) return null;
      offset += size + 12;
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mime = "image/jpeg";
    for (let offset = 2; offset + 4 < Math.min(bytes.length, 65536);) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) { height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break; }
      offset += size;
    }
  } else if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") {
    mime = "image/gif"; width = view.getUint16(6, true); height = view.getUint16(8, true);
    if (bytes.length < 14) return null;
    let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0;
    const skipBlocks = () => {
      while (offset < bytes.length) { const size = bytes[offset++]; if (!size) return true; offset += size; }
      return false;
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b) break;
      if (marker === 0x21) { offset++; if (!skipBlocks()) return null; }
      else if (marker === 0x2c) {
        if (offset + 9 >= bytes.length || ++frames > 1) return null;
        const frameWidth = view.getUint16(offset + 4, true), frameHeight = view.getUint16(offset + 6, true);
        if (!fits(frameWidth, frameHeight) || view.getUint16(offset, true) + frameWidth > width || view.getUint16(offset + 2, true) + frameHeight > height) return null;
        const packed = bytes[offset + 8]; offset += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
        offset++; if (!skipBlocks()) return null;
      } else return null;
    }
    if (frames !== 1) return null;
  } else if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    mime = "image/webp";
    if (view.getUint32(4, true) + 8 !== bytes.length) return null;
    const tag = ascii(bytes, 12, 4);
    if (tag === "VP8X") {
      if (bytes[20] & 2) return null;
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    } else if (tag === "VP8 " && ascii(bytes, 23, 3) === "\x9d\x01\x2a") {
      width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
    } else if (tag === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true); width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
    }
    let imageChunks = 0;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const type = ascii(bytes, offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8;
      if (start + size > bytes.length || type === "ANIM" || type === "ANMF") return null;
      let frameWidth = 0, frameHeight = 0;
      if (type === "VP8 ") {
        if (size < 10 || ascii(bytes, start + 3, 3) !== "\x9d\x01\x2a") return null;
        frameWidth = view.getUint16(start + 6, true) & 0x3fff; frameHeight = view.getUint16(start + 8, true) & 0x3fff;
      } else if (type === "VP8L") {
        if (size < 5 || bytes[start] !== 0x2f) return null;
        const bits = view.getUint32(start + 1, true); frameWidth = 1 + (bits & 0x3fff); frameHeight = 1 + ((bits >>> 14) & 0x3fff);
      }
      if (frameWidth && (++imageChunks > 1 || !fits(frameWidth, frameHeight) || frameWidth !== width || frameHeight !== height)) return null;
      offset = start + size + (size & 1);
    }
    if (imageChunks !== 1) return null;
  } else return null;
  return fits(width, height) ? { mime, width, height } : null;
}

export function createOfficeImageCollector() {
  let count = 0, totalBytes = 0, totalPixels = 0, omitted = false;
  const cached = new Map<Uint8Array, OfficeImage>();
  return {
    get omitted() { return omitted; },
    add(bytes: Uint8Array, alt = ""): OfficeImage | null {
      const existing = cached.get(bytes);
      if (existing) return { ...existing, alt: alt.slice(0, 300) };
      const info = officeImageInfo(bytes);
      if (!info || count >= limits.images || totalBytes + bytes.length > limits.totalImageBytes || totalPixels + info.width * info.height > limits.totalImagePixels) { omitted = true; return null; }
      let binary = "";
      for (let position = 0; position < bytes.length; position += 8192) binary += String.fromCharCode(...bytes.subarray(position, position + 8192));
      const image = { ...info, src: `data:${info.mime};base64,${btoa(binary)}`, alt: alt.slice(0, 300) };
      count++; totalBytes += bytes.length; totalPixels += info.width * info.height; cached.set(bytes, image);
      return image;
    },
  };
}

// This check also runs at the React boundary; the main page never trusts an
// Office HTML src or a worker-provided arbitrary URL as an image capability.
export function safeOfficeImage(image: OfficeImage): boolean {
  if (!image || image.src.length > Math.ceil(limits.imageBytes / 3) * 4 + 40) return false;
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(image.src);
  if (!match) return false;
  try {
    const binary = atob(match[2]), bytes = Uint8Array.from(binary, char => char.charCodeAt(0)), info = officeImageInfo(bytes);
    return !!info && info.mime === match[1] && info.width === image.width && info.height === image.height;
  } catch { return false; }
}

import { maxTextFilePreviewBytes } from "./messageFileText.ts";

export const maxHtmlPreviewResponseBytes = 16 * 1024 * 1024;
const maxImageBytes = 2 * 1024 * 1024, maxImagesBytes = 8 * 1024 * 1024;
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const invalid = () => new Error("HTML 预览读取未完成，请重试或下载原文件。");

export type HtmlFileData = { blob: Blob; images: Record<string, string>; omittedImages: number; imagesAvailable: boolean };
function base64Bytes(value: unknown, limit: number): { encoded: string; size: number } {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 || value.length % 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw invalid();
  const size = value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
  if (size > limit || size < 0) throw invalid();
  try { if (value && btoa(atob(value.slice(-4))) !== value.slice(-4)) throw invalid(); }
  catch { throw invalid(); }
  return { encoded: value, size };
}

/** Decode only the bounded, authenticated preview response. No path or URL is read here. */
export function decodeHtmlPreviewPayload(value: unknown, expectedName: string): HtmlFileData {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || data.name !== expectedName || !Number.isSafeInteger(data.omittedImages) ||
      (data.omittedImages as number) < 0 || !data.images || typeof data.images !== "object" || Array.isArray(data.images)) throw invalid();
  const source = base64Bytes(data.sourceBase64, maxTextFilePreviewBytes);
  const entries = Object.entries(data.images);
  if (entries.length > 32) throw invalid();
  const images: Record<string, string> = Object.create(null);
  let total = 0;
  for (const [path, entry] of entries) {
    if (!path || path.length > 4096 || !entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const image = entry as Record<string, unknown>;
    if (typeof image.type !== "string" || !imageTypes.has(image.type)) throw invalid();
    const bytes = base64Bytes(image.base64, maxImageBytes);
    total += bytes.size;
    if (total > maxImagesBytes) throw invalid();
    images[path] = `data:${image.type};base64,${bytes.encoded}`;
  }
  let binary: string;
  try { binary = atob(source.encoded); } catch { throw invalid(); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return { blob: new Blob([bytes], { type: "application/octet-stream" }), images,
    omittedImages: data.omittedImages as number, imagesAvailable: true };
}

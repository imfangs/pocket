import { constants } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { referencedHtmlImages } from '../shared/html-preview.mjs';
import { AppError } from './store.mjs';

export const HTML_PREVIEW_LIMITS = Object.freeze({ source: 1024 * 1024, image: 2 * 1024 * 1024,
  images: 32, imageTotal: 8 * 1024 * 1024, concurrent: 2, timeoutMs: 15000 });
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const inside = (root, path) => root !== sep && path.startsWith(root + sep);
const sameFile = (before, after) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]);
const changed = () => new AppError('文件正在更新，请稍后重试', 409);
const checkAbort = signal => signal?.throwIfAborted();

export function relativePreviewImage(source) {
  if (typeof source !== 'string' || source.length > 4096) return null;
  let path;
  try { path = decodeURIComponent(source.trim()); } catch { return null; }
  // A preview resource is a document-relative file, never another URL or a
  // second capability. Reject encoded traversal before normalizing its path.
  if (!path || /[\\\p{Cc}\p{Cf}?#]/u.test(path) || /%[0-9a-f]{2}/i.test(path) ||
      /^[a-z][a-z0-9+.-]*:/i.test(path) || isAbsolute(path) || path.split('/').includes('..')) return null;
  return imageTypes[extname(path).toLowerCase()] ? path : null;
}

function imageType(bytes) {
  // Public image downloads are sometimes saved with a .jpg filename even
  // when their actual bytes are PNG. Admission still uses raster extensions;
  // representation MIME comes from the bytes, never that filename.
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function decodeHtml(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) throw new Error('binary');
    return text;
  } catch { throw new AppError('此文件暂不支持文本预览，请下载后查看。', 415); }
}

async function openChecked({ sourcePath, rootSource, root, directorySource, directory, maxBytes, openFile, signal, source = false }) {
  checkAbort(signal);
  let file;
  try {
    const path = await realpath(sourcePath); checkAbort(signal);
    if (!inside(root, path) || directory && !inside(directory, path)) throw new AppError('文件不在预览目录内', 403);
    file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); checkAbort(signal);
    const before = await file.stat({ bigint: true }); checkAbort(signal);
    if (!before.isFile()) throw new AppError('此文件暂不支持预览。', 415);
    if (before.size < 0n || before.size > BigInt(maxBytes))
      throw new AppError(source ? '文件较大，请下载后查看。' : '图片超过预览大小限制。', 413);
    const verify = async () => {
      checkAbort(signal);
      try {
        if (!sameFile(before, await file.stat({ bigint: true })) || await realpath(rootSource) !== root ||
            await realpath(sourcePath) !== path || !sameFile(before, await stat(path, { bigint: true })) ||
            directorySource && await realpath(directorySource) !== directory) throw changed();
      } catch (failure) { if (failure?.name === 'AbortError' || failure?.name === 'TimeoutError') throw failure; throw changed(); }
      checkAbort(signal);
    };
    await verify();
    const read = async () => {
      checkAbort(signal);
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        checkAbort(signal);
        const result = await file.read(bytes, offset, bytes.length - offset, offset); checkAbort(signal);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset !== bytes.length) throw changed();
      await verify();
      return bytes;
    };
    return { read, verify, close: () => file.close() };
  } catch (failure) {
    await file?.close().catch(() => {});
    if (failure instanceof AppError || failure?.name === 'AbortError' || failure?.name === 'TimeoutError') throw failure;
    throw new AppError('文件暂时无法读取', 404);
  }
}

// Reading an already-granted HTML file admits only its actual, bounded image
// references beneath its own directory. None of these paths is an API input.
export async function createHtmlPreview({ entry, openFile, signal, validateReference }) {
  checkAbort(signal);
  if (!/\.html?$/i.test(entry.path)) throw new AppError('此文件暂不支持页面预览。', 415);
  let source;
  try {
    const root = await realpath(entry.root); checkAbort(signal);
    source = await openChecked({ sourcePath: entry.path, rootSource: entry.root, root,
      maxBytes: HTML_PREVIEW_LIMITS.source, openFile, signal, source: true });
    const bytes = await source.read(), html = decodeHtml(bytes);
    const directorySource = dirname(entry.path), directory = await realpath(directorySource); checkAbort(signal);
    if (directory !== root && !inside(root, directory)) throw new AppError('文件不在会话目录内', 403);
    let references;
    try { references = referencedHtmlImages(html); }
    catch { throw new AppError('页面内容较复杂，可查看源码。', 415); }
    const images = Object.create(null);
    let imageBytes = 0, omittedImages = Math.max(0, references.length - HTML_PREVIEW_LIMITS.images);
    for (const value of references.slice(0, HTML_PREVIEW_LIMITS.images)) {
      checkAbort(signal);
      const relative = relativePreviewImage(value), path = relative && resolve(directorySource, relative);
      if (!path || !inside(directorySource, path) || !inside(entry.root, path)) { omittedImages++; continue; }
      let image;
      try {
        image = await openChecked({ sourcePath: path, rootSource: entry.root, root, directorySource, directory,
          maxBytes: Math.min(HTML_PREVIEW_LIMITS.image, HTML_PREVIEW_LIMITS.imageTotal - imageBytes), openFile, signal });
        const content = await image.read(), type = imageType(content);
        if (!type) { omittedImages++; continue; }
        images[value] = { type, base64: content.toString('base64') };
        imageBytes += content.length;
      } catch (failure) {
        checkAbort(signal);
        if (failure instanceof AppError) omittedImages++;
        else throw failure;
      } finally { await image?.close().catch(() => {}); }
    }
    // Keep the original FD throughout assembly: a replaced document cannot
    // silently change which resource graph this response represents.
    await source.verify();
    validateReference(); checkAbort(signal);
    return { schemaVersion: 1, name: basename(entry.path), sourceBase64: bytes.toString('base64'), images, omittedImages };
  } catch (failure) {
    if (failure instanceof AppError || failure?.name === 'AbortError' || failure?.name === 'TimeoutError') throw failure;
    throw new AppError('文件暂时无法读取', 404);
  } finally { await source?.close().catch(() => {}); }
}

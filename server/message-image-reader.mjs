import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';
import { messageImageType } from '../shared/message-media.mjs';
import { AppError } from './store.mjs';
import { messageImageReadError } from './message-image-read-error.mjs';

export const MAX_MESSAGE_IMAGE_BYTES = 8 * 1024 * 1024;
const inside = (root, path) => root !== sep && path.startsWith(root + sep);
const sameFile = (before, after) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]);
const changed = () => new AppError('图片正在更新，请稍后重试', 409);

function matchesType(bytes, type) {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  return type === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

// Callers authorize their own existing capability before passing its entry.
// This reader accepts no browser path and never creates a new reference.
export async function readMessageImage(entry, { openFile = open, realpathFile = realpath, statFile = stat } = {}) {
  const type = messageImageType(entry.path);
  if (!type) throw new AppError('图片格式暂不支持', 415);
  let file;
  try {
    const root = await realpathFile(entry.root), path = await realpathFile(entry.path);
    if (!inside(root, path)) throw new AppError('图片不在任务目录内', 403);
    file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_MESSAGE_IMAGE_BYTES) || before.size < 12n)
      throw new AppError('图片格式或大小暂不支持', 415);
    const verifyPath = async snapshot => {
      if (await realpathFile(entry.root) !== root || await realpathFile(entry.path) !== path
          || !sameFile(snapshot, await statFile(path, { bigint: true }))) throw changed();
    };
    await verifyPath(before);
    const header = Buffer.alloc(12);
    let headerRead = 0;
    while (headerRead < header.length) {
      const result = await file.read(header, headerRead, header.length - headerRead, headerRead);
      if (!result.bytesRead) break;
      headerRead += result.bytesRead;
    }
    if (headerRead !== header.length || !matchesType(header, type)) throw new AppError('图片格式暂不支持', 415);
    // Allocate exactly the checked size; growth cannot increase this read.
    const bytes = Buffer.alloc(Number(before.size));
    let read = 0;
    while (read < bytes.length) {
      const result = await file.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (read !== bytes.length || !sameFile(before, after) || !matchesType(bytes, type)) throw changed();
    await verifyPath(after);
    return { bytes, type };
  } catch (error) {
    throw messageImageReadError(error);
  } finally { await file?.close().catch(() => {}); }
}

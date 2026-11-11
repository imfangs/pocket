import { fromMarkdown } from 'mdast-util-from-markdown';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { AppError } from './store.mjs';
import { messageImageReadError } from './message-image-read-error.mjs';

const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 128 * 1024;
const inside = (root, path) => root !== sep && path.startsWith(root + sep);

function localPath(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const path = decodeURIComponent(value);
    return path.startsWith('/') && !path.startsWith('//') && !path.includes('\0') && types[extname(path).toLowerCase()] ? path : null;
  } catch { return null; }
}

export function referencedImages(text) {
  if (!text.includes('![')) return [];
  const tree = fromMarkdown(text), definitions = new Map(), images = [];
  const walk = (node, visit) => { visit(node); for (const child of node.children ?? []) walk(child, visit); };
  walk(tree, node => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  walk(tree, node => {
    const value = node.type === 'image' ? node.url : node.type === 'imageReference' ? definitions.get(node.identifier) : null;
    const path = localPath(value);
    if (path && !images.includes(path)) images.push(path);
  });
  return images;
}

function matchesType(bytes, type) {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

// References are minted only from the visible history returned by the server.
// The browser receives no endpoint that accepts an arbitrary filesystem path.
export class MessageImages {
  constructor({ openFile = open, realpathFile = realpath } = {}) {
    this.openFile = openFile;
    this.realpathFile = realpathFile;
    this.secret = randomBytes(32);
    this.entries = new Map();
    this.parsed = new Map();
  }
  attach(thread, history) {
    const root = isAbsolute(thread.cwd || '') ? resolve(thread.cwd) : null;
    let count = 0;
    return { ...history, messages: (history.messages || []).map(message => {
      const images = {};
      if (root && root !== sep && count < 32 && !message.truncated
          && typeof message.text === 'string' && message.text.length <= MAX_TEXT_CHARS) {
        // Cutting Markdown can remove a closing code delimiter and turn an
        // example into a file capability. Parse complete bounded messages only.
        const text = message.text, hash = createHash('sha256').update(text).digest('hex');
        let paths = this.parsed.get(hash);
        if (!paths) {
          paths = referencedImages(text);this.parsed.set(hash, paths);
          if (this.parsed.size > 128) this.parsed.delete(this.parsed.keys().next().value);
        }
        for (const source of paths) {
          const path = resolve(source);
          if (!inside(root, path) || count >= 32) continue;
          const key = createHmac('sha256', this.secret).update(JSON.stringify([thread.id, root, path])).digest('hex');
          this.entries.delete(key);
          this.entries.set(key, { threadId: thread.id, root, path, at: Date.now() });
          if (this.entries.size > 256) this.entries.delete(this.entries.keys().next().value);
          images[source] = `/api/tasks/${thread.id}/images/${key}`;
          count++;
        }
      }
      return { ...message, images };
    }) };
  }
  async read(thread, key) {
    const entry = this.entries.get(key);
    if (!entry || entry.threadId !== thread.id || resolve(thread.cwd || '') !== entry.root || Date.now() - entry.at > 3600000)
      throw new AppError('图片引用已过期，请刷新会话', 404);
    let file;
    try {
      const root = await this.realpathFile(entry.root), path = await this.realpathFile(entry.path);
      if (!inside(root, path)) throw new AppError('图片不在任务目录内', 403);
      file = await this.openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES || stat.size < 12)
        throw new AppError('图片格式或大小暂不支持', 415);
      if (await this.realpathFile(entry.path) !== path) throw new AppError('图片位置已变化，请刷新会话', 409);
      const type = types[extname(entry.path).toLowerCase()];
      const header = Buffer.alloc(12);
      await file.read(header, 0, header.length, 0);
      if (!matchesType(header, type)) throw new AppError('图片格式暂不支持', 415);
      // Bound the read even if the file grows after stat().
      const bytes = Buffer.alloc(stat.size);
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      const after = await file.stat();
      if (read !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || !matchesType(bytes, type))
        throw new AppError('图片正在更新，请稍后重试', 409);
      return { bytes, type };
    } catch (error) {
      throw messageImageReadError(error);
    } finally { await file?.close(); }
  }
}

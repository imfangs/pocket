import { fromMarkdown } from 'mdast-util-from-markdown';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { AppError } from './store.mjs';
import { messageImageType } from '../shared/message-media.mjs';
import { readMessageImage } from './message-image-reader.mjs';

const MAX_TEXT_CHARS = 128 * 1024;
const inside = (root, path) => root !== sep && path.startsWith(root + sep);

function localPath(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const path = decodeURIComponent(value);
    return path.startsWith('/') && !path.startsWith('//') && !path.includes('\0') && messageImageType(path) ? path : null;
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
    return readMessageImage(entry, { openFile: this.openFile, realpathFile: this.realpathFile });
  }
}

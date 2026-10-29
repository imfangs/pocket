import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import { referencedMessageFiles } from '../shared/codex-directives.mjs';
import { AppError } from './store.mjs';
import { MAX_MESSAGE_VIDEO_BYTES, openMessageVideoStream } from './message-video-stream.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 128 * 1024;
const REFERENCE_LIFETIME_MS = 60 * 60 * 1000;
const inside = (root, path) => root !== sep && path.startsWith(root + sep);
const sameFile = (before, after) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key]);
const changed = () => new AppError('文件正在更新，请稍后重试', 409);
const threadIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Only assistant references in complete, visible server history can mint a
// capability. Browser requests never supply a filesystem path to this reader.
export class MessageFiles {
  constructor({ now = Date.now, openFile = open } = {}) {
    this.now = now;
    this.openFile = openFile;
    this.secret = randomBytes(32);
    this.entries = new Map();
    this.parsed = new Map();
    this.activeVideoStreams = 0;
  }
  attach(thread, history) {
    const root = typeof thread?.cwd === 'string' && isAbsolute(thread.cwd) ? resolve(thread.cwd) : null;
    const at = this.now();
    for (const [key, entry] of this.entries) {
      if (at - entry.at >= REFERENCE_LIFETIME_MS || at < entry.at) this.entries.delete(key);
    }
    let count = 0;
    return { ...history, messages: (Array.isArray(history.messages) ? history.messages : []).map(message => {
      const files = {};
      if (root && root !== sep && threadIdPattern.test(thread.id) && count < 32 && message?.role === 'assistant'
          && message.phase !== 'analysis' && !message.truncated && typeof message.text === 'string' && message.text.length <= MAX_TEXT_CHARS) {
        // Never cut Markdown before parsing: truncation can turn a code example
        // with a missing closing delimiter into an apparent file reference.
        const hash = createHash('sha256').update(message.text).digest('hex');
        let paths = this.parsed.get(hash);
        if (!paths) {
          paths = referencedMessageFiles(message.text);
          this.parsed.set(hash, paths);
          if (this.parsed.size > 128) this.parsed.delete(this.parsed.keys().next().value);
        }
        for (const source of paths) {
          const path = resolve(source);
          if (!isAbsolute(source) || !inside(root, path) || count >= 32) continue;
          const key = createHmac('sha256', this.secret).update(JSON.stringify([thread.id, root, path])).digest('hex');
          this.entries.delete(key);
          this.entries.set(key, { threadId: thread.id, root, path, at });
          if (this.entries.size > 256) this.entries.delete(this.entries.keys().next().value);
          files[source] = { url: `/api/tasks/${thread.id}/files/${key}`, name: basename(path) };
          count++;
        }
      }
      return { ...message, files };
    }) };
  }
  reference(thread, key) {
    const entry = this.entries.get(key), at = this.now();
    if (!entry || entry.threadId !== thread?.id || typeof thread?.cwd !== 'string' || !isAbsolute(thread.cwd) || resolve(thread.cwd) !== entry.root
        || at - entry.at >= REFERENCE_LIFETIME_MS || at < entry.at)
      throw new AppError('文件引用已过期，请刷新会话', 404);
    return entry;
  }
  async openVideo(thread, key, options = {}) {
    const entry = this.reference(thread, key);
    let file, transferred = false;
    try {
      const root = await realpath(entry.root), path = await realpath(entry.path);
      if (!inside(root, path)) throw new AppError('文件不在会话目录内', 403);
      file = await this.openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw new AppError('暂不支持播放此文件', 415);
      if (before.size > BigInt(MAX_MESSAGE_VIDEO_BYTES) || before.size < 0n)
        throw new AppError('视频超过 512 MiB，暂不支持播放', 413);
      const verify = async () => {
        try {
          if (!sameFile(before, await file.stat({ bigint: true })) || await realpath(entry.root) !== root ||
              await realpath(entry.path) !== path || !sameFile(before, await stat(path, { bigint: true }))) throw changed();
        } catch { throw changed(); }
      };
      await verify();
      // The stream owns the FD even when its construction or sniffing fails.
      transferred = true;
      return await openMessageVideoStream({ ...options, file, before, name: basename(entry.path), verify, reserve: () => {
        if (this.activeVideoStreams >= 16) throw new AppError('同时播放的视频过多，请稍后重试', 503);
        this.activeVideoStreams++;
        return () => { this.activeVideoStreams--; };
      } });
    } catch (error) {
      if (error instanceof AppError || error?.name === 'AbortError') throw error;
      throw new AppError('视频暂时无法读取', 404);
    } finally { if (!transferred) await file?.close().catch(() => {}); }
  }
  async read(thread, key) {
    const entry = this.reference(thread, key);
    let file;
    try {
      const root = await realpath(entry.root), path = await realpath(entry.path);
      if (!inside(root, path)) throw new AppError('文件不在会话目录内', 403);
      file = await this.openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw new AppError('暂不支持下载此文件', 415);
      if (before.size > BigInt(MAX_BYTES) || before.size < 0n) throw new AppError('文件超过 20 MiB，暂不支持下载', 413);
      if (await realpath(entry.root) !== root || await realpath(entry.path) !== path
          || !sameFile(before, await stat(path, { bigint: true }))) throw changed();
      // Allocate only the checked size, even if another process grows the file.
      const bytes = Buffer.alloc(Number(before.size));
      let read = 0;
      while (read < bytes.length) {
        const result = await file.read(bytes, read, bytes.length - read, read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (read !== bytes.length || !sameFile(before, after) || await realpath(entry.root) !== root
          || await realpath(entry.path) !== path || !sameFile(after, await stat(path, { bigint: true }))) throw changed();
      const name = basename(entry.path);
      const encodedName = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
      return { bytes, name, type: 'application/octet-stream', disposition: `attachment; filename*=UTF-8''${encodedName}` };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('文件暂时无法读取', 404);
    } finally { await file?.close().catch(() => {}); }
  }
}

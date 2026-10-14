import fs from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { parseHistory } from './history.mjs';

// A catalog scan visits every thread, so a small LRU would evict all entries
// before the next scan. Only file identity/version and a timestamp are retained.
const cache = new Map();
const cacheLimit = 4096;
const tailSizes = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

export function readLastMessageAt(codexHome, threadId, rolloutPath) {
  if (typeof threadId !== 'string' || !threadId || typeof rolloutPath !== 'string' || !rolloutPath) return null;
  let fd;
  try {
    const home = fs.realpathSync(codexHome);
    const file = fs.realpathSync(isAbsolute(rolloutPath) ? rolloutPath : join(home, rolloutPath));
    if (!['sessions', 'archived_sessions'].some(dir => file.startsWith(join(home, dir) + sep))) return null;
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return null;
    const key = `${file}\0${threadId}`;
    const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String).join(':');
    const prior = cache.get(key);
    if (prior?.version === version) {
      cache.delete(key);
      cache.set(key, prior);
      return prior.lastMessageAt;
    }
    const size = Number(stat.size);
    const header = Buffer.alloc(Math.min(size, 65536));
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return null;
    const meta = JSON.parse(header.toString('utf8').split('\n')[0]);
    if (meta.type !== 'session_meta' || meta.payload?.id !== threadId) return null;
    let lastMessageAt = null;
    for (const limit of tailSizes) {
      const start = Math.max(0, size - limit);
      const readStart = Math.max(0, start - 1);
      const buffer = Buffer.alloc(size - readStart);
      if (fs.readSync(fd, buffer, 0, buffer.length, readStart) !== buffer.length) return null;
      // Skip clipped records before decoding, including a split UTF-8 codepoint.
      // The preceding byte preserves a complete record exactly on the boundary.
      // A very large final record may consume the whole window; expand rather
      // than assigning a timestamp from an internal event or file metadata.
      const firstLineEnd = start ? buffer.indexOf(10) : -1;
      const skip = start ? (firstLineEnd < 0 ? buffer.length : firstLineEnd + 1) : 0;
      lastMessageAt = parseHistory(buffer.subarray(skip).toString('utf8'), readStart + skip).lastMessageAt;
      if (lastMessageAt !== null || start === 0) break;
    }
    cache.delete(key);
    cache.set(key, { version, lastMessageAt });
    if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    return lastMessageAt;
  } catch {
    // Unknown is preferable to making settings changes look like new messages.
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

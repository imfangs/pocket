import fs from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { parseHistory } from './history.mjs';
import { POCKET_CONTENT, contentFileVersion, contentEvidence } from './pocket-content.mjs';
import { parseRecordedTurnState } from './unread.mjs';

// A catalog scan visits every thread, so a small LRU would evict all entries
// before the next scan. Only file identity/version, timestamp and content
// digests are retained; never cache transcript text for the catalog.
const cache = new Map();
const cacheLimit = 4096;
const tailSizes = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];

const unknown = () => ({ lastMessageAt: null, [POCKET_CONTENT]: contentEvidence({ known: false }, null, null) });
export function readLastMessageAt(codexHome, threadId, rolloutPath) {
  return readMessageActivity(codexHome, threadId, rolloutPath).lastMessageAt;
}
export function readMessageActivity(codexHome, threadId, rolloutPath) {
  if (typeof threadId !== 'string' || !threadId || typeof rolloutPath !== 'string' || !rolloutPath) return unknown();
  let fd;
  try {
    const home = fs.realpathSync(codexHome);
    const file = fs.realpathSync(isAbsolute(rolloutPath) ? rolloutPath : join(home, rolloutPath));
    if (!['sessions', 'archived_sessions'].some(dir => file.startsWith(join(home, dir) + sep))) return unknown();
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return unknown();
    const key = `${file}\0${threadId}`;
    const version = contentFileVersion(stat);
    const prior = cache.get(key);
    if (prior?.version === version) {
      if (contentFileVersion(fs.fstatSync(fd, { bigint: true })) !== version) return unknown();
      cache.delete(key);
      cache.set(key, prior);
      return { ...prior.activity, [POCKET_CONTENT]: contentEvidence(prior.activity[POCKET_CONTENT], file, version) };
    }
    const size = Number(stat.size);
    const header = Buffer.alloc(Math.min(size, 65536));
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return unknown();
    const meta = JSON.parse(header.toString('utf8').split('\n')[0]);
    if (meta.type !== 'session_meta' || meta.payload?.id !== threadId) return unknown();
    let lastMessageAt = null, content = { known: false };
    for (const limit of tailSizes) {
      const start = Math.max(0, size - limit);
      const readStart = Math.max(0, start - 1);
      const buffer = Buffer.alloc(size - readStart);
      if (fs.readSync(fd, buffer, 0, buffer.length, readStart) !== buffer.length) return unknown();
      // Skip clipped records before decoding, including a split UTF-8 codepoint.
      // The preceding byte preserves a complete record exactly on the boundary.
      // A very large final record may consume the whole window; expand rather
      // than assigning a timestamp from an internal event or file metadata.
      const firstLineEnd = start ? buffer.indexOf(10) : -1;
      const skip = start ? (firstLineEnd < 0 ? buffer.length : firstLineEnd + 1) : 0;
      const text = buffer.subarray(skip).toString('utf8');
      const parsed = parseHistory(text, readStart + skip);
      lastMessageAt = parsed.lastMessageAt;
      content = { ...parsed[POCKET_CONTENT], turnState: parseRecordedTurnState(text) };
      // A recent user query provides message activity, but cannot prove that
      // no earlier assistant exists. Keep expanding until an answer or head.
      if ((lastMessageAt !== null && content.known) || start === 0) break;
    }
    if (contentFileVersion(fs.fstatSync(fd, { bigint: true })) !== version) return unknown();
    const activity = { lastMessageAt, [POCKET_CONTENT]: contentEvidence(content, file, version) };
    cache.delete(key);
    cache.set(key, { version, activity });
    if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    return activity;
  } catch {
    // Unknown is preferable to making settings changes look like new messages.
    return unknown();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

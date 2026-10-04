import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { join, isAbsolute, sep } from 'node:path';

const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ids = value => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0);
const unknown = () => ({ available: false, source: 'unknown', ids: new Set() });
const cache = new Map();

// This adapter is for the currently verified local stdio/API-key desktop deployment.
export function readUnreadState(global, authMode) {
  if (authMode !== 'apikey') return unknown();
  if (Object.hasOwn(global, 'electron-thread-read-state-v1')) {
    const state = global['electron-thread-read-state-v1'];
    if (!record(state) || state.version !== 1 || !record(state.unreadByIdentity)) return unknown();
    const identity = state.unreadByIdentity[hash(['execution-storage', authMode])];
    if (identity !== undefined && !record(identity)) return unknown();
    const current = identity?.['local:' + hash(['local', 'local', null])];
    const value = current === undefined ? [] : current;
    if (!ids(value)) return unknown();
    return { available: true, source: 'desktop-v1', ids: new Set(value) };
  }
  const value = global['electron-persisted-atom-state']?.['unread-thread-ids-by-host-v1']?.local;
  return ids(value) ? { available: true, source: 'legacy', ids: new Set(value) } : unknown();
}
export function readLocalUnreadState(global, codexHome) {
  try { return readUnreadState(global, JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8')).auth_mode); }
  catch { return unknown(); }
}
export function readLocalReadStateSnapshot(codexHome, threadId) {
  const authMode = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8')).auth_mode;
  const global = JSON.parse(readFileSync(join(codexHome, '.codex-global-state.json'), 'utf8'));
  const state = readUnreadState(global, authMode);
  if (!state.available || state.source !== 'desktop-v1') throw new Error('read_state_unavailable');
  return { identityKey: hash(['execution-storage', authMode]),
    executionHostKey: 'local:' + hash(['local', 'local', null]), unread: state.ids.has(threadId) };
}
export function parseRecordedTurnState(text) {
  const lines = text.split('\n').filter(line => line.trim());
  let state = 'unknown', latestTurn = null, contextTurn = null;
  for (let index = 0; index < lines.length; index++) {
    let row;
    try { row = JSON.parse(lines[index]); }
    catch { if (index === lines.length - 1) return 'unknown'; else continue; }
    if (row.type === 'turn_context' && row.payload?.turn_id) contextTurn = row.payload.turn_id;
    if (row.type !== 'event_msg') continue;
    const event = row.payload;
    if (['task_started', 'turn_started'].includes(event?.type)) {
      latestTurn = event.turn_id ?? null;
      state = 'unconfirmed';
    } else if (['task_complete', 'turn_complete', 'turn_aborted'].includes(event?.type)) {
      const turn = event.turn_id || contextTurn;
      if (latestTurn && turn && turn !== latestTurn) continue;
      latestTurn = turn || latestTurn;
      state = 'ended';
    }
  }
  return state;
}
export function readRecordedTurnState(codexHome, threadId, rolloutPath) {
  if (typeof rolloutPath !== 'string' || !rolloutPath) return 'unknown';
  let fd;
  try {
    const home = realpathSync(codexHome);
    const file = realpathSync(isAbsolute(rolloutPath) ? rolloutPath : join(home, rolloutPath));
    if (!['sessions', 'archived_sessions'].some(dir => file.startsWith(join(home, dir) + sep))) return 'unknown';
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return 'unknown';
    const key = `${file}:${threadId}`, version = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (cache.get(key)?.version === version) return cache.get(key).state;
    const header = Buffer.alloc(Math.min(stat.size, 65536));
    readSync(fd, header, 0, header.length, 0);
    const meta = JSON.parse(header.toString('utf8').split('\n')[0]);
    if (meta.type !== 'session_meta' || meta.payload?.id !== threadId) return 'unknown';
    const start = Math.max(0, stat.size - 256 * 1024), buffer = Buffer.alloc(stat.size - start);
    if (readSync(fd, buffer, 0, buffer.length, start) !== buffer.length) return 'unknown';
    let text = buffer.toString('utf8');
    if (start) { const line = text.indexOf('\n'); text = line < 0 ? '' : text.slice(line + 1); }
    const state = parseRecordedTurnState(text);
    cache.delete(key); cache.set(key, { version, state });
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    return state;
  } catch { return 'unknown'; }
  finally { if (fd !== undefined) closeSync(fd); }
}

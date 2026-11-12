import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { makeApp } from '../server/index.mjs';
import { HistoryPageReader, readHistorySourceVersion } from '../server/history.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const row = (type, payload) => JSON.stringify({ timestamp: '2026-10-28T00:00:00Z', type, payload }) + '\n';
async function fixture(t, { compressed = false, historyPages, readState } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pocket-page-http-')), home = join(root, 'codex'), cwd = join(root, 'work');
  mkdirSync(join(home, 'sessions'), { recursive: true }); mkdirSync(cwd);
  const source = join(home, 'sessions', 'history.jsonl');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?)').run(id, source);
  db.prepare('INSERT INTO threads VALUES(?,?)').run(otherId, source);
  db.close();
  const text = row('session_meta', { id }) + row('event_msg', { type: 'task_started', turn_id: 'one' }) +
    Array.from({ length: 205 }, (_, index) => row('response_item', { id: `message-${index}`, type: 'message', role: index % 2 ? 'assistant' : 'user',
      phase: index % 2 ? 'final' : undefined, content: [{ type: 'output_text', text: `内容-${index}` }] })).join('') +
    row('event_msg', { type: 'task_complete', turn_id: 'one' });
  writeFileSync(compressed ? `${source}.zst` : source, compressed ? zstdCompressSync(text) : text);
  let nativeCalls = 0;
  const app = makeApp({ dataDir: join(root, 'data'), codexHome: home,
    historyPages, readState,
    openThread: () => { nativeCalls++; assert.fail('reading must not open the task'); },
    desktopRequest: () => { nativeCalls++; assert.fail('paging must not use a native executor'); },
    readSource: () => ({ threads: [id, otherId].map(value => ({ id: value, title: 'Synthetic', cwd, updatedAt: 1 })), projects: [], sourceInfo: { syncedAt: Date.now() } }),
    automations: { read: () => ({ ok: true, automations: [] }) },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (path, headers = {}, options = {}) => fetch(base + path, { ...options, headers: { Authorization: `Bearer ${app.auth.localToken}`, ...headers } });
  return { root, app, get, nativeCalls: () => nativeCalls };
}

for (const compressed of [false, true]) test(`HTTP disconnect cancels only its asynchronous ${compressed ? 'compressed recent' : 'page'} read without native control`, async t => {
  let started, aborted, release;
  const ready = new Promise(done => { started = done; });
  const cancelled = new Promise(done => { aborted = done; });
  const read = (_home, _id, options) => new Promise((resolve, reject) => {
    release = resolve; started(options.signal);
    options.signal.addEventListener('abort', () => { aborted(); reject(Object.assign(new Error('cancelled'), { status: 499 })); }, { once: true });
  });
  const f = await fixture(t, { compressed, historyPages: { read, recent: read, close() { release?.({ messages: [] }); } } });
  const controller = new AbortController();
  const request = f.get(`/api/tasks/${id}/${compressed ? 'transcript' : 'transcript-page'}`, {}, { signal: controller.signal });
  const failed = assert.rejects(request, error => error.name === 'AbortError');
  const signal = await ready;
  assert.equal(signal.aborted, false); controller.abort(); await failed; await cancelled;
  assert.equal(signal.aborted, true); assert.equal(f.nativeCalls(), 0);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM read_state_receipts').get().n, 0);
});

test('authenticated HTTP pagination traverses past 80 messages without granting control or read observations', async t => {
  const f = await fixture(t), path = `/api/tasks/${id}/transcript-page`;
  const baseline = f.app.store.db.prepare('SELECT count(*) AS n FROM read_state_receipts').get().n;
  const recent = await f.get(`/api/tasks/${id}/transcript`).then(r => r.json());
  assert.equal(recent.hasMore, true);
  const all = []; let before;
  do {
    const response = await f.get(path + (before ? `?before=${encodeURIComponent(before)}` : ''));
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Pocket-Machine'), 'ged'); assert.equal(response.headers.get('ETag'), null);
    const page = await response.json(); all.unshift(...page.messages); before = page.nextCursor;
    for (const key of ['runtime', 'canSend', 'pendingRequests', 'outbox', 'pocketContent', 'readObservation']) assert.equal(page[key], undefined, key);
    assert.equal(JSON.stringify(page).includes(f.root), false);
  } while (before);
  assert.deepEqual(all.map(m => m.id), Array.from({ length: 205 }, (_, i) => `message-${i}`));
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM read_state_receipts').get().n, baseline);
  assert.equal(f.nativeCalls(), 0);
});

test('page authentication, source identity and query validation remain mandatory', async t => {
  const f = await fixture(t), path = `/api/tasks/${id}/transcript-page`;
  assert.equal((await f.get(path, { Authorization: '' })).status, 401);
  assert.equal((await f.get(path, { Origin: 'https://other.example' })).status, 403);
  for (const suffix of ['?limit=0', '?limit=81', '?limit=02', '?limit=2&limit=3', '?before=x&before=y', '?path=/tmp/private'])
    assert.equal((await f.get(path + suffix)).status, 400, suffix);
  const first = await f.get(path).then(r => r.json());
  const wrongThread = await f.get(`/api/tasks/${otherId}/transcript-page?before=${encodeURIComponent(first.nextCursor)}`);
  assert.ok([400, 409].includes(wrongThread.status));
  assert.equal((await f.get(path + '?before=not-a-valid-cursor')).status, 400);
  assert.equal(f.nativeCalls(), 0);
});

test('the normal transcript route falls back to compressed history with current private content evidence', async t => {
  const f = await fixture(t, { compressed: true });
  const response = await f.get(`/api/tasks/${id}/transcript`); assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.messages.length, 80); assert.equal(data.messages.at(-1).id, 'message-204');
  assert.equal(data.hasMore, true); assert.equal(data.pocketContent.known, true);
  assert.equal(data.readObservation, null); assert.equal(data.canSend, undefined);
  assert.equal(JSON.stringify(data).includes(f.root), false); assert.equal(f.nativeCalls(), 0);
  const page = await f.get(`/api/tasks/${id}/transcript-page`).then(r => r.json());
  assert.equal(page.messages.at(-1).id, data.messages.at(-1).id); assert.ok(page.nextCursor);
});

test('a new plain snapshot during compressed fallback cannot grant a native read token to the older body', async t => {
  const reader = new HistoryPageReader();
  let snapshotHome, nativeWrites = 0, restoredVersion;
  const historyPages = {
    read: (...args) => reader.read(...args),
    async recent(home, threadId) {
      snapshotHome = home;
      const older = await reader.recent(home, threadId);
      // The worker read was valid, but the source changes before HTTP resumes.
      // A newly available native snapshot must not certify the older body.
      writeFileSync(join(home, 'sessions', 'history.jsonl'), row('session_meta', { id }) +
        row('event_msg', { type: 'task_started', turn_id: 'new-turn' }) +
        row('response_item', { id: 'new-unseen-message', type: 'message', role: 'assistant', phase: 'final',
          content: [{ type: 'output_text', text: 'New synthetic answer not present in the returned body' }] }) +
        row('event_msg', { type: 'task_complete', turn_id: 'new-turn' }));
      restoredVersion = readHistorySourceVersion(home, threadId);
      return older;
    },
    close: () => reader.close(),
  };
  const f = await fixture(t, { compressed: true, historyPages, readState: {
    readSnapshot(threadId) {
      if (!snapshotHome) throw Object.assign(new Error('plain source absent'), { code: 'ENOENT' });
      return { sourceVersion: readHistorySourceVersion(snapshotHome, threadId),
        identityKey: 'synthetic-identity', executionHostKey: 'synthetic-local-host', unread: true };
    },
    write() { nativeWrites++; assert.fail('fallback reading must not write native read state'); },
  } });
  const response = await f.get(`/api/tasks/${id}/transcript`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(restoredVersion, 'the new plain snapshot was available before the response was built');
  assert.equal(data.messages.at(-1).id, 'message-204');
  assert.equal(data.messages.some(message => message.id === 'new-unseen-message'), false);
  assert.equal(data.hasMore, true);
  assert.equal(data.readObservation, null, 'old async content cannot obtain a token for the new native snapshot');
  assert.equal(data.canSend, undefined);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM read_state_receipts').get().n, 0);
  assert.equal(nativeWrites, 0); assert.equal(f.nativeCalls(), 0);
  assert.equal(JSON.stringify(data).includes(f.root), false);
});

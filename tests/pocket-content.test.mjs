import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NavigatorStore } from '../server/store.mjs';
import { parseHistory, readPersistedHistory } from '../server/history.mjs';
import { readMessageActivity } from '../server/message-time.mjs';
import { makeApp } from '../server/index.mjs';
import { PocketContentService, POCKET_CONTENT, EMPTY_CONTENT_VERSION,
  assistantContentVersion, contentSourceIsCurrent } from '../server/pocket-content.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const row = (type, payload, timestamp = '2026-10-22T00:00:00Z') => JSON.stringify({ type, payload, timestamp });
const message = (text, extra = {}) => row('response_item', { type: 'message', id: 'reply', role: 'assistant',
  phase: 'final', content: [{ type: 'output_text', text }], ...extra });
const lines = (...entries) => entries.join('\n') + '\n';
function directory(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'pocket-content-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function source(t, entries = []) {
  const dir = directory(t), home = join(dir, 'codex');
  fs.mkdirSync(join(home, 'sessions'), { recursive: true });
  const file = join(home, 'sessions', 'fixture.jsonl');
  fs.writeFileSync(file, lines(row('session_meta', { id }), ...entries));
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?)').run(id, file);
  db.close();
  return { dir, home, file, activity: () => readMessageActivity(home, id, file),
    transcript: () => readPersistedHistory(home, id), append: (...entries) => fs.appendFileSync(file, lines(...entries)) };
}
function service(t, home) {
  const store = new NavigatorStore(directory(t));
  t.after(() => store.close());
  return { store, ledger: new PocketContentService(store, home) };
}

test('content digest follows complete visible assistant text, stable IDs and raw phase only', () => {
  const original = parseHistory(message('First part'))[POCKET_CONTENT];
  const appended = parseHistory(message('First part, now finished'))[POCKET_CONTENT];
  assert.notEqual(appended.version, original.version, 'same ID and timestamp do not hide streaming growth');
  assert.notEqual(parseHistory(message('First part', { id: 'another-reply' }))[POCKET_CONTENT].version, original.version);
  assert.notEqual(parseHistory(message('First part', { phase: 'commentary' }))[POCKET_CONTENT].version, original.version);
  const context = row('turn_context', { turn_id: 'only-in-the-large-tail' }) + '\n';
  const full = parseHistory(context + message('First part'));
  const short = parseHistory(message('First part'), Buffer.byteLength(context));
  assert.notEqual(full.messages[0].turnId, short.messages[0].turnId);
  assert.equal(full[POCKET_CONTENT].version, short[POCKET_CONTENT].version);
  const fallback = message('Same bytes', { id: undefined });
  assert.equal(parseHistory(context + fallback)[POCKET_CONTENT].version,
    parseHistory(fallback, Buffer.byteLength(context))[POCKET_CONTENT].version);
});

test('queries, metadata, reasoning, injection and internal compaction do not create incoming content', () => {
  const baseline = message('Actual answer');
  const expected = parseHistory(baseline)[POCKET_CONTENT].version;
  const data = parseHistory(lines(baseline,
    message('Own next query', { role: 'user', id: 'query' }),
    row('event_msg', { type: 'thread_settings_applied' }),
    row('event_msg', { type: 'thread_read' }),
    row('event_msg', { type: 'token_count' }),
    message('Hidden reasoning', { id: 'analysis', phase: 'analysis' }),
    message('Injected rules', { id: 'injected', internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['generic.developer_instructions'] } }),
    message('Internal summary', { id: 'summary' }),
    row('token_usage_record', { response_id: 'summary-response' }),
    row('compacted', { compaction_response_id: 'summary-response' })));
  assert.equal(data[POCKET_CONTENT].version, expected);
  assert.equal(data[POCKET_CONTENT].messageId, 'reply');
  assert.equal(data[POCKET_CONTENT].readable, true);
});

test('content beyond a rendered truncation still changes the digest but cannot grant a read proof', t => {
  const fixture = source(t, [message('x'.repeat(24000) + 'A')]);
  const { ledger } = service(t, fixture.home);
  const first = ledger.observe(id, fixture.activity()[POCKET_CONTENT]);
  const data = ledger.transcript(id, fixture.transcript());
  assert.equal(data.messages.at(-1).truncated, true);
  assert.equal(data.pocketContent.known, false);
  fixture.append(message('x'.repeat(24000) + 'B'));
  const second = ledger.observe(id, fixture.activity()[POCKET_CONTENT]);
  assert.equal(second.revision, first.revision + 1);
  assert.notEqual(second.version, first.version);
  assert.equal(ledger.transcript(id, fixture.transcript()).pocketContent.known, false);
});

test('an assistant omitted by the message/count budget cannot be confirmed by a later query footer', t => {
  const fixture = source(t, [message('Old answer'), ...Array.from({ length: 81 }, (_, n) =>
    message(`Query ${n}`, { role: 'user', id: `query-${n}` }))]);
  const { ledger } = service(t, fixture.home);
  const candidate = fixture.transcript();
  assert.equal(candidate.messages.some(item => item.role === 'assistant'), false);
  assert.equal(candidate[POCKET_CONTENT].known, true);
  assert.equal(ledger.transcript(id, candidate).pocketContent.known, false);
});

test('tail expansion finds an earlier assistant even when the small tail has a recent user query', t => {
  const fixture = source(t, [message('Earlier readable answer'),
    row('event_msg', { type: 'internal', value: 'x'.repeat(100000) }),
    message('Recent query', { role: 'user', id: 'query' })]);
  const activity = fixture.activity();
  assert.equal(activity[POCKET_CONTENT].messageId, 'reply');
  assert.equal(activity[POCKET_CONTENT].version, fixture.transcript()[POCKET_CONTENT].version);
  assert.ok(activity.lastMessageAt);
});

test('empty content is known only at the file head; absence beyond the read budget stays unknown', t => {
  const fixture = source(t, [message('Just a question', { role: 'user' })]);
  const { ledger } = service(t, fixture.home);
  const empty = ledger.observe(id, fixture.activity()[POCKET_CONTENT]);
  assert.equal(empty.known, true);
  assert.equal(empty.version, EMPTY_CONTENT_VERSION);
  assert.equal(empty.messageId, null);
  assert.equal(empty.revision, 1);
  assert.equal(ledger.transcript(id, fixture.transcript()).pocketContent.known, false);
  fixture.append(row('event_msg', { type: 'internal', value: 'x'.repeat(4 * 1024 * 1024 + 100) }),
    message('Another query', { role: 'user' }));
  assert.equal(fixture.activity()[POCKET_CONTENT].known, false);
  assert.equal(fixture.transcript()[POCKET_CONTENT].known, false);
  assert.equal(ledger.observe(id, fixture.activity()[POCKET_CONTENT]).known, false);
});

test('file append or replacement during a source scan returns unknown and is not cached as fresh', t => {
  const fixture = source(t, [message('Before')]);
  const actualRead = fs.readSync;
  let changed = false;
  const mocked = t.mock.method(fs, 'readSync', (...args) => {
    const result = actualRead(...args);
    if (!changed) { changed = true; fixture.append(message('After')); }
    return result;
  });
  assert.equal(fixture.activity()[POCKET_CONTENT].known, false);
  mocked.mock.restore();
  assert.equal(fixture.activity()[POCKET_CONTENT].version,
    assistantContentVersion('reply', 'After', 'final'));
});

test('catalog and transcript assign the same monotonic revision, including source truncation and metadata-only appends', t => {
  const fixture = source(t, [message('Before')]);
  const { ledger } = service(t, fixture.home);
  const first = ledger.observe(id, fixture.activity()[POCKET_CONTENT]);
  assert.equal(first.revision, 1);
  assert.deepEqual(ledger.transcript(id, fixture.transcript()).pocketContent, first);
  fixture.append(row('event_msg', { type: 'thread_settings_applied' }), message('Own query', { role: 'user' }));
  assert.deepEqual(ledger.observe(id, fixture.activity()[POCKET_CONTENT]), first);
  fixture.append(message('Longer revised answer'));
  const next = ledger.transcript(id, fixture.transcript()).pocketContent;
  assert.equal(next.revision, 2);
  assert.deepEqual(ledger.observe(id, fixture.activity()[POCKET_CONTENT]), next);
  fs.writeFileSync(fixture.file, lines(row('session_meta', { id }), message('Short rewrite')));
  const rewritten = ledger.observe(id, fixture.activity()[POCKET_CONTENT]);
  assert.equal(rewritten.revision, 3, 'same inode shrink is a new observed content version');
  assert.notEqual(rewritten.version, next.version);
});

test('late source and transcript snapshots cannot acquire a newer revision or replace the known ledger content', t => {
  const fixture = source(t, [message('Old')]);
  const { store, ledger } = service(t, fixture.home);
  const oldCatalog = fixture.activity()[POCKET_CONTENT], oldTranscript = fixture.transcript();
  const first = ledger.observe(id, oldCatalog);
  fixture.append(message('New'));
  const current = ledger.transcript(id, fixture.transcript()).pocketContent;
  assert.equal(current.revision, first.revision + 1);
  assert.equal(contentSourceIsCurrent(oldCatalog), false);
  assert.equal(ledger.observe(id, oldCatalog).known, false);
  assert.equal(ledger.transcript(id, oldTranscript).pocketContent.known, false);
  const kept = store.db.prepare('SELECT revision,version FROM pocket_content WHERE thread_id=?').get(id);
  assert.equal(kept.revision, current.revision);
  assert.equal(kept.version, current.version);
  assert.deepEqual(ledger.observe(id, fixture.activity()[POCKET_CONTENT]), current);
});

test('a delayed snapshot from an intact old rollout cannot supersede a newer source-file observation', t => {
  const fixture = source(t, [message('Old file answer')]);
  const { store, ledger } = service(t, fixture.home);
  const delayed = fixture.activity()[POCKET_CONTENT];
  ledger.observe(id, delayed);
  const nextFile = join(fixture.home, 'sessions', 'replacement.jsonl');
  fs.writeFileSync(nextFile, lines(row('session_meta', { id }), message('Replacement answer')));
  const current = ledger.observe(id, readMessageActivity(fixture.home, id, nextFile)[POCKET_CONTENT]);
  assert.equal(contentSourceIsCurrent(delayed), true, 'the old file remains unchanged on disk');
  assert.equal(ledger.observe(id, delayed).known, false);
  const catalog = ledger.catalog({ threads: [{ id }], sourceInfo: {} });
  assert.deepEqual(catalog.threads[0].pocketContent, current);
  assert.equal(store.db.prepare('SELECT revision FROM pocket_content WHERE thread_id=?').get(id).revision, 2);
});

test('scope and content revisions survive restart, while new metadata stores and changed sources are isolated', t => {
  const fixture = source(t, [message('Answer')]);
  const dataDir = directory(t);
  let store = new NavigatorStore(dataDir);
  let ledger = new PocketContentService(store, fixture.home);
  const original = ledger.observe(id, fixture.activity()[POCKET_CONTENT]);
  store.close();
  store = new NavigatorStore(dataDir);
  t.after(() => store.close());
  ledger = new PocketContentService(store, fixture.home);
  assert.deepEqual(ledger.observe(id, fixture.activity()[POCKET_CONTENT]), original);
  const other = source(t, [message('Answer')]);
  const changed = new PocketContentService(store, other.home);
  const switched = changed.observe(id, other.activity()[POCKET_CONTENT]);
  assert.notEqual(switched.scope, original.scope);
  assert.equal(switched.revision, 1);
  const { ledger: separate } = service(t, fixture.home);
  assert.notEqual(separate.scope, original.scope);
});

test('catalog scans retain only version metadata and 1500 warm sessions need no body IO', t => {
  const fixture = source(t);
  const { store, ledger } = service(t, fixture.home);
  const files = Array.from({ length: 1500 }, (_, n) => {
    const threadId = `catalog-${n}`, file = join(fixture.home, 'sessions', `${threadId}.jsonl`);
    fs.writeFileSync(file, lines(row('session_meta', { id: threadId }), message('BODY_NOT_IN_LEDGER')));
    return { id: threadId, file };
  });
  const scan = () => ledger.source({ threads: files.map(entry => ({ id: entry.id,
    ...readMessageActivity(fixture.home, entry.id, entry.file) })), sourceInfo: {}, projects: [] });
  const first = scan();
  const bodyRead = t.mock.method(fs, 'readSync');
  const second = scan();
  assert.equal(bodyRead.mock.callCount(), 0);
  assert.deepEqual(second.threads.map(thread => thread.pocketContent), first.threads.map(thread => thread.pocketContent));
  const rows = store.db.prepare('SELECT * FROM pocket_content').all();
  assert.equal(rows.length, 1500);
  assert.doesNotMatch(JSON.stringify(rows), /BODY_NOT_IN_LEDGER/);
  assert.doesNotMatch(JSON.stringify(second), /fixture\.jsonl|pocket-content-evidence|source\.file/);
});

test('HTTP catalog and transcript expose compatible content proofs without native writes or execution', async t => {
  const fixture = source(t, [message('HTTP answer')]);
  let nativeWrites = 0, desktopCalls = 0;
  const app = makeApp({ dataDir: join(fixture.dir, 'navigator'), codexHome: fixture.home,
    readSource: () => ({ threads: [{ id, title: 'Fixture', cwd: fixture.dir, archived: false, hasUnreadTurn: false,
      ...fixture.activity() }], projects: [], sourceInfo: {} }),
    desktopRequest: async () => { desktopCalls++; return { ok: false, code: 'desktop_unavailable' }; },
    readState: { readSnapshot: () => ({ sourceVersion: 'legacy', unread: false }),
      write: async () => { nativeWrites++; throw new Error('must not write'); } },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${app.auth.localToken}` };
  const get = async path => {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  const catalog = await get('/api/catalog');
  const before = catalog.threads[0].pocketContent;
  assert.equal(catalog.sourceInfo.pocketRead.available, true);
  assert.equal(catalog.sourceInfo.pocketRead.scope, before.scope);
  assert.equal(before.known, true, 'native already-read does not suppress independent content');
  const transcript = await get(`/api/tasks/${id}/transcript`);
  assert.deepEqual(transcript.pocketContent, before);
  assert.equal(transcript.readObservation, null);
  fixture.append(message('HTTP answer with more text'));
  const newer = await get(`/api/tasks/${id}/transcript`);
  assert.equal(newer.pocketContent.revision, before.revision + 1);
  assert.deepEqual((await get('/api/catalog')).threads[0].pocketContent, newer.pocketContent);
  assert.equal(nativeWrites, 0);
  assert.equal(desktopCalls, 0);
  assert.doesNotMatch(JSON.stringify(newer), /fixture\.jsonl|pocket-content-evidence/);
});

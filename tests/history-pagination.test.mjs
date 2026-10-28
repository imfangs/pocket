import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, renameSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { HistoryPageReader, readPersistedHistory } from '../server/history.mjs';
import { POCKET_CONTENT, contentEvidence, contentSourceIsCurrent, PocketContentService } from '../server/pocket-content.mjs';
import { NavigatorStore } from '../server/store.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const record = (type, payload) => JSON.stringify({ timestamp: '2026-10-28T00:00:00Z', type, payload }) + '\n';
const message = (index, extra = {}) => record('response_item', {
  type: 'message', role: index % 2 ? 'assistant' : 'user', phase: index % 2 ? 'final' : undefined,
  content: [{ type: 'output_text', text: `message-${index}` }], ...extra,
});
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t, body, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pocket-history-page-'));
  mkdirSync(join(home, 'sessions'));
  const file = join(home, 'sessions', 'test.jsonl');
  const dbFile = join(home, 'state_5.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE threads(id TEXT, rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES (?, ?)').run(id, file);
  const data = record('session_meta', { id }) + body;
  writeFileSync(options.compressed ? file + '.zst' : file, options.compressed ? zstdCompressSync(data) : data);
  const reader = new HistoryPageReader(options.reader);
  t.after(() => { reader.close(); db.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, file, db, dbFile, reader, read: options => reader.read(home, id, options) };
}
async function allPages(f, limit = 80) {
  const pages = []; let before;
  do {
    const page = await f.read({ before, limit });
    pages.push(page);
    assert.equal(page.hasMore, Boolean(page.nextCursor));
    before = page.nextCursor;
    assert.ok(pages.length < 100, 'cursor advances to the oldest message');
  } while (before);
  return { pages, messages: pages.toReversed().flatMap(page => page.messages) };
}

test('complete message pagination recovers messages cut by 80 rows inside one 4 MiB tail', async t => {
  const f = fixture(t, Array.from({ length: 205 }, (_, i) => message(i, { id: `native-${i}` })).join(''));
  const baseline = { file: hash(f.file), db: hash(f.dbFile) };
  assert.equal(readPersistedHistory(f.home, id).hasMore, true);
  const result = await allPages(f);
  assert.deepEqual(result.pages.map(page => page.messages.length), [80, 80, 45]);
  assert.deepEqual(result.pages.map(page => page.page.kind), ['recent', 'older', 'older']);
  assert.deepEqual(result.messages.map(row => row.id), Array.from({ length: 205 }, (_, i) => `native-${i}`));
  assert.deepEqual({ file: hash(f.file), db: hash(f.dbFile) }, baseline, 'pagination is strictly read-only');
  for (const page of result.pages) {
    assert.deepEqual(Object.keys(page).sort(), ['hasMore', 'messages', 'nextCursor', 'page', 'source']);
    assert.ok(!JSON.stringify(page).includes(f.home), 'cursors and responses do not expose local paths');
  }
});

test('character budget ends a page before a message instead of dropping its clipped remainder', async t => {
  const f = fixture(t, Array.from({ length: 15 }, (_, i) => message(i, { id: `long-${i}`,
    content: [{ type: 'output_text', text: `${i}:` + 'x'.repeat(i === 14 ? 25000 : 23000) }] })).join(''));
  const { messages, pages } = await allPages(f);
  assert.equal(messages.length, 15);
  for (const page of pages) assert.ok(page.messages.reduce((sum, row) => sum + row.text.length, 0) <= 160000);
  assert.equal(messages.at(-1).text.length, 24000);
  assert.equal(messages.at(-1).truncated, true);
  assert.ok(messages.slice(0, -1).every(row => row.text.endsWith('x'.repeat(23000)) && row.truncated === false));
});

test('UTF-8 byte IDs stay stable on both sides of a greater-than-4 MiB tool record', async t => {
  const older = message(0, { content: [{ type: 'input_text', text: '早期中文消息' }] });
  const gap = record('response_item', { type: 'function_call_output', output: '中'.repeat(1500000) });
  const newer = Array.from({ length: 85 }, (_, i) => message(i + 1)).join('');
  const f = fixture(t, older + gap + newer);
  const expected = [];
  let offset = Buffer.byteLength(record('session_meta', { id }));
  for (const line of (older + gap + newer).split('\n').filter(Boolean)) {
    const data = JSON.parse(line);
    if (data.payload.type === 'message') expected.push(`rollout:${offset}`);
    offset += Buffer.byteLength(line) + 1;
  }
  const result = await allPages(f, 40);
  assert.deepEqual(result.messages.map(row => row.id), expected);
  const latest = readPersistedHistory(f.home, id).messages;
  assert.deepEqual(result.messages.slice(-80).map(row => row.id), latest.map(row => row.id));
});

test('visibility and compaction relations are resolved across page boundaries before pagination', async t => {
  const summary = message(1, { id: 'internal-summary', content: [{ type: 'output_text', text: 'SECRET_SUMMARY' }] });
  const data = [
    message(0, { id: 'question' }), summary,
    record('token_usage_record', { response_id: 'summary-response' }),
    message(1, { id: 'analysis', phase: 'analysis', content: [{ type: 'output_text', text: 'SECRET_ANALYSIS' }] }),
    message(1, { id: 'analysis-channel', channel: 'analysis', content: [{ type: 'output_text', text: 'SECRET_CHANNEL' }] }),
    message(0, { id: 'system', role: 'system', content: [{ type: 'input_text', text: 'SECRET_SYSTEM' }] }),
    message(0, { id: 'runtime', internal_chat_message_metadata_passthrough: { content_item_kinds: ['agents_md.instructions'] },
      content: [{ type: 'input_text', text: 'SECRET_RUNTIME' }] }),
    message(0, { id: 'broken-provenance', internal_chat_message_metadata_passthrough: { content_item_kinds: ['hooks.additional_context', 'user.text'] },
      content: [{ type: 'input_text', text: 'SECRET_BROKEN_KIND_MAP' }] }),
    message(0, { id: 'mixed', internal_chat_message_metadata_passthrough: { content_item_kinds: ['hooks.additional_context', 'user.text'] },
      content: [{ type: 'input_text', text: 'SECRET_HOOK' }, { type: 'input_text', text: 'Visible authored question' }] }),
    ...Array.from({ length: 20 }, (_, i) => message(i, { id: `middle-${i}` })),
    record('compacted', { compaction_response_id: 'summary-response', message: 'different wrapper' }),
    message(1, { id: 'native-summary', content: [{ type: 'output_text', text: 'User requested summary' }] }),
    record('compacted', { message: 'Wrapper\nUser requested summary' }),
    ...Array.from({ length: 10 }, (_, i) => message(i, { id: `last-${i}` })),
    record('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'native-summary' } }),
  ].join('');
  const result = await allPages(fixture(t, data), 3);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /SECRET_/);
  assert.ok(result.messages.some(row => row.id === 'native-summary'));
  assert.equal(result.messages.find(row => row.id === 'mixed')?.text, 'Visible authored question');
  assert.equal(result.messages.length, 33);
});

test('append keeps the original byte boundary and discovers new compaction visibility', async t => {
  const data = Array.from({ length: 10 }, (_, i) => message(i, { id: `before-${i}` })).join('');
  const f = fixture(t, data);
  const first = await f.read({ limit: 3 });
  appendFileSync(f.file, message(10, { id: 'new-message' }));
  const second = await f.read({ before: first.nextCursor, limit: 3 });
  assert.deepEqual(first.messages.map(row => row.id), ['before-7', 'before-8', 'before-9']);
  assert.deepEqual(second.messages.map(row => row.id), ['before-4', 'before-5', 'before-6']);
  assert.deepEqual((await f.read({ limit: 3 })).messages.map(row => row.id), ['before-8', 'before-9', 'new-message']);

  const g = fixture(t, message(1, { id: 'will-be-summary' }) + record('token_usage_record', { response_id: 'late-compact' }) +
    Array.from({ length: 10 }, (_, i) => message(i, { id: `visible-${i}` })).join(''));
  let page = await g.read({ limit: 3 });
  appendFileSync(g.file, record('compacted', { compaction_response_id: 'late-compact' }));
  const old = [];
  while (page.nextCursor) { page = await g.read({ before: page.nextCursor, limit: 3 }); old.push(...page.messages); }
  assert.ok(!old.some(row => row.id === 'will-be-summary'));
});

test('rewrites, truncation, replacement and source changes reject old cursors', async t => {
  for (const change of ['same-size', 'larger-rewrite', 'truncate', 'inode', 'path']) {
    const f = fixture(t, Array.from({ length: 8 }, (_, i) => message(i)).join(''));
    const first = await f.read({ limit: 2 });
    const text = readFileSync(f.file, 'utf8');
    if (change === 'same-size') writeFileSync(f.file, text.replace('message-0', 'CHANGED-0'));
    if (change === 'larger-rewrite') writeFileSync(f.file, text.replace('message-0', 'CHANGED-0') + message(10));
    if (change === 'truncate') writeFileSync(f.file, record('session_meta', { id }) + message(99));
    if (change === 'inode') { renameSync(f.file, f.file + '.old'); writeFileSync(f.file, text); }
    if (change === 'path') { const path = join(f.home, 'sessions', 'other.jsonl'); writeFileSync(path, text); f.db.prepare('UPDATE threads SET rollout_path=?').run(path); }
    await assert.rejects(f.read({ before: first.nextCursor }), error => error.status === 409, change);
  }
});

test('cursor cannot cross a thread, a source home, expiry, or a worker restart', async t => {
  const f = fixture(t, Array.from({ length: 8 }, (_, i) => message(i)).join(''));
  const first = await f.read({ limit: 2 });
  await assert.rejects(f.reader.read(f.home, otherId, { before: first.nextCursor }), error => error.status === 409);
  await assert.rejects(f.read({ before: first.nextCursor.slice(0, -4) + 'abcd' }), error => error.status === 409);
  const isolated = fixture(t, Array.from({ length: 8 }, (_, i) => message(i)).join(''));
  await assert.rejects(f.reader.read(isolated.home, id, { before: first.nextCursor }), error => error.status === 409);
  await assert.rejects(isolated.read({ before: first.nextCursor }), error => error.status === 409);
  const expired = fixture(t, Array.from({ length: 8 }, (_, i) => message(i)).join(''), { reader: { limits: { ttlMs: 1 } } });
  const expiring = await expired.read({ limit: 2 });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(expired.read({ before: expiring.nextCursor }), error => error.status === 409);
});

test('compressed histories page with the same fallback identities and never create plaintext files', async t => {
  const text = Array.from({ length: 175 }, (_, i) => message(i)).join('');
  const plain = fixture(t, text), compressed = fixture(t, text, { compressed: true });
  const before = readdirSync(join(compressed.home, 'sessions'));
  const a = await allPages(plain), b = await allPages(compressed);
  assert.deepEqual(b.messages, a.messages);
  assert.deepEqual(readdirSync(join(compressed.home, 'sessions')), before);
  const first = await compressed.read({ limit: 2 });
  writeFileSync(compressed.file, record('session_meta', { id }) + text);
  await assert.rejects(compressed.read({ before: first.nextCursor }), error => error.status === 409);
});

test('index and decode limits fail closed while the main event loop keeps serving', async t => {
  const small = fixture(t, Array.from({ length: 6 }, (_, i) => message(i)).join(''), { reader: { limits: { maxMessages: 5 } } });
  await assert.rejects(small.read(), error => error.status === 413);
  const oversized = fixture(t, record('ignored', { body: 'x'.repeat(2000) }), { reader: { limits: { maxRecordBytes: 1024 } } });
  await assert.rejects(oversized.read(), error => error.status === 413);
  const large = fixture(t, Array.from({ length: 25000 }, (_, i) => message(i)).join(''));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try { assert.equal((await large.read()).messages.length, 80); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 1, 'worker parsing and I/O do not block the main event loop');
});

test('parallel identical reads coalesce and bounded pending requests reject overload', async t => {
  const f = fixture(t, Array.from({ length: 100 }, (_, i) => message(i)).join(''), { reader: { maxPending: 1 } });
  const a = f.read(), b = f.read();
  assert.equal(a, b);
  await assert.rejects(f.read({ limit: 1 }), error => error.status === 503);
  const result = await a;
  assert.equal(result.messages.length, 80);
  assert.equal((await f.read({ limit: 1 })).messages.length, 1);
});

test('timed-out workers terminate and a subsequent read starts a clean reader', async t => {
  const f = fixture(t, Array.from({ length: 100 }, (_, i) => message(i)).join(''), { reader: { timeoutMs: 1 } });
  await assert.rejects(f.read(), error => error.status === 503);
  assert.equal(f.reader.pending.size, 0);
  f.reader.timeoutMs = 10000;
  assert.equal((await f.read()).messages.length, 80);
});

test('snapshot eviction rejects its cursor while leaving a fresh first-page read available', async t => {
  const f = fixture(t, Array.from({ length: 8 }, (_, i) => message(i)).join(''), { reader: { limits: { maxSnapshots: 1 } } });
  const first = await f.read({ limit: 2 });
  const g = fixture(t, Array.from({ length: 8 }, (_, i) => message(i)).join(''));
  await f.reader.read(g.home, id, { limit: 2 });
  await assert.rejects(f.read({ before: first.nextCursor }), error => error.status === 409);
  assert.equal((await f.read({ limit: 2 })).messages.length, 2);
});

test('compressed recent reads preserve legacy tail IDs and private full-text content evidence', async t => {
  const text = message(0) + record('ignored', { data: randomBytes(3300000).toString('base64') }) +
    message(1, { content: [{ type: 'output_text', text: '最后一条完整回复' }] });
  const plain = fixture(t, text), compressed = fixture(t, text, { compressed: true });
  const expected = readPersistedHistory(plain.home, id), recent = await compressed.reader.recent(compressed.home, id);
  assert.deepEqual(recent.messages, expected.messages);
  assert.equal(recent.hasMore, true);
  assert.equal(recent[POCKET_CONTENT].version, expected[POCKET_CONTENT].version);
  assert.equal(recent[POCKET_CONTENT].readable, true);
  assert.equal(contentSourceIsCurrent(recent[POCKET_CONTENT]), true);
  assert.equal(recent[POCKET_CONTENT].source.file, realpathSync(compressed.file + '.zst'));
  assert.doesNotMatch(JSON.stringify(recent), /source.*file|candidate|evidence|pocket-content-evidence/);
  assert.ok(!JSON.stringify(recent).includes(compressed.home));

  const store = new NavigatorStore(join(compressed.home, 'pocket'));
  t.after(() => store.close());
  const service = new PocketContentService(store, compressed.home);
  const projected = service.transcript(id, recent);
  assert.equal(projected.pocketContent.known, true);
  assert.equal(projected.pocketContent.messageId, recent.messages.at(-1).id);
  writeFileSync(compressed.file + '.zst', zstdCompressSync(record('session_meta', { id }) + message(3)));
  assert.equal(service.transcript(id, recent).pocketContent.known, false, 'changed compressed source revokes stale read evidence');
});

test('compressed recent truncation never grants a complete read version, and paging never carries evidence', async t => {
  const f = fixture(t, message(1, { id: 'long-answer', content: [{ type: 'output_text', text: 'x'.repeat(26000) }] }), { compressed: true });
  const recent = await f.reader.recent(f.home, id);
  assert.equal(recent[POCKET_CONTENT].known, true);
  assert.equal(recent[POCKET_CONTENT].readable, false);
  const page = await f.read();
  assert.equal(page[POCKET_CONTENT], undefined);
  const store = new NavigatorStore(join(f.home, 'pocket'));
  t.after(() => store.close());
  assert.equal(new PocketContentService(store, f.home).transcript(id, recent).pocketContent.known, false);
});

test('an asynchronous recent read cannot become newer evidence solely by finishing late', async t => {
  const f = fixture(t, message(1), { compressed: true });
  const reading = f.reader.recent(f.home, id);
  const laterObservation = contentEvidence({ known: false }, 'newer-source', 'newer-version');
  const recent = await reading;
  assert.ok(recent[POCKET_CONTENT].source.order < laterObservation.source.order);
});

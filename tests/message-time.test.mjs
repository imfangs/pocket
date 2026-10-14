import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLastMessageAt } from '../server/message-time.mjs';

const firstAt = '2026-10-13T11:39:41.000Z';
const nextAt = '2026-10-14T06:16:09.000Z';
const laterAt = '2026-10-14T06:30:00.000Z';
const row = (type, payload, timestamp = nextAt) => JSON.stringify({ type, payload, timestamp });
const message = (text, timestamp = firstAt, extra = {}) => row('response_item', {
  type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }], ...extra,
}, timestamp);
const lines = (...items) => items.join('\n') + '\n';
function fixture(t, content = [], id = 'thread') {
  const home = fs.mkdtempSync(join(tmpdir(), 'pocket-message-time-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(join(home, 'sessions'));
  fs.mkdirSync(join(home, 'archived_sessions'));
  const file = join(home, 'sessions', 'rollout.jsonl');
  fs.writeFileSync(file, lines(row('session_meta', { id }), ...content));
  return { home, file, id };
}

test('settings, token, read and tool events never advance the last visible message time', t => {
  const { home, file, id } = fixture(t, [message('Last visible reply'),
    row('event_msg', { type: 'thread_settings_applied' }),
    row('event_msg', { type: 'thread_read' }),
    row('event_msg', { type: 'token_count' }),
    row('token_usage_record', { response_id: 'response' }),
    row('response_item', { type: 'custom_tool_call_output', output: 'Internal output' }),
    message('Private reasoning', nextAt, { phase: 'analysis' }),
    message('Injected rules', nextAt, { role: 'developer' }),
  ]);
  assert.equal(readLastMessageAt(home, id, file), Date.parse(firstAt));
  fs.appendFileSync(file, lines(message('Next query', laterAt, { role: 'user', phase: undefined })));
  assert.equal(readLastMessageAt(home, id, file), Date.parse(laterAt));
});

test('pure image and file inputs count without treating injected media as a new message', t => {
  const { home, file, id } = fixture(t, [message('Older reply'), message('', nextAt, {
    role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,fixture' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.image'] },
  })]);
  assert.equal(readLastMessageAt(home, id, file), Date.parse(nextAt));
  fs.appendFileSync(file, lines(message('', laterAt, {
    role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,context' }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['hooks.additional_context'] },
  })));
  assert.equal(readLastMessageAt(home, id, file), Date.parse(nextAt));
  fs.appendFileSync(file, lines(message('', laterAt, {
    role: 'user', content: [{ type: 'input_file', file_id: 'fixture-file' }],
  })));
  assert.equal(readLastMessageAt(home, id, file), Date.parse(laterAt));
});

test('internal compaction summaries stay hidden while native visible summaries count', t => {
  const { home, file, id } = fixture(t, [message('Real reply'),
    message('Internal summary', nextAt, { id: 'summary' }),
    row('token_usage_record', { response_id: 'compaction' }),
    row('compacted', { compaction_response_id: 'compaction', message: 'Wrapped internal summary' }),
  ]);
  assert.equal(readLastMessageAt(home, id, file), Date.parse(firstAt));
  fs.appendFileSync(file, lines(message('User-requested summary', laterAt, { id: 'native-summary' }),
    row('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'native-summary' } }),
    row('compacted', { message: 'User-requested summary' })));
  assert.equal(readLastMessageAt(home, id, file), Date.parse(laterAt));
});

test('tail windows expand over large UTF-8 records and use the last complete message during append', t => {
  const { home, file, id } = fixture(t, [message('中'.repeat(120000), firstAt),
    row('event_msg', { type: 'thread_settings_applied', value: 'x'.repeat(90000) }),
  ]);
  assert.equal(readLastMessageAt(home, id, file), Date.parse(firstAt));
  const pending = message('New message', nextAt);
  fs.appendFileSync(file, pending.slice(0, -5));
  assert.equal(readLastMessageAt(home, id, file), Date.parse(firstAt));
  fs.appendFileSync(file, pending.slice(-5) + '\n');
  assert.equal(readLastMessageAt(home, id, file), Date.parse(nextAt));
});

test('empty, invalid-timestamp and out-of-budget histories have no invented message time', t => {
  const { home, file, id } = fixture(t);
  assert.equal(readLastMessageAt(home, id, file), null);
  fs.appendFileSync(file, lines(message('', nextAt), message('Undated message', 'invalid')));
  assert.equal(readLastMessageAt(home, id, file), null);
  fs.writeFileSync(file, lines(row('session_meta', { id }), message('Far older reply'),
    row('event_msg', { type: 'internal', value: 'x'.repeat(4 * 1024 * 1024 + 100) })));
  assert.equal(readLastMessageAt(home, id, file), null);
  fs.writeFileSync(file, lines(row('session_meta', { id }), message('x'.repeat(4 * 1024 * 1024 + 100))));
  assert.equal(readLastMessageAt(home, id, file), null);
});

test('reader only accepts the matching session under allowed source directories', t => {
  const { home, file, id } = fixture(t, [message('Reply')]);
  assert.equal(readLastMessageAt(home, id, 'sessions/rollout.jsonl'), Date.parse(firstAt));
  assert.equal(readLastMessageAt(home, 'wrong-thread', file), null);
  const outside = join(home, 'outside.jsonl');
  fs.copyFileSync(file, outside);
  assert.equal(readLastMessageAt(home, id, outside), null);
  fs.symlinkSync(outside, join(home, 'sessions', 'escape.jsonl'));
  assert.equal(readLastMessageAt(home, id, join(home, 'sessions', 'escape.jsonl')), null);
  assert.equal(readLastMessageAt(home, id, join(home, 'sessions')), null);
  assert.equal(readLastMessageAt(home, id, 'missing.jsonl'), null);
  assert.equal(readLastMessageAt(home, id, null), null);
  const archived = join(home, 'archived_sessions', 'rollout.jsonl');
  fs.copyFileSync(file, archived);
  assert.equal(readLastMessageAt(home, id, archived), Date.parse(firstAt));
});

test('warm reads reuse cached metadata and file changes or identity replacement invalidate it', t => {
  const { home, file, id } = fixture(t, [message('Reply')]);
  const read = t.mock.method(fs, 'readSync');
  assert.equal(readLastMessageAt(home, id, file), Date.parse(firstAt));
  const reads = read.mock.callCount();
  assert.ok(reads > 0);
  assert.equal(readLastMessageAt(home, id, file), Date.parse(firstAt));
  assert.equal(read.mock.callCount(), reads);
  fs.appendFileSync(file, lines(message('New reply', nextAt)));
  assert.equal(readLastMessageAt(home, id, file), Date.parse(nextAt));
  assert.ok(read.mock.callCount() > reads);
  const current = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, current.replaceAll(nextAt, laterAt));
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(file, future, future);
  assert.equal(readLastMessageAt(home, id, file), Date.parse(laterAt));
  fs.writeFileSync(file, lines(row('session_meta', { id: 'replaced' }), message('Different thread', laterAt)));
  assert.equal(readLastMessageAt(home, id, file), null);
});

test('a complete message exactly at the tail boundary is not discarded', t => {
  const boundary = 64 * 1024;
  const empty = message('');
  const exactMessage = message('x'.repeat(boundary - Buffer.byteLength(empty) - 1));
  assert.equal(Buffer.byteLength(exactMessage + '\n'), boundary);
  const { home, file, id } = fixture(t, [exactMessage]);
  const read = t.mock.method(fs, 'readSync');
  assert.equal(readLastMessageAt(home, id, file), Date.parse(firstAt));
  assert.equal(read.mock.callCount(), 2);
});

test('cache retains a full catalog of 1500 sessions without warm-sync body reads', t => {
  const { home } = fixture(t);
  const files = Array.from({ length: 1500 }, (_, i) => {
    const id = `catalog-${i}`, file = join(home, 'sessions', `${id}.jsonl`);
    fs.writeFileSync(file, lines(row('session_meta', { id }), message('Reply')));
    return { id, file };
  });
  for (const { id, file } of files) assert.equal(readLastMessageAt(home, id, file), Date.parse(firstAt));
  const read = t.mock.method(fs, 'readSync');
  for (const { id, file } of files) assert.equal(readLastMessageAt(home, id, file), Date.parse(firstAt));
  assert.equal(read.mock.callCount(), 0);
});

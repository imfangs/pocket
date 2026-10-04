import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeNativeReadState } from '../server/read-state.mjs';
import { readHistorySourceVersion } from '../server/history.mjs';
import { readLocalReadStateSnapshot } from '../server/unread.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const requestId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t, options = {}) {
  const home = mkdtempSync('/tmp/pocket-read-ipc-');
  mkdirSync(join(home, 'sessions')); mkdirSync(join(home, 'ipc'), { mode: 0o700 });
  const rollout = join(home, 'sessions', 'fixture.jsonl');
  writeFileSync(rollout, JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?)').run(id, rollout); db.close();
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey' }));
  const identityKey = digest(['execution-storage', 'apikey']);
  const executionHostKey = 'local:' + digest(['local', 'local', null]);
  const global = { 'electron-thread-read-state-v1': { version: 1, unreadByIdentity: { [identityKey]: { [executionHostKey]: [id] } } } };
  const saveGlobal = () => writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify(global));
  saveGlobal();
  const calls = [];
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readUInt32LE(0) + 4) {
        const size = pending.readUInt32LE(0), message = JSON.parse(pending.subarray(4, size + 4));
        pending = pending.subarray(size + 4); calls.push(message);
        if (message.method === 'initialize') {
          options.onInitialize?.({ rollout });
          const body = Buffer.from(JSON.stringify({ type: 'response', requestId: message.requestId, resultType: 'success', result: { clientId: 'pocket-fixture' } }));
          const header = Buffer.alloc(4); header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
        }
        if (message.method === 'thread-read-state-changed') {
          global['electron-thread-read-state-v1'].unreadByIdentity[identityKey][executionHostKey] = [];
          saveGlobal(); options.onRead?.({ rollout });
        }
      }
    });
  });
  const socket = join(home, 'ipc', 'ipc.sock'); server.listen(socket); await once(server, 'listening'); chmodSync(socket, 0o700);
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }); });
  const expected = { sourceVersion: readHistorySourceVersion(home, id), ...readLocalReadStateSnapshot(home, id) };
  delete expected.unread;
  return { home, rollout, calls, expected, run: () => writeNativeReadState({ threadId: id, requestId, codexHome: home, expected }) };
}

test('native read bridge uses the versioned original broadcast and independently confirms its state', async t => {
  const { calls, rollout, run } = await fixture(t);
  const before = readFileSync(rollout);
  assert.equal((await run()).status, 'read');
  assert.equal(calls[0].params.clientType, 'codex-navigator');
  assert.deepEqual(calls.map(call => call.method), ['initialize', 'thread-read-state-changed']);
  const change = calls[1];
  assert.equal(change.type, 'broadcast'); assert.equal(change.version, 3);
  assert.equal(change.params.hasUnreadTurn, false); assert.equal(change.params.conversationId, id);
  assert.deepEqual(change.params.context.identity, { kind: 'execution-storage', authMode: 'apikey' });
  assert.deepEqual(readFileSync(rollout), before);
});

test('a saved-file change before native preflight sends no IPC messages', async t => {
  const { rollout, calls, run } = await fixture(t);
  appendFileSync(rollout, '{}\n');
  assert.equal((await run()).status, 'stale'); assert.equal(calls.length, 0);
});

test('a new activity during native initialization is rejected before the read broadcast', async t => {
  const { calls, run } = await fixture(t, { onInitialize: ({ rollout }) => appendFileSync(rollout, '{}\n') });
  assert.equal((await run()).status, 'stale');
  assert.deepEqual(calls.map(call => call.method), ['initialize']);
});

test('activity after the native broadcast stays unknown and never emits an unread compensation', async t => {
  const { calls, run } = await fixture(t, { onRead: ({ rollout }) => appendFileSync(rollout, '{}\n') });
  const result = await run();
  assert.equal(result.status, 'unknown');
  // The append can be detected between either of the readback's two fstats.
  assert.ok(['observation_changed_after_write', 'read_outcome_unknown'].includes(result.code));
  assert.deepEqual(calls.filter(call => call.type === 'broadcast').map(call => call.params.hasUnreadTurn), [false]);
});

test('unsupported auth and stale host identities are refused before any native write', async t => {
  const wrongHost = await fixture(t);
  wrongHost.expected.executionHostKey = 'local:' + '0'.repeat(64);
  assert.equal((await wrongHost.run()).status, 'stale'); assert.equal(wrongHost.calls.length, 0);
  const wrongAuth = await fixture(t);
  writeFileSync(join(wrongAuth.home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  assert.equal((await wrongAuth.run()).status, 'unavailable'); assert.equal(wrongAuth.calls.length, 0);
});

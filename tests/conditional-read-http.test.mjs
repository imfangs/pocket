import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/index.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const requestId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const decode = response => JSON.parse(response.headers['content-encoding'] === 'gzip' ? gunzipSync(response.body) : response.body);
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-conditional-read-'));
  const state = { scans: 0, transcriptReads: 0, historyReads: 0, clock: 100000,
    title: 'Fixture', text: 'Synthetic readable text. '.repeat(150), failSource: false, failTranscript: false };
  t.mock.method(Date, 'now', () => state.clock);
  const app = makeApp({ dataDir: dir, codexHome: dir, machineId: 'ged',
    openThread: async () => { assert.fail('conditional reads must not open a native task'); },
    readSource: () => {
      state.scans++;
      if (state.failSource) throw new Error('synthetic source unavailable');
      return { threads: [{ id, title: state.title, cwd: dir, archived: false, updatedAt: 1 }],
        projects: [], sourceInfo: { syncedAt: state.clock, databaseMtime: 1 } };
    },
    automations: { read: () => ({ ok: true, automations: [] }) },
    notifications: { now: () => state.clock, send: async () => { assert.fail('no actual notifications'); } },
    readHistory: () => {
      state.transcriptReads++;
      if (state.failTranscript) throw new Error('synthetic transcript unavailable');
      return { messages: [{ id: 'reply', role: 'assistant', text: state.text, phase: 'final' }], hasMore: false };
    },
    desktopRequest: async payload => {
      assert.equal(payload.operation, 'history', 'fixture rejects every native mutation');
      state.historyReads++;
      return { ok: true, source: 'desktop', runtime: 'idle', resumeState: 'resumed', canSend: true,
        latestTurnId: 'turn', latestTurnStatus: 'completed', pendingRequests: [],
        turnTiming: { turnId: 'turn', status: 'completed', startedAt: 1, durationMs: 500, observedAt: state.clock },
        messages: [{ id: 'reply', role: 'assistant', text: state.text, phase: 'final' }] };
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (path = '/api/catalog', headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    const request = http.request(base + path, { method,
      headers: { Authorization: `Bearer ${app.auth.localToken}`, ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.end(method === 'POST' ? '{}' : undefined);
  });
  return { state, app, call, base, dir };
}

test('catalog conditional reads transfer no body and retain auth, machine, no-store and compression headers', async t => {
  const { call, state, app } = await fixture(t);
  const first = await call('/api/catalog', { 'Accept-Encoding': 'gzip' });
  assert.equal(first.status, 200); assert.match(first.headers.etag, /^W\/"pocket-read-v1-/);
  const saved = decode(first); assert.equal(saved.sourceInfo.syncedAt, 100000);
  state.clock += 1000; app.sync();
  const repeated = await call('/api/catalog', { 'If-None-Match': first.headers.etag });
  assert.equal(repeated.status, 304); assert.equal(repeated.body.length, 0);
  assert.equal(repeated.headers.etag, first.headers.etag);
  assert.equal(repeated.headers['x-pocket-source-synced-at'], String(state.clock));
  assert.equal(repeated.headers['x-pocket-machine'], 'ged');
  assert.equal(repeated.headers['cache-control'], 'no-store');
  assert.equal(repeated.headers['x-content-type-options'], 'nosniff');
  assert.match(repeated.headers.vary, /Accept-Encoding/);
  assert.equal(repeated.headers['content-encoding'], undefined);
  assert.equal(repeated.headers['content-length'], undefined);
  state.title = 'Changed'; app.sync();
  const changed = await call('/api/catalog', { 'If-None-Match': first.headers.etag });
  assert.equal(changed.status, 200); assert.equal(decode(changed).threads[0].title, 'Changed');
  app.store.failSync(new Error('source failed'));
  assert.equal((await call('/api/catalog', { 'If-None-Match': changed.headers.etag })).status, 200);
});

test('sync refreshes before an explicit 204 and keeps ordinary POST/CSRF behavior', async t => {
  const { call, state, base } = await fixture(t);
  const token = decode(await call()).csrfToken;
  const headers = { Origin: base, 'X-Navigator-Token': token, 'Content-Type': 'application/json' };
  const first = await call('/api/sync', headers, 'POST'), before = state.scans;
  assert.equal(first.status, 200);
  state.clock += 1000;
  const repeat = await call('/api/sync', { ...headers, 'X-Pocket-Read-Version': first.headers.etag }, 'POST');
  assert.equal(repeat.status, 204); assert.equal(repeat.body.length, 0);
  assert.equal(state.scans, before + 1); assert.equal(repeat.headers['x-pocket-source-synced-at'], String(state.clock));
  const standardOnly = await call('/api/sync', { ...headers, 'If-None-Match': first.headers.etag }, 'POST');
  assert.equal(standardOnly.status, 200, 'POST does not overload HTTP If-None-Match with 304');
  state.failSource = true;
  const failed = await call('/api/sync', { ...headers, 'X-Pocket-Read-Version': first.headers.etag }, 'POST');
  assert.equal(failed.status, 500); assert.equal(failed.headers.etag, undefined);
});

test('transcript conditionals still read source and return full bodies for changes or source failure', async t => {
  const { call, state } = await fixture(t), path = `/api/tasks/${id}/transcript`;
  const first = await call(path), before = state.transcriptReads;
  state.clock += 1000;
  const repeated = await call(path, { 'If-None-Match': first.headers.etag });
  assert.equal(repeated.status, 304); assert.equal(repeated.body.length, 0);
  assert.equal(state.transcriptReads, before + 1);
  assert.equal(repeated.headers['x-pocket-checked-at'], String(state.clock));
  assert.match(repeated.headers['server-timing'], /transcript/);
  state.text += ' Changed';
  const changed = await call(path, { 'If-None-Match': first.headers.etag });
  assert.equal(changed.status, 200); assert.ok(decode(changed).messages[0].text.endsWith(' Changed'));
  state.failTranscript = true;
  const failed = await call(path, { 'If-None-Match': changed.headers.etag });
  assert.equal(failed.status, 500); assert.equal(failed.headers.etag, undefined);
});

test('history conditionals reobserve native data, watch notifications and project current queue permissions', async t => {
  const { call, state, app } = await fixture(t), path = `/api/tasks/${id}/history`;
  app.store.db.prepare('INSERT INTO push_devices VALUES(?,?,?,?)').run('synthetic-device', '{}', state.clock, state.clock);
  const first = await call(path, { 'Accept-Encoding': 'gzip' });
  assert.equal(first.headers['content-encoding'], 'gzip');
  const before = state.historyReads;
  state.clock += 4000;
  const repeated = await call(path, { 'If-None-Match': first.headers.etag });
  assert.equal(repeated.status, 304); assert.equal(repeated.body.length, 0);
  assert.equal(state.historyReads, before + 1);
  assert.equal(repeated.headers['x-pocket-checked-at'], String(state.clock));
  assert.equal(repeated.headers['x-pocket-turn-observed-at'], String(state.clock));
  assert.match(repeated.headers['server-timing'], /desktop_history/);
  assert.equal(app.store.db.prepare('SELECT touched_at FROM push_watches WHERE thread_id=?').get(id).touched_at, state.clock);
  app.store.db.prepare('INSERT INTO queue_pauses VALUES(?,?,?)').run(id, requestId, state.clock);
  const paused = await call(path, { 'If-None-Match': repeated.headers.etag });
  assert.equal(paused.status, 200); assert.deepEqual(decode(paused).queuePaused, { stopId: requestId });
  app.store.db.prepare('INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,?,?)').run(requestId, id, 'synthetic', 'unknown', state.clock);
  app.store.db.prepare('INSERT INTO outgoing_messages VALUES(?,?,?,?)').run(requestId, id, 'Synthetic unknown query', 0);
  const unknown = await call(path, { 'If-None-Match': paused.headers.etag });
  assert.equal(unknown.status, 200); assert.equal(decode(unknown).outbox[0].status, 'unknown');
  assert.equal(app.store.db.prepare('SELECT status FROM dispatches WHERE id=?').get(requestId).status, 'unknown');
});

test('conditionals cannot bypass auth, Host, Origin, CSRF or change receipt endpoints', async t => {
  const { call, base } = await fixture(t);
  const first = await call(), etag = first.headers.etag;
  for (const headers of [{ Authorization: '' }, { Host: 'untrusted.test' }, { Origin: 'https://untrusted.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const denied = await call('/api/catalog', { 'If-None-Match': etag, ...headers });
    assert.ok([401, 403].includes(denied.status)); assert.equal(denied.headers.etag, undefined);
  }
  const denied = await call('/api/sync', { Origin: base, 'X-Navigator-Token': 'invalid', 'X-Pocket-Read-Version': etag }, 'POST');
  assert.equal(denied.status, 403); assert.equal(denied.headers.etag, undefined);
  const receipt = await call(`/api/tasks/${id}/messages/${requestId}`, { 'If-None-Match': '*', 'X-Pocket-Read-Version': etag });
  assert.equal(receipt.status, 200); assert.equal(receipt.headers.etag, undefined); assert.equal(decode(receipt).status, 'not_found');
  const weakList = await call('/api/catalog', { 'If-None-Match': `"other", ${etag.slice(2)}` });
  assert.equal(weakList.status, 304);
});

test('not-modified transcript reads still renew only the file capabilities in the current source', async t => {
  const { call, state, dir } = await fixture(t), path = `/api/tasks/${id}/transcript`;
  const file = join(dir, 'fixture.md'); writeFileSync(file, 'Synthetic file content');
  state.text = `[Read fixture](${file})`;
  const first = await call(path), fileUrl = decode(first).messages[0].files[file].url;
  state.clock += 3600001;
  const repeated = await call(path, { 'If-None-Match': first.headers.etag });
  assert.equal(repeated.status, 304);
  const download = await call(fileUrl);
  assert.equal(download.status, 200); assert.equal(download.body.toString(), 'Synthetic file content');
});

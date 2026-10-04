import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/index.mjs';
import { ReadStateService } from '../server/read-state.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const rid = n => `bbbbbbbb-bbbb-7bbb-8bbb-${String(n).padStart(12, '0')}`;
const last = { id: 'last-visible', role: 'assistant', text: 'The result the user has read.' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-read-state-'));
  const state = { sourceVersion: 'saved-v1', identityKey: 'identity', executionHostKey: 'host', unread: true, calls: [], now: 1000, turnStatus: 'completed' };
  const app = makeApp({ dataDir: dir,
    readSource: () => ({ threads: [{ id, title: 'Read fixture', archived: false, hasUnreadTurn: state.unread, needsInput: state.unread }], projects: [], sourceInfo: {} }),
    readHistory: () => {
      options.onTranscript?.(state);
      return { messages: [last], hasMore: false, turnTiming: state.turnStatus ? { turnId: 'ended-turn', status: state.turnStatus } : null };
    },
    desktopRequest: async () => ({ ok: false, code: 'desktop_unavailable' }),
    readState: {
      readSnapshot: () => ({ sourceVersion: state.sourceVersion, identityKey: state.identityKey, executionHostKey: state.executionHostKey, unread: state.unread }),
      write: async payload => { state.calls.push(payload); state.unread = false; return { status: 'read' }; },
      now: () => state.now, ...options,
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const authorization = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await (await fetch(base + '/api/catalog', { headers: authorization })).json();
  const call = (path, method = 'GET', body) => fetch(base + path, { method,
    headers: { ...authorization, Origin: base, 'Content-Type': 'application/json', 'X-Navigator-Token': catalog.csrfToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const observe = async () => (await (await call(`/api/tasks/${id}/transcript`)).json()).readObservation;
  const mark = async (observation, requestId = rid(1)) => (await (await call(`/api/tasks/${id}/read`, 'POST', { requestId, observationToken: observation.token })).json());
  return { app, state, base, authorization, call, observe, mark };
}

test('GET only issues a bound reading observation; explicit read synchronizes native catalog state', async t => {
  const { state, observe, mark } = await fixture(t);
  const observation = await observe();
  assert.equal(typeof observation?.token, 'string');
  assert.equal(observation.lastVisibleItemId, last.id);
  assert.equal(observation.visibleVersion, digest([last.id, last.role, last.text]));
  assert.equal(state.calls.length, 0);
  const result = await mark(observation);
  assert.equal(result.status, 'read'); assert.equal(result.thread.hasUnreadTurn, false);
  assert.equal(state.calls.length, 1);
  assert.equal((await mark(observation)).status, 'read'); assert.equal(state.calls.length, 1);
});

test('new saved activity rejects the old observation before invoking the native setter', async t => {
  const { state, observe, mark } = await fixture(t);
  const observation = await observe();
  assert.equal(typeof observation?.token, 'string');
  state.sourceVersion = 'new-completion';
  assert.equal((await mark(observation)).status, 'stale');
  assert.equal(state.calls.length, 0); assert.equal(state.unread, true);
});

test('unknown native outcomes are not replayed with the same request or another request for that observation', async t => {
  let writes = 0;
  const { observe, mark } = await fixture(t, { write: async () => { writes++; return { status: 'unknown' }; } });
  const observation = await observe();
  assert.equal(typeof observation?.token, 'string');
  assert.equal((await mark(observation)).status, 'unknown');
  assert.equal((await mark(observation)).status, 'unknown');
  assert.equal((await mark(observation, rid(2))).status, 'unknown');
  assert.equal(writes, 1);
});

test('only unread ended saved turns issue observations, including when live history is unavailable', async t => {
  const { state, observe } = await fixture(t);
  for (const status of ['inProgress', undefined]) {
    state.turnStatus = status;
    assert.equal(await observe(), null);
  }
  state.turnStatus = 'completed'; state.unread = false;
  assert.equal(await observe(), null);
  state.unread = true; state.turnStatus = 'interrupted';
  assert.equal(typeof (await observe()).token, 'string');
});

test('a source change during text reading never binds old visible text to a newer source version', async t => {
  const { observe, state } = await fixture(t, { onTranscript: state => { state.sourceVersion += '-new'; } });
  assert.equal(await observe(), null); assert.equal(state.calls.length, 0);
});

test('expired observations and changed identity or host never call the setter', async t => {
  const { state, observe, mark } = await fixture(t);
  const expired = await observe(); state.now += 120001;
  assert.equal((await mark(expired, rid(1))).status, 'stale');
  const identity = await observe(); state.identityKey = 'another-identity';
  assert.equal((await mark(identity, rid(2))).status, 'stale');
  const host = await observe(); state.executionHostKey = 'another-host';
  assert.equal((await mark(host, rid(3))).status, 'stale');
  assert.equal(state.calls.length, 0);
});

test('observations bind exact threads and request IDs cannot be reused for different observations', async t => {
  const { app, state, call, observe, mark } = await fixture(t);
  const observation = await observe();
  const otherId = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
  app.store.sync({ threads: [{ id, archived: false }, { id: otherId, archived: false }], projects: [], sourceInfo: {} });
  const other = await (await call(`/api/tasks/${otherId}/read`, 'POST', { requestId: rid(1), observationToken: observation.token })).json();
  assert.equal(other.status, 'stale'); assert.equal(state.calls.length, 0);
  const conflict = await call(`/api/tasks/${id}/read`, 'POST', { requestId: rid(1), observationToken: observation.token });
  assert.equal(conflict.status, 409);
  assert.equal((await mark(observation, rid(2))).status, 'read');
});

test('new observations support explicit recovery after unknown while automatic retry of old observations never writes', async t => {
  let writes = 0, state;
  const env = await fixture(t, { write: async () => {
    writes++;
    if (writes === 1) return { status: 'unknown', code: 'readback_unconfirmed' };
    state.unread = false; return { status: 'read' };
  } });
  state = env.state;
  const old = await env.observe();
  assert.equal((await env.mark(old)).status, 'unknown');
  assert.equal((await env.mark(old, rid(2))).status, 'unknown'); assert.equal(writes, 1);
  const fresh = await env.observe();
  assert.notEqual(fresh.token, old.token); assert.equal(fresh.visibleVersion, old.visibleVersion);
  assert.equal((await env.mark(fresh, rid(3))).status, 'read'); assert.equal(writes, 2);
});

test('unknown outcomes can be confirmed by read-only state after a restart without repeating the native write', async t => {
  let writes = 0;
  const { app, state, observe, mark } = await fixture(t, { write: async () => { writes++; return { status: 'unknown' }; } });
  const observation = await observe(); assert.equal((await mark(observation)).status, 'unknown');
  state.unread = false;
  const restarted = new ReadStateService(app.store, '/fixture', {
    readSnapshot: () => ({ sourceVersion: state.sourceVersion, identityKey: state.identityKey, executionHostKey: state.executionHostKey, unread: state.unread }),
    write: async () => assert.fail('Read-only recovery must never repeat the write'),
  });
  assert.equal((await restarted.markRead(id, { requestId: rid(1), observationToken: observation.token })).status, 'read');
  assert.equal(writes, 1);
});

test('same-thread concurrent operations merge an identical request and reject a second independent write', async t => {
  let finish, started, writes = 0, state;
  const began = new Promise(resolve => { started = resolve; });
  const env = await fixture(t, { write: async () => {
    writes++; started(); await new Promise(resolve => { finish = resolve; });
    state.unread = false; return { status: 'read' };
  } });
  state = env.state;
  const first = await env.observe(), second = await env.observe();
  const one = env.mark(first); await began;
  const duplicate = env.mark(first);
  assert.equal((await env.mark(second, rid(2))).status, 'unavailable');
  finish();
  assert.equal((await one).status, 'read'); assert.equal((await duplicate).status, 'read'); assert.equal(writes, 1);
});

test('a false native success or activity arriving after broadcast is unknown, never stale or a false catalog update', async t => {
  const unchanged = await fixture(t, { write: async () => ({ status: 'read' }) });
  assert.equal((await unchanged.mark(await unchanged.observe())).status, 'unknown');
  let state;
  const changed = await fixture(t, { write: async () => { state.sourceVersion = 'arrived-after-write'; state.unread = false; return { status: 'read' }; } });
  state = changed.state;
  const result = await changed.mark(await changed.observe());
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'observation_changed_after_write'); assert.equal(result.thread, undefined);
});

test('mark-read routes preserve authentication, CSRF and Origin restrictions without invoking native writes', async t => {
  const { base, authorization, state, call, observe } = await fixture(t);
  const observation = await observe(), path = `/api/tasks/${id}/read`, body = JSON.stringify({ requestId: rid(1), observationToken: observation.token });
  assert.equal((await fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(base + path, { method: 'POST', headers: { ...authorization, Origin: base, 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(base + path, { method: 'POST', headers: { ...authorization, Origin: 'https://elsewhere.test', 'Content-Type': 'application/json' }, body })).status, 403);
  assert.equal((await call(path, 'POST', { requestId: rid(1), observationToken: observation.token, hasUnreadTurn: true })).status, 400);
  assert.equal(state.calls.length, 0);
});

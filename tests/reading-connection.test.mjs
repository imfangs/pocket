import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';
import { makeApp } from '../server/index.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const requestId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const source = (extra = {}) => ({ threads: [{ id, title: 'Reading connection fixture', archived: false, ...extra }], projects: [], sourceInfo: {} });
const saved = () => ({ source: 'rollout', runtime: 'unavailable', canSend: false, messages: [] });
const live = (extra = {}) => ({ ok: true, source: 'desktop', resumeState: 'resumed', runtime: 'idle', canSend: true, queueReady: true, messages: [], ...extra });
const unavailable = () => ({ ok: false, code: 'desktop_unavailable', connectionReason: 'owner_unavailable' });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function settled(service) {
  for (let i = 0; i < 100; i++) {
    const state = service.connection(id);
    if (state.status !== 'connecting') return state;
    await tick();
  }
  assert.fail('Reading connection did not settle');
}
function fixture(t, request = async () => live(), openThread = async () => {}, thread = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-reading-connect-'));
  const store = new NavigatorStore(directory); store.sync(source(thread));
  const service = new DesktopService(store, '/fixture', request, saved,
    { openThread, connectionTimeoutMs: 150, connectionPollMs: 5 });
  t.after(() => { service.stopQueue(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, store };
}
function queued(store, status = 'queued') {
  store.db.prepare('INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,?,?)')
    .run(requestId, id, 'fixture', status, 1);
  store.db.prepare('INSERT INTO outgoing_messages(id,thread_id,text) VALUES(?,?,?)').run(requestId, id, 'An existing message');
}

test('passive connection reuses a loaded owner without native open, navigation bookkeeping or queue wakeup', async t => {
  let opens = 0, wakes = 0; const calls = [];
  const { service, store } = fixture(t, async payload => { calls.push(payload.operation); return live(); }, async () => { opens++; });
  service.queueStarted = true; service.processQueueForThread = async () => { wakes++; };
  const state = service.connect(id, { reading: true });
  assert.equal(state.status, 'connecting');
  assert.equal((await settled(service)).status, 'connected');
  assert.equal(opens, 0); assert.equal(wakes, 0); assert.deepEqual(calls, ['history']);
  assert.equal(store.annotation(id, store.thread(id)).lastOpenedAt, null);
});

test('passive connection reads first and opens the original thread once only when necessary', async t => {
  let opens = 0; const calls = [];
  const { service } = fixture(t, async payload => { calls.push(payload.operation); return opens ? live() : unavailable(); }, async () => { opens++; });
  const first = service.connect(id, { reading: true });
  assert.equal(service.connect(id, { reading: true }).requestId, first.requestId);
  assert.equal((await settled(service)).status, 'connected');
  assert.equal(opens, 1); assert.deepEqual(calls, ['history', 'history']);
});

test('known source and local operation blockers skip before any bridge read or native open', async t => {
  const cases = [
    ['archived', ({ store }) => store.sync(source({ archived: true }))],
    ['missing', ({ store }) => store.sync({ threads: [], projects: [], sourceInfo: {} })],
    ['excluded', ({ store }) => store.sync({ threads: [], excludedThreadIds: [id], excludedThreadStates: [{ id, archived: false }], projects: [], sourceInfo: {} })],
    ['separator', ({ store }) => store.sync(source({ separator: true }))],
    ['lifecycle', ({ service }) => { service.lifecycleBlocked = () => true; }],
    ['sending', ({ service }) => service.sending.add(id)],
    ['reservation', ({ service }) => service.queueReservations.add(id)],
    ['outbox queued', ({ store }) => queued(store)],
    ['outbox editing', ({ store }) => queued(store, 'editing')],
    ['outbox rejected', ({ store }) => queued(store, 'rejected')],
    ['unknown receipt without outbox', ({ store }) => store.db.prepare('INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,?,?)').run(requestId, id, 'fixture', 'unknown', 1)],
    ['paused', ({ store }) => store.db.prepare('INSERT INTO queue_pauses VALUES(?,?,?)').run(id, requestId, 1)],
    ['stop', ({ service }) => { service.stops.pending = () => true; }],
    ['compaction', ({ service }) => { service.compactionPending = () => true; }],
    ['model', ({ service }) => { service.models.pending = () => true; }],
    ['rename', ({ service }) => { service.renamePending = () => true; }],
    ['uncertain question response', ({ store }) => store.db.prepare('INSERT INTO request_responses VALUES(?,?,?,?,?,?,?)').run(requestId, id, 'question', 'accept', 'unknown', null, 1)],
  ];
  for (const [name, block] of cases) await t.test(name, t => {
    let calls = 0, opens = 0;
    const f = fixture(t, async () => { calls++; return unavailable(); }, async () => { opens++; }); block(f);
    assert.equal(f.service.connect(id, { reading: true }), null);
    assert.equal(f.service.connection(id).status, 'idle');
    assert.equal(calls, 0); assert.equal(opens, 0);
  });
});

test('a queued message arriving during owner lookup stops passive open and retains its exact row', async t => {
  let finish, opens = 0, wakes = 0;
  const { service, store } = fixture(t, () => new Promise(resolve => { finish = resolve; }), async () => { opens++; });
  service.queueStarted = true; service.processQueueForThread = async () => { wakes++; };
  const started = service.connect(id, { reading: true }); queued(store);
  const before = service.outbox(id); finish(unavailable());
  const end = await settled(service);
  assert.equal(end.status, 'skipped'); assert.equal(end.code, 'reading_blocked');
  assert.equal(end.requestId, started.requestId); assert.equal(end.startedAt, started.startedAt);
  assert(end.checkedAt >= end.startedAt);
  assert.deepEqual(service.outbox(id), before); assert.equal(opens, 0); assert.equal(wakes, 0);
  assert.equal(store.annotation(id, store.thread(id)).lastOpenedAt, null);
});

test('native blocking state is checked before passive completion or opening', async t => {
  for (const state of [live({ pendingRequests: [{ key: 'approval' }] }), live({ compaction: { active: true } }), live({ canSend: false })]) {
    let opens = 0;
    const { service } = fixture(t, async () => state, async () => { opens++; });
    service.connect(id, { reading: true });
    assert.equal((await settled(service)).status, 'skipped'); assert.equal(opens, 0);
  }
});

test('a fresh blocker after native open prevents later passive queue wakeup', async t => {
  let finishOpen, opens = 0, calls = 0;
  const { service, store } = fixture(t, async () => { calls++; return unavailable(); }, () => {
    opens++; return new Promise(resolve => { finishOpen = resolve; });
  });
  service.connect(id, { reading: true });
  for (let i = 0; i < 20 && !finishOpen; i++) await tick();
  assert.equal(opens, 1); queued(store); finishOpen();
  const end = await settled(service);
  assert.equal(end.status, 'skipped'); assert.equal(end.code, 'reading_blocked'); assert.equal(calls, 1);
  assert.equal(service.getReceipt(id, requestId).status, 'queued');
});

test('explicit input upgrades an in-flight passive connection without a second operation or open', async t => {
  let finish, opens = 0, reads = 0, wakes = 0;
  const { service, store } = fixture(t, async () => ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : live(), async () => { opens++; });
  service.queueStarted = true; service.processQueueForThread = async () => { wakes++; };
  const first = service.connect(id, { reading: true }); queued(store);
  const input = service.connect(id); assert.equal(input.requestId, first.requestId);
  await tick(); assert.equal(opens, 1, 'explicit input must not wait for the old owner lookup');
  assert.equal(reads, 1, 'takeover opens without starting another snapshot');
  finish(unavailable());
  assert.equal((await settled(service)).status, 'connected'); assert.equal(opens, 1); assert.equal(wakes, 1);
});

test('an explicit new submission upgrades the passive operation and preserves normal queue delivery', async t => {
  let finish, opens = 0, reads = 0, sends = 0;
  const { service } = fixture(t, async payload => {
    if (payload.operation === 'send') { sends++; assert.equal(payload.requestId, requestId); return { ok: true, turnId: 'fixture-turn' }; }
    return ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : live();
  }, async () => { opens++; });
  service.queueStarted = true;
  const first = service.connect(id, { reading: true });
  const submission = await service.send(id, { requestId, text: 'A newly submitted request', enqueue: true });
  assert.equal(submission.status, 'queued'); assert.equal(service.connection(id).requestId, first.requestId);
  await tick(); assert.equal(opens, 1, 'submission takeover opens now even though its ordinary path is read-first');
  assert.equal(reads, 1); assert.equal(sends, 0);
  finish(unavailable()); await settled(service);
  for (let i = 0; i < 20 && service.getReceipt(id, requestId).status !== 'accepted'; i++) await tick();
  assert.equal(service.getReceipt(id, requestId).status, 'accepted'); assert.equal(sends, 1); assert.equal(opens, 1);
});

test('takeover reuses an already pending native open rather than opening a second time', async t => {
  let finishOpen, opens = 0, reads = 0;
  const { service } = fixture(t, async () => ++reads === 1 ? unavailable() : live(), () => {
    opens++; return new Promise(resolve => { finishOpen = resolve; });
  });
  const passive = service.connect(id, { reading: true });
  for (let i = 0; i < 20 && !finishOpen; i++) await tick();
  assert.equal(opens, 1);
  const explicit = service.connect(id, { open: false });
  assert.equal(explicit.requestId, passive.requestId); service.connect(id); await tick();
  assert.equal(opens, 1); assert.equal(reads, 1);
  finishOpen(); assert.equal((await settled(service)).status, 'connected'); assert.equal(opens, 1);
});

test('a late takeover-open failure cannot overwrite an independently confirmed owner', async t => {
  let finishRead, failOpen, opens = 0;
  const { service } = fixture(t, () => new Promise(resolve => { finishRead = resolve; }), () => {
    opens++; return new Promise((_, reject) => { failOpen = reject; });
  });
  service.connect(id, { reading: true }); service.connect(id); await tick();
  assert.equal(opens, 1); finishRead(live());
  assert.equal((await settled(service)).status, 'connected');
  failOpen(new Error('late native open failure')); await tick();
  assert.equal(service.connection(id).status, 'connected'); assert.equal(opens, 1);
});

test('lifecycle cancellation before the takeover-open microtask prevents native open and late revival', async t => {
  let finishRead, opens = 0;
  const { service } = fixture(t, () => new Promise(resolve => { finishRead = resolve; }), async () => { opens++; });
  service.connect(id, { reading: true }); service.connect(id);
  service.lifecycleBlocked = () => true; service.suspendConnection(id);
  await tick(); assert.equal(opens, 0);
  const terminal = service.connection(id); assert.equal(terminal.status, 'failed'); assert.equal(terminal.code, 'lifecycle_pending');
  finishRead(live()); await tick(); assert.deepEqual(service.connection(id), terminal);
});

test('expired takeover reads and opens cannot revive the operation or produce another open', async t => {
  let finishRead, finishOpen, opens = 0;
  const { service } = fixture(t, () => new Promise(resolve => { finishRead = resolve; }), () => {
    opens++; return new Promise(resolve => { finishOpen = resolve; });
  });
  service.connectionTimeoutMs = 30;
  const passive = service.connect(id, { reading: true }); service.connect(id); await tick();
  assert.equal(opens, 1);
  const terminal = await settled(service); assert.equal(terminal.status, 'failed');
  assert.equal(terminal.requestId, passive.requestId);
  finishOpen(); finishRead(live()); await tick();
  assert.deepEqual(service.connection(id), terminal); assert.equal(opens, 1);
});

test('passive failure is quiet and a later explicit connection has a fresh attempt', async t => {
  let compatible = false, opens = 0;
  const { service } = fixture(t, async () => compatible ? live() : { ok: false, code: 'desktop_protocol_incompatible' }, async () => { opens++; });
  const first = service.connect(id, { reading: true });
  assert.equal((await settled(service)).status, 'skipped'); assert.equal(opens, 0);
  compatible = true; const second = service.connect(id);
  assert.notEqual(second.requestId, first.requestId); assert.equal((await settled(service)).status, 'connected'); assert.equal(opens, 1);
});

test('a passive lookup deadline stays skipped after its late result and does not consume explicit recovery', async t => {
  let finish, calls = 0, opens = 0;
  const { service } = fixture(t, async () => ++calls === 1 ? new Promise(resolve => { finish = resolve; }) : live(), async () => { opens++; });
  service.connectionTimeoutMs = 25;
  const first = service.connect(id, { reading: true });
  assert.equal((await settled(service)).status, 'skipped'); assert.equal(opens, 0);
  finish(live()); await tick(); assert.equal(service.connection(id).status, 'skipped');
  const explicit = service.connect(id); assert.notEqual(explicit.requestId, first.requestId);
  assert.equal((await settled(service)).status, 'connected'); assert.equal(opens, 1);
});

test('HTTP passive intent keeps navigation bookkeeping unchanged and old empty requests still open', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-reading-connect-http-'));
  let opens = 0;
  const app = makeApp({ dataDir: directory, codexHome: directory, readSource: source, readHistory: saved,
    desktopRequest: async () => live(), openThread: async () => { opens++; }, connectionTimeoutMs: 100, connectionPollMs: 5 });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await (await fetch(base + '/api/catalog', { headers: auth })).json();
  const headers = { ...auth, Origin: base, 'X-Navigator-Token': catalog.csrfToken };
  const post = (payload, extra = {}) => fetch(base + `/api/open/${id}`, { method: 'POST', headers: { ...headers,
    ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const settledHTTP = async () => {
    for (let i = 0; i < 30; i++) {
      const state = await (await fetch(base + `/api/tasks/${id}/connection`, { headers: auth })).json();
      if (state.status !== 'connecting') return state;
      await tick();
    }
    assert.fail('HTTP connection did not settle');
  };
  app.rename.active = () => ({ status: 'pending' });
  let response = await post({ intent: 'reading' }); assert.equal(response.status, 200);
  let data = await response.json(); assert.equal(data.status, 'skipped'); assert.equal(data.thread.lastOpenedAt, null); assert.equal(data.connection.status, 'idle'); assert.equal(opens, 0);
  app.rename.active = () => null;
  response = await post({ intent: 'reading' }); data = await response.json(); assert.equal(data.status, 'handoff_requested'); assert.equal(data.thread.lastOpenedAt, null);
  await settledHTTP(); assert.equal(opens, 0);
  response = await post(undefined); data = await response.json(); assert.equal(data.status, 'handoff_requested'); assert.equal(typeof data.thread.lastOpenedAt, 'number'); await settledHTTP(); assert.equal(opens, 1);
  for (const payload of [{ intent: 'other' }, { intent: 'reading', force: true }, null, []]) assert.equal((await post(payload)).status, 400);
  assert.equal((await post({ intent: 'reading' }, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await fetch(base + `/api/open/${id}`, { method: 'POST', headers: { Origin: base, 'X-Navigator-Token': catalog.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: 'reading' }) })).status, 401);
});

test('HTTP passive archived requests skip while explicit archived navigation retains its legacy behavior', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-reading-archive-http-')); let opens = 0;
  const app = makeApp({ dataDir: directory, codexHome: directory, readSource: () => source({ archived: true }), readHistory: saved,
    desktopRequest: async () => unavailable(), openThread: async () => { opens++; } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const { csrfToken } = await (await fetch(base + '/api/catalog', { headers: auth })).json();
  const headers = { ...auth, Origin: base, 'X-Navigator-Token': csrfToken, 'Content-Type': 'application/json' };
  let response = await fetch(base + `/api/open/${id}`, { method: 'POST', headers, body: JSON.stringify({ intent: 'reading' }) });
  let data = await response.json(); assert.equal(data.status, 'skipped'); assert.equal(data.thread.lastOpenedAt, null); assert.equal(opens, 0);
  response = await fetch(base + `/api/open/${id}`, { method: 'POST', headers, body: '{}' });
  data = await response.json(); assert.equal(data.readOnly, true); assert.equal(opens, 1);
});

test('HTTP polling receives the same request identity and a terminal skip when a blocker arrives', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-reading-skip-http-')); let finish, opens = 0;
  const app = makeApp({ dataDir: directory, codexHome: directory, readSource: source, readHistory: saved,
    desktopRequest: () => new Promise(resolve => { finish = resolve; }), openThread: async () => { opens++; }, connectionTimeoutMs: 150 });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const { csrfToken } = await (await fetch(base + '/api/catalog', { headers: auth })).json();
  const response = await fetch(base + `/api/open/${id}`, { method: 'POST', headers: {
    ...auth, Origin: base, 'X-Navigator-Token': csrfToken, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ intent: 'reading' }) });
  const initial = await response.json(); assert.equal(initial.connection.status, 'connecting');
  app.rename.active = () => ({ status: 'pending' }); finish(unavailable());
  const terminal = await (await fetch(base + `/api/tasks/${id}/connection`, { headers: auth })).json();
  assert.equal(terminal.status, 'skipped'); assert.equal(terminal.requestId, initial.connection.requestId);
  assert.equal(terminal.startedAt, initial.connection.startedAt); assert.equal(terminal.code, 'reading_blocked');
  assert.equal(opens, 0); assert.equal(app.store.annotation(id, app.store.thread(id)).lastOpenedAt, null);
});

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
const rid = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const source = () => ({ threads: [{ id, title: 'Connection fixture', archived: false }], projects: [], sourceInfo: {} });
const saved = () => ({ source: 'rollout', runtime: 'unavailable', canSend: false, messages: [], hint: 'Saved history' });
const live = (extra = {}) => ({ ok: true, source: 'desktop', resumeState: 'resumed', runtime: 'idle', canSend: true, queueReady: true, messages: [], ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function settled(service) {
  for (let n = 0; n < 100; n++) {
    const state = service.connection(id);
    if (state.status !== 'connecting') return state;
    await tick();
  }
  assert.fail('Connection did not finish within the fixture budget');
}
function fixture(t, request, openThread, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-connect-'));
  const store = new NavigatorStore(dir);
  store.sync(source());
  const service = new DesktopService(store, '/fixture', request, saved, {
    openThread, connectionTimeoutMs: 100, connectionPollMs: 5, ...options,
  });
  t.after(() => { service.stopQueue(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, store };
}

test('explicit connection discards a saved-history cache and confirms a freshly resumed owner', async t => {
  let opened = 0, resumed = false;
  const { service } = fixture(t, async () => resumed ? live() : { ok: false, code: 'desktop_unavailable' }, async () => { opened++; resumed = true; });
  assert.equal((await service.history(id)).source, 'rollout');
  assert.equal(typeof service.connect, 'function');
  assert.equal(service.connect(id).status, 'connecting');
  assert.equal(service.connect(id).status, 'connecting');
  assert.equal((await settled(service)).status, 'connected');
  assert.equal(opened, 1);
  assert.equal((await service.history(id)).source, 'desktop');
});

test('saving an explicit queue item can load its owner once while read-only polling never opens it', async t => {
  let opened = 0, resumed = false;
  const calls = [];
  const { service } = fixture(t, async payload => {
    calls.push(payload.operation);
    return payload.operation === 'history' ? resumed ? live() : { ok: false, code: 'desktop_unavailable' } : { ok: true };
  }, async () => { opened++; resumed = true; });
  await service.history(id);
  await service.processQueue();
  assert.equal(opened, 0);
  assert.equal((await service.send(id, { requestId: rid, text: 'Saved once', enqueue: true })).status, 'queued');
  for (let n = 0; n < 30 && !opened; n++) await tick();
  assert.equal(opened, 1);
  assert.equal((await settled(service)).status, 'connected');
  assert.equal(calls.filter(value => value === 'send').length, 0);
  await service.processQueue();
  assert.equal(service.getReceipt(id, rid).status, 'accepted');
  assert.equal(calls.filter(value => value === 'send').length, 1);
  await service.processQueue();
  assert.equal(opened, 1);
});

test('the compatible open endpoint returns a pollable connection rather than claiming it is ready', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-connect-http-'));
  const app = makeApp({ dataDir: dir, codexHome: dir, readSource: source, readHistory: saved,
    desktopRequest: async () => ({ ok: false, code: 'desktop_unavailable' }),
    openThread: async () => {}, connectionTimeoutMs: 50, connectionPollMs: 5 });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await (await fetch(base + '/api/catalog', { headers: auth })).json();
  const response = await fetch(base + `/api/open/${id}`, { method: 'POST', headers: { ...auth, Origin: base, 'X-Navigator-Token': catalog.csrfToken } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'handoff_requested');
  assert.equal(body.thread.id, id);
  assert.equal(body.connection?.status, 'connecting');
  const status = await fetch(base + `/api/tasks/${id}/connection`, { headers: auth });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).requestId, body.connection.requestId);
});

test('a known unsent direct submission is saved once and connects without replaying during recovery', async t => {
  let opened = 0, resumed = false, sends = 0;
  const { service } = fixture(t, async payload => {
    if (payload.operation === 'history') return resumed ? live() : { ok: false, code: 'desktop_unavailable' };
    sends++;
    return resumed ? { ok: true } : { ok: false, code: 'desktop_unavailable', sent: false };
  }, async () => { opened++; resumed = true; });
  assert.equal((await service.send(id, { requestId: rid, text: 'Deliver exactly once' })).status, 'queued');
  assert.equal((await settled(service)).status, 'connected');
  assert.equal(opened, 1); assert.equal(sends, 1);
  assert.equal((await service.send(id, { requestId: rid, text: 'Deliver exactly once' })).status, 'queued');
  assert.equal(sends, 1);
  await service.processQueue();
  assert.equal(sends, 2);
  assert.equal(service.getReceipt(id, rid).status, 'accepted');
});

test('an explicit queued send can reconnect only when the bridge confirms nothing was sent', async t => {
  let opened = 0, resumed = true, sends = 0;
  const { service } = fixture(t, async payload => {
    if (payload.operation === 'history') return resumed ? live({ runtime: 'active', queueReady: false }) : { ok: false, code: 'desktop_unavailable' };
    sends++; return { ok: false, code: 'desktop_preflight_timeout', sent: false };
  }, async () => { opened++; resumed = true; });
  await service.send(id, { requestId: rid, text: 'Waiting', enqueue: true });
  await settled(service);
  resumed = false;
  assert.equal((await service.dispatchQueued(id, rid, { expectedRevision: 0 })).status, 'queued');
  assert.equal((await settled(service)).status, 'connected');
  assert.equal(opened, 1); assert.equal(sends, 1);
});

test('a late unsent error cannot requeue a submission already confirmed in original history', async t => {
  let finish, opened = 0;
  const { service } = fixture(t, payload => payload.operation === 'send' ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve(live({ messages: [{ id: 'native-message', clientMessageId: rid, turnId: 'native-turn' }] })), async () => { opened++; });
  const sending = service.send(id, { requestId: rid, text: 'Already delivered' });
  await service.loadHistory(id);
  finish({ ok: false, sent: false, code: 'desktop_preflight_timeout' });
  assert.equal((await sending).status, 'accepted');
  assert.equal(service.outbox(id).length, 0);
  assert.equal(opened, 0);
});

test('initialization retries fresh snapshots and only a resumed owner counts as connected', async t => {
  let reads = 0, opened = 0;
  const { service } = fixture(t, async () => {
    reads++;
    if (reads === 1) return { ok: false, code: 'desktop_unavailable', connectionReason: 'owner_lookup_timeout' };
    if (reads === 2) return live({ resumeState: 'resuming', canSend: false });
    return live({ canSend: false, pendingRequests: [{ key: 'approval' }] });
  }, async () => { opened++; });
  service.connect(id);
  assert.equal((await settled(service)).status, 'connected');
  assert.equal(reads, 3); assert.equal(opened, 1);
  assert.equal((await service.history(id)).canSend, false);
});

test('a not-yet-discovered owner triggers one original-thread open after a read-first connection attempt', async t => {
  let opened = 0, reads = 0;
  const { service } = fixture(t, async () => {
    reads++;
    return opened ? live() : { ok: false, sent: false, code: 'desktop_unavailable', connectionReason: 'owner_unavailable' };
  }, async () => { opened++; });
  service.connect(id, { open: false });
  assert.equal((await settled(service)).status, 'connected');
  assert.equal(opened, 1); assert.equal(reads, 2);
});

test('quick resuming snapshots do not exhaust the attachment window before the owner can initialize', async t => {
  let openedAt, reads = 0;
  const { service } = fixture(t, async () => {
    reads++;
    return live({ resumeState: Date.now() - openedAt >= 50 ? 'resumed' : 'resuming' });
  }, async () => { openedAt = Date.now(); }, { connectionTimeoutMs: 120, connectionPollMs: 5 });
  service.connect(id);
  assert.equal((await settled(service)).status, 'connected');
  assert.ok(reads >= 3);
});

test('a late saved-history request cannot replace a successful connection cache', async t => {
  let finishOld, reads = 0;
  const { service } = fixture(t, () => ++reads === 1 ? new Promise(resolve => { finishOld = resolve; }) : Promise.resolve(live()), async () => {});
  const oldRead = service.history(id);
  service.connect(id);
  assert.equal((await settled(service)).status, 'connected');
  finishOld({ ok: false, code: 'desktop_unavailable' });
  await oldRead;
  assert.equal((await service.history(id)).source, 'desktop');
  assert.equal(reads, 2);
});

test('failed owner attachment retains its specific reason and ordinary polling never retries opening', async t => {
  let opened = 0;
  const { service } = fixture(t, async () => ({ ok: false, code: 'desktop_unavailable', connectionReason: 'owner_lookup_timeout' }), async () => { opened++; });
  service.connect(id);
  const result = await settled(service);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'owner_lookup_timeout');
  assert.equal((await service.history(id)).connectionReason, 'owner_lookup_timeout');
  await service.processQueue(); await service.history(id);
  assert.equal(opened, 1);
});

test('incompatible interfaces finish recovery after one read without trying to load another owner', async t => {
  for (const code of ['desktop_protocol_incompatible', 'unsupported_app_identity', 'app_version_changed']) {
    for (const open of [false, true]) {
      let reads = 0, opened = 0;
      const { service } = fixture(t, async () => {
        reads++;
        return { ok: false, sent: false, code, ...(code === 'desktop_protocol_incompatible' ? { connectionReason: 'desktop_protocol_error' } : {}) };
      }, async () => { opened++; });
      service.connect(id, { open });
      const result = await settled(service);
      assert.equal(result.status, 'failed');
      assert.equal(result.code, code);
      assert.equal(reads, 1);
      assert.equal(opened, Number(open));
      await tick();
      assert.equal(reads, 1);
    }
  }
});

test('queued text is retained when connection preflight is incompatible and later resumed history clears the failure', async t => {
  let compatible = false, opened = 0, sends = 0;
  const { service } = fixture(t, async payload => {
    if (payload.operation === 'send') { sends++; return { ok: true }; }
    return compatible ? live({ canCompact: true }) : { ok: false, sent: false, code: 'desktop_protocol_incompatible', connectionReason: 'desktop_protocol_error' };
  }, async () => { opened++; });
  assert.equal((await service.send(id, { requestId: rid, text: 'Keep until compatible', enqueue: true })).status, 'queued');
  assert.equal((await settled(service)).code, 'desktop_protocol_incompatible');
  const unavailable = await service.history(id);
  assert.equal(unavailable.canQueue, true);
  assert.equal(unavailable.canAttemptSend, false);
  assert.equal(unavailable.canAttemptCompact, false);
  await service.processQueue();
  assert.equal(opened, 0);
  assert.equal(sends, 0);
  assert.equal(service.outbox(id)[0].text, 'Keep until compatible');
  compatible = true; service.cache.clear();
  const recovered = await service.history(id);
  assert.equal(recovered.source, 'desktop');
  assert.equal(recovered.connection.status, 'connected');
  assert.equal(recovered.connection.code, undefined);
  assert.equal(recovered.readOnlyReason, undefined);
  assert.equal(recovered.canAttemptSend, true);
  assert.equal(recovered.canAttemptCompact, true);
  await service.processQueue();
  assert.equal(sends, 1);
  assert.equal(service.getReceipt(id, rid).status, 'accepted');
  assert.equal(opened, 0);
});

test('an unsent incompatible direct submission is rejected without entering connection recovery', async t => {
  let opened = 0, sends = 0;
  const { service } = fixture(t, async () => {
    sends++;
    return { ok: false, sent: false, code: 'desktop_protocol_incompatible', connectionReason: 'desktop_protocol_error' };
  }, async () => { opened++; });
  const input = { requestId: rid, text: 'Retain rejected input' };
  const receipt = await service.send(id, input);
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.code, 'desktop_protocol_incompatible');
  assert.equal((await service.send(id, input)).status, 'rejected');
  assert.equal(service.connection(id).status, 'idle');
  assert.equal(sends, 1);
  assert.equal(opened, 0);
});

test('connection deadline bounds a hung opener and late completion cannot report success', async t => {
  let finishOpen, reads = 0;
  const { service } = fixture(t, async () => { reads++; return live(); }, () => new Promise(resolve => { finishOpen = resolve; }), { connectionTimeoutMs: 25 });
  assert.equal(service.connect(id).status, 'connecting');
  const result = await settled(service);
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'connection_timeout');
  finishOpen(); await tick();
  assert.equal(service.connection(id).status, 'failed'); assert.equal(reads, 0);
});

test('an uncertain direct send remains unknown and never starts recovery or a second send', async t => {
  let opened = 0, sends = 0;
  const { service } = fixture(t, async payload => {
    if (payload.operation === 'history') return live();
    sends++; return { ok: false, sent: null, code: 'dispatch_unknown' };
  }, async () => { opened++; });
  assert.equal((await service.send(id, { requestId: rid, text: 'Uncertain' })).status, 'unknown');
  assert.equal((await service.send(id, { requestId: rid, text: 'Uncertain' })).status, 'unknown');
  await service.processQueue();
  assert.equal(opened, 0); assert.equal(sends, 1); assert.equal(service.connection(id).status, 'idle');
});

test('explicit queue additions preserve paused and unknown heads without loading or sending them', async t => {
  for (const blocked of ['paused', 'unknown']) {
    let opened = 0, sends = 0;
    const { service, store } = fixture(t, async payload => {
      if (payload.operation === 'history') return live();
      sends++; return { ok: true };
    }, async () => { opened++; });
    if (blocked === 'paused') store.db.prepare('INSERT INTO queue_pauses VALUES(?,?,?)').run(id, rid, Date.now());
    if (blocked === 'unknown') {
      store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,'unknown',?)").run(rid, id, 'fixture', Date.now());
      store.db.prepare('INSERT INTO outgoing_messages(id,thread_id,text) VALUES(?,?,?)').run(rid, id, 'Uncertain original');
    }
    const next = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
    assert.equal((await service.send(id, { requestId: next, text: 'Keep waiting', enqueue: true })).status, 'queued');
    await service.processQueue(); await tick();
    assert.equal(service.connection(id).status, 'idle'); assert.equal(opened, 0); assert.equal(sends, 0);
  }
});

test('HTTP open returns while desktop loading is still pending and exposes its eventual status', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-connect-pending-http-'));
  let finishOpen, opened = 0;
  const app = makeApp({ dataDir: dir, codexHome: dir, readSource: source, readHistory: saved,
    desktopRequest: async () => live(), connectionTimeoutMs: 500,
    openThread: () => { opened++; return new Promise(resolve => { finishOpen = resolve; }); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { finishOpen?.(); await new Promise(resolve => app.server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await (await fetch(base + '/api/catalog', { headers: auth })).json();
  const headers = { ...auth, Origin: base, 'X-Navigator-Token': catalog.csrfToken };
  const response = await fetch(base + `/api/open/${id}`, { method: 'POST', headers, signal: AbortSignal.timeout(200) });
  const first = await response.json();
  assert.equal(first.connection.status, 'connecting');
  const second = await (await fetch(base + `/api/open/${id}`, { method: 'POST', headers })).json();
  assert.equal(second.connection.requestId, first.connection.requestId); assert.equal(opened, 1);
  finishOpen();
  let status;
  for (let n = 0; n < 20; n++) {
    status = await (await fetch(base + `/api/tasks/${id}/connection`, { headers: auth })).json();
    if (status.status !== 'connecting') break;
    await tick();
  }
  assert.equal(status.status, 'connected');
  const history = await (await fetch(base + `/api/tasks/${id}/history`, { headers: auth })).json();
  assert.equal(history.source, 'desktop'); assert.equal(history.connection.status, 'connected');
});

test('the original open route still opens archived history without resuming or sending', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-open-archived-http-'));
  let opened = 0, desktopReads = 0;
  const app = makeApp({ dataDir: dir, codexHome: dir, readSource: () => ({ ...source(), threads: [{ ...source().threads[0], archived: true }] }),
    desktopRequest: async () => { desktopReads++; return live(); }, openThread: async target => { assert.equal(target, id); opened++; } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await (await fetch(base + '/api/catalog', { headers: auth })).json();
  const response = await fetch(base + `/api/open/${id}`, { method: 'POST', headers: { ...auth, Origin: base, 'X-Navigator-Token': catalog.csrfToken } });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, 'handoff_requested'); assert.equal(data.readOnly, true); assert.equal(data.thread.archived, true);
  assert.equal(opened, 1); assert.equal(desktopReads, 0);
});

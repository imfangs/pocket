import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';
import { makeApp } from '../server/index.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const other = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const rid = n => `bbbbbbbb-bbbb-7bbb-8bbb-${String(n).padStart(12, '0')}`;
const original = { model: 'gpt-6-astra', effort: 'high', provider: 'codex' };
const choices = [{ id: 'gpt-5.6-luna', name: 'Luna', supportedEfforts: ['low', 'medium'], defaultEffort: 'medium' }];
const input = (n = 1) => ({ requestId: rid(n), model: 'gpt-5.6-luna', effort: 'medium', expectedRevision: 'a'.repeat(64) });
const source = () => ({ threads: [id, other].map(id => ({ id, title: 'Fixture', archived: false })), projects: [], sourceInfo: {} });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-model-')), store = new NavigatorStore(dir);
  store.sync(source());
  const state = { current: { ...original }, revision: 'a'.repeat(64), calls: [], apply: true, result: { ok: true }, canChange: true };
  const snapshot = () => ({ ok: true, source: 'desktop', current: state.current, revision: state.revision,
    models: choices, catalogSource: 'configured', canChange: state.canChange, reason: null });
  const request = async p => {
    if (p.operation === 'model') return snapshot();
    if (p.operation === 'history') return { ok: true, source: 'desktop', modelState: snapshot(),
      runtime: 'idle', canSend: true, queueReady: true, messages: [] };
    state.calls.push(p);
    if (p.operation === 'set-model') {
      if (state.apply) { state.current = { model: p.model, effort: p.effort, provider: 'codex' }; state.revision = 'b'.repeat(64); }
      return state.result;
    }
    assert.equal(p.operation, 'send'); return { ok: true };
  };
  const service = new DesktopService(store, '/fixture', request);
  t.after(() => { service.stopQueue(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, state, request, service, snapshot };
}

test('the model ledger confirms native read-back and duplicate IDs never dispatch twice', async t => {
  const { service: s, state } = fixture(t);
  assert.deepEqual((await s.models.read(id)).current, original);
  const receipt = await s.models.set(id, input());
  assert.deepEqual({ ...receipt }, { requestId: rid(1), model: 'gpt-5.6-luna', effort: 'medium', provider: 'codex', status: 'confirmed', code: null });
  assert.deepEqual(await s.models.set(id, input()), receipt);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0], { operation: 'set-model', threadId: id, codexHome: '/fixture',
    model: 'gpt-5.6-luna', effort: 'medium', expectedRevision: 'a'.repeat(64) });
  await assert.rejects(s.models.set(other, input()), e => e.status === 409);
  await assert.rejects(s.models.set(id, { ...input(), effort: 'low' }), e => e.status === 409);
});
test('unknown model changes survive restart, block sends, and only native read-back releases them', async t => {
  const { service: s, state, store, request } = fixture(t);
  state.apply = false; state.result = { ok: false, sent: null, code: 'dispatch_unknown' };
  assert.equal((await s.models.set(id, input())).status, 'unknown');
  const restarted = new DesktopService(store, '/fixture', request);
  restarted.startQueue(); restarted.stopQueue();
  assert.equal((await restarted.models.set(id, input())).status, 'unknown');
  assert.equal((await restarted.models.checkReceipt(id, rid(1))).status, 'unknown');
  await assert.rejects(restarted.models.set(id, input(2)), e => e.status === 409);
  await assert.rejects(restarted.send(id, { requestId: rid(3), text: 'Wait' }), e => e.status === 409);
  await restarted.send(id, { requestId: rid(3), text: 'Wait', enqueue: true });
  await restarted.processQueue(); assert.equal(state.calls.length, 1);
  const forged = { source: 'rollout', modelState: { source: 'desktop', current: { ...original, model: 'gpt-5.6-luna', effort: 'medium' } }, messages: [] };
  restarted.request = async () => ({ ok: false }); restarted.readHistory = () => forged;
  await restarted.loadHistory(id); assert.equal(restarted.models.receipt(id, rid(1)).status, 'unknown');
  restarted.request = request;
  state.current = { ...original, model: 'gpt-5.6-luna', effort: 'medium' }; state.revision = 'b'.repeat(64);
  restarted.cache.clear(); await restarted.processQueue();
  assert.equal(restarted.models.receipt(id, rid(1)).status, 'confirmed');
  assert.deepEqual(state.calls.map(p => p.operation), ['set-model', 'send']);
});
test('settings are durably claimed before preflight and a late failure cannot undo a confirmed read', async t => {
  const { service: s, state, snapshot, request, store } = fixture(t);
  let finishRead, finishWrite, writes = 0;
  s.request = p => p.operation === 'model' && !finishRead ? new Promise(resolve => { finishRead = resolve; })
    : p.operation === 'set-model' ? new Promise(resolve => { writes++; finishWrite = resolve; }) : request(p);
  const changing = s.models.set(id, input());
  assert.equal(s.models.receipt(id, rid(1)).status, 'pending');
  await s.send(id, { requestId: rid(2), text: 'queued', enqueue: true });
  await s.processQueue(); assert.equal(state.calls.length, 0);
  finishRead(snapshot()); await new Promise(resolve => setImmediate(resolve));
  state.current = { ...original, model: 'gpt-5.6-luna', effort: 'medium' }; state.revision = 'b'.repeat(64);
  await s.loadHistory(id); assert.equal(s.models.receipt(id, rid(1)).status, 'confirmed');
  finishWrite({ ok: false, code: 'dispatch_unknown', sent: null });
  assert.equal((await changing).status, 'confirmed'); assert.equal(writes, 1);
  store.db.prepare("UPDATE model_changes SET status='pending'").run();
  s.models.recover(); assert.equal(s.models.receipt(id, rid(1)).status, 'unknown');
});
test('overrides, unsupported efforts, stale selections and busy tasks cannot change a model', async t => {
  const { service: s, state, store } = fixture(t);
  for (const extra of [{ provider: 'another' }, { cwd: '/override' }, { activeTurnId: other }, { permissions: 'full' }])
    await assert.rejects(s.models.set(id, { ...input(), ...extra }), e => e.status === 400);
  assert.equal((await s.models.set(id, { ...input(), effort: 'ultra' })).code, 'model_not_configured');
  assert.equal((await s.models.set(id, { ...input(2), expectedRevision: 'c'.repeat(64) })).code, 'model_state_changed');
  state.canChange = false;
  assert.equal((await s.models.set(id, input(3))).code, 'thread_not_ready');
  s.sending.add(id); await assert.rejects(s.models.set(id, input(4)), e => e.status === 409); s.sending.delete(id);
  store.sync({ ...source(), threads: [{ id, title: 'Archived', archived: true }] });
  await assert.rejects(s.models.set(id, input(4)), e => e.status === 409);
  assert.equal(state.calls.length, 0);
});
test('model HTTP routes require authentication and CSRF; slow changes return a durable receipt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-model-http-'));
  let finish, writes = 0, current = { ...original };
  const app = makeApp({ dataDir: dir, readSource: source, dispatchReplyWaitMs: 5,
    desktopRequest: async p => {
      if (p.operation === 'model') return { ok: true, source: 'desktop', current, revision: 'a'.repeat(64), models: choices, canChange: true };
      assert.equal(p.operation, 'set-model'); writes++;
      return new Promise(resolve => { finish = () => { current = { ...original, model: p.model, effort: p.effort }; resolve({ ok: true }); }; });
    } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { finish?.(); await new Promise(resolve => app.server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, path = `/api/tasks/${id}/model`;
  assert.equal((await fetch(base + path)).status, 401);
  const auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await fetch(base + '/api/catalog', { headers: auth }).then(r => r.json());
  const headers = { ...auth, Origin: base, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(input()) })).status, 403);
  headers['X-Navigator-Token'] = catalog.csrfToken;
  const post = () => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(input()) });
  const first = await post(); assert.equal(first.status, 202); assert.equal((await first.json()).status, 'pending');
  assert.equal((await post().then(r => r.json())).status, 'pending'); assert.equal(writes, 1);
  finish(); await new Promise(resolve => setImmediate(resolve));
  const receipt = await fetch(base + path + '/' + rid(1), { headers: auth }).then(r => r.json());
  assert.equal(receipt.status, 'confirmed'); assert.equal(writes, 1);
  const response = await fetch(base + path, { headers: auth });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const state = await response.json(); assert.equal(state.current.model, 'gpt-5.6-luna'); assert.equal(state.catalogSource, 'configured');
});
test('configured catalog files are bounded, provider-specific and reject invalid effort metadata', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-model-catalog-')), path = join(dir, 'catalog.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = fileURLToPath(new URL('../bin/', import.meta.url));
  const read = provider => JSON.parse(execFileSync('/opt/homebrew/bin/python3', ['-c',
    'import json,sys;sys.path.insert(0,sys.argv[1]);from model_settings import configured_models;print(json.dumps(configured_models(sys.argv[2],sys.argv[3])))',
    bin, provider, path], { encoding: 'utf8' }));
  const catalog = { schemaVersion: 1, modelProvider: 'codex', models: choices };
  writeFileSync(path, JSON.stringify(catalog)); assert.deepEqual(read('codex'), [choices, null]);
  assert.deepEqual(read('another'), [[], 'model_provider_not_configured']);
  writeFileSync(path, JSON.stringify({ ...catalog, models: [{ ...choices[0], defaultEffort: 'ultra' }] }));
  assert.deepEqual(read('codex'), [[], 'model_catalog_unavailable']);
  writeFileSync(path, JSON.stringify({ ...catalog, models: [choices[0], choices[0]] }));
  assert.deepEqual(read('codex'), [[], 'model_catalog_unavailable']);
  writeFileSync(path, ' '.repeat(65537)); assert.deepEqual(read('codex'), [[], 'model_catalog_unavailable']);
});

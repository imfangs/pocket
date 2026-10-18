import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NavigatorStore } from '../server/store.mjs';
import { ThreadModels } from '../server/thread-models.mjs';
import { makeApp } from '../server/index.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const requestId = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const second = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
const revision = 'a'.repeat(64);
const current = { model: 'gpt-6-astra', effort: 'ultra', provider: 'fixture' };
const state = overrides => ({ ok: true, threadId: id, source: 'desktop', current: { ...current }, revision,
  canChange: true, canChangeModel: false, models: [{ id: current.model, name: 'GPT-6 Astra',
    supportedEfforts: ['high', 'max', 'ultra'], defaultEffort: 'high' }], ...overrides });
const input = overrides => ({ requestId, model: current.model, effort: 'max', expectedRevision: revision, ...overrides });

function fixture(t, request, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-model-settings-'));
  const store = new NavigatorStore(directory);
  store.sync({ threads: [id, other].map(id => ({ id, title: 'Fixture', archived: false, ...overrides })), projects: [], sourceInfo: {} });
  const calls = [];
  const models = new ThreadModels(store, async payload => { calls.push(payload); return request(payload); });
  t.after(async () => { await Promise.allSettled([...models.running.values()]); models.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, models, calls };
}
async function settled(models, rid = requestId) { await models.running.get(rid); return models.get(id, rid); }

test('saved and archived settings stay readable without activating an owner or inventing defaults', async t => {
  const { models, calls } = fixture(t, () => { throw new Error('Must not read owner'); }, { archived: true, savedModelSettings: { model: current.model, effort: 'ultra' } });
  const result = await models.read(id);
  assert.equal(result.source, 'saved'); assert.deepEqual(result.current, { model: current.model, effort: 'ultra' });
  assert.equal(result.canChange, false); assert.equal(result.canChangeModel, false); assert.equal(calls.length, 0);
});
test('live settings whitelist fields and advertise only the exact current model', async t => {
  const resultState = state(); resultState.models.push({ ...resultState.models[0], id: 'another-model' });
  resultState.current.secret = 'private'; resultState.privateState = 'secret instructions';
  const { models } = fixture(t, () => resultState);
  const result = await models.read(id);
  assert.equal(result.source, 'desktop'); assert.equal(result.canChange, true);
  assert.deepEqual(result.current, { model: current.model, effort: 'ultra' });
  assert.equal(result.models.length, 1); assert.equal(result.models[0].id, current.model);
  assert.doesNotMatch(JSON.stringify(result), /private|provider|instructions/);
});
test('a wrong thread or invalid native catalog never grants permission to change settings', async t => {
  let value = state({ threadId: other });
  const { models } = fixture(t, () => value);
  assert.equal((await models.read(id)).canChange, false);
  value = state({ models: [{ id: current.model, name: 'GPT', supportedEfforts: ['invented'], defaultEffort: 'invented' }] });
  assert.equal((await models.read(id)).canChange, false);
  assert.throws(() => models.start('not-an-id', input()), /编号/);
});
test('effort changes reserve once, read back, and never switch the model or repeat the write', async t => {
  let value = state();
  const { models, calls } = fixture(t, payload => {
    if (payload.operation === 'set-model') value = state({ current: { ...current, effort: payload.effort }, revision: 'b'.repeat(64), verified: true });
    return value;
  });
  assert.equal(models.start(id, input()).status, 'pending');
  assert.equal(models.start(id, input()).requestId, requestId);
  assert.throws(() => models.start(id, input({ requestId: second })), /未完成/);
  assert.equal((await settled(models)).status, 'succeeded');
  assert.equal(models.start(id, input()).status, 'succeeded');
  assert.equal(calls.filter(call => call.operation === 'set-model').length, 1);
  assert.equal(calls.find(call => call.operation === 'set-model').model, current.model);
  assert.equal(calls.find(call => call.operation === 'set-model').requestId, requestId);
  assert.equal(models.pending(id), false);
  await assert.rejects(models.get(other, requestId), /暂未找到/);
  assert.throws(() => models.start(other, input()), /另一项设置/);
});
test('same-value saves are no-ops; stale revisions and model switches are rejected before native writes', async t => {
  const { models, calls } = fixture(t, () => state());
  models.start(id, input({ effort: 'ultra' }));
  assert.equal((await settled(models)).status, 'succeeded');
  models.start(id, input({ requestId: second, expectedRevision: 'c'.repeat(64) }));
  assert.equal((await settled(models, second)).status, 'changed');
  const third = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';
  models.start(id, input({ requestId: third, model: 'gpt-6-luna' }));
  assert.equal((await settled(models, third)).status, 'rejected');
  assert.equal(calls.some(call => call.operation === 'set-model'), false);
});
test('unknown writes remain pending until the intended setting is read on the exact provider', async t => {
  let value = state();
  const { models, calls } = fixture(t, payload => payload.operation === 'set-model' ? { ok: false, sent: null } : value);
  models.start(id, input());
  assert.equal((await settled(models)).status, 'unknown');
  assert.equal(models.pending(id), true);
  value = state({ current: { ...current, effort: 'max', provider: 'another' } });
  assert.equal((await models.get(id, requestId)).status, 'unknown');
  value = state({ current: { ...current, effort: 'max' } });
  assert.equal((await models.get(id, requestId)).status, 'succeeded');
  assert.equal(calls.filter(call => call.operation === 'set-model').length, 1);
});
test('lost replies with wrong identities cannot confirm a change', async t => {
  const { models } = fixture(t, payload => payload.operation === 'model' ? state()
    : state({ threadId: other, current: { ...current, effort: 'max' }, verified: true }));
  models.start(id, input());
  assert.equal((await settled(models)).status, 'unknown');
});
test('native compare failures stop the operation without a retry', async t => {
  const { models, calls } = fixture(t, payload => payload.operation === 'model' ? state()
    : { ok: false, sent: false, code: 'model_state_changed' });
  models.start(id, input());
  assert.equal((await settled(models)).status, 'changed');
  assert.equal(calls.filter(call => call.operation === 'set-model').length, 1);
});
test('reopened service keeps interrupted receipts and does not resurrect the withdrawn model experiment', async t => {
  const { store, models } = fixture(t, () => state());
  store.db.exec("CREATE TABLE model_changes(id TEXT, status TEXT); INSERT INTO model_changes VALUES('old','unknown')");
  store.db.prepare("INSERT INTO model_setting_operations VALUES(?,?,?,?,?,'pending',NULL,1,1)")
    .run(requestId, id, 'hash', JSON.stringify(input()), current.provider);
  const restartedCalls = [];
  const reopened = new ThreadModels(store, async payload => { restartedCalls.push(payload); return state(); });
  t.after(() => reopened.stop());
  assert.equal(reopened.pending(id), true);
  assert.equal((await reopened.get(id, requestId)).status, 'unknown');
  assert.equal(restartedCalls.some(call => call.operation !== 'model'), false);
  assert.equal(store.db.prepare('SELECT status FROM model_changes').get().status, 'unknown');
  assert.equal(models.pending(other), false);
});

test('restart after reservation but before dispatch releases the proved-unsent request', async t => {
  let release;
  const heldRead = new Promise(resolve => { release = resolve; });
  const { store, models, calls } = fixture(t, () => heldRead);
  models.start(id, input());
  await Promise.resolve();
  assert.equal(store.db.prepare('SELECT provider FROM model_setting_operations').get().provider, null);
  models.stop();
  const reopened = new ThreadModels(store, async () => state());
  t.after(() => reopened.stop());
  release(state());
  await models.running.get(requestId);
  const receipt = await reopened.get(id, requestId);
  assert.equal(receipt.status, 'rejected'); assert.equal(receipt.code, 'settings_not_submitted');
  assert.equal(reopened.pending(id), false);
  assert.equal(calls.some(call => call.operation === 'set-model'), false);
  assert.equal((await reopened.read(id)).canChange, true);
});

test('HTTP settings guard the original thread, archive, direct sends and queued dispatch until read-back', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-model-http-'));
  let value = state(), finishWrite, writing = false;
  const hold = new Promise(resolve => { finishWrite = resolve; }), calls = [];
  const app = makeApp({ dataDir: directory, codexHome: directory, openThread: async () => { throw new Error('No native opener'); },
    readSource: () => ({ threads: [id, other].map(id => ({ id, title: 'Fixture', archived: false, savedModelSettings: publicPair(value.current) })), projects: [], sourceInfo: {} }),
    desktopRequest: async payload => {
      calls.push(payload);
      if (payload.operation === 'model') return value;
      if (payload.operation === 'set-model') {
        assert.equal(payload.requestId, requestId); writing = true; await hold;
        value = state({ current: { ...current, effort: payload.effort }, verified: true, revision: 'b'.repeat(64) }); return value;
      }
      if (payload.operation === 'send') return { ok: true, turnId: 'turn-1' };
      // Exercise explicit dispatch here; background queue scheduling has its own
      // suite and must not race the manual-send assertion under CPU contention.
      return { ok: true, source: 'desktop', resumeState: 'resumed', runtime: 'idle', canSend: true, queueReady: false, messages: [], checkedAt: Date.now() };
    } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { finishWrite(); await new Promise(resolve => app.server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const catalog = await fetch(base + '/api/catalog', { headers: { Authorization: `Bearer ${app.auth.localToken}` } }).then(response => response.json());
  const request = async (path, method = 'GET', body) => {
    const result = await fetch(base + path, { method, headers: { Authorization: `Bearer ${app.auth.localToken}`, Origin: base, 'X-Navigator-Token': catalog.csrfToken, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, data: await result.json() };
  };
  const path = `/api/tasks/${id}/model-settings`;
  assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await request(path)).data.current.effort, 'ultra');
  assert.equal((await request(path, 'POST', input())).status, 202);
  for (let count = 0; !writing && count < 100; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(writing, true);
  assert.equal((await request(`/api/tasks/${id}/archive`, 'POST', { requestId: second, archived: true })).status, 409);
  assert.equal(app.lifecycle.blocked.has(id), false);
  assert.equal((await request(`/api/tasks/${id}/messages`, 'POST', { requestId: second, text: 'Not sent' })).status, 409);
  assert.equal((await request(`/api/tasks/${id}/messages`, 'POST', { requestId: second, text: 'Queue retains this', enqueue: true })).data.status, 'queued');
  assert.equal((await request(`/api/tasks/${id}/outbox/${second}/send`, 'POST', { expectedRevision: 0 })).status, 409);
  assert.equal(calls.some(call => call.operation === 'send'), false);
  finishWrite();
  let receipt;
  for (let count = 0; count < 100; count++) {
    receipt = (await request(`${path}/${requestId}`)).data;
    if (receipt.status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(receipt.status, 'succeeded');
  assert.equal((await request(`/api/tasks/${other}/model-settings/${requestId}`)).status, 404);
  assert.equal((await request(path)).data.current.effort, 'max');
  assert.equal((await request(`/api/tasks/${id}/outbox/${second}/send`, 'POST', { expectedRevision: 0 })).data.status, 'accepted');
  assert.equal(calls.filter(call => call.operation === 'set-model').length, 1);
  assert.equal(calls.filter(call => call.operation === 'send').length, 1);
});

function publicPair(current) { return { model: current.model, effort: current.effort }; }

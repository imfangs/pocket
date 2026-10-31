import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effortForModel, effortName, forgetModelRequest, mergeModelOperation, modelCanConnect, modelFailureStatus, modelName,
  modelOperationText, modelPresentation, modelSettingsLabel, modelSettingsRequest, modelSourceHint,
  modelUnresolved, readModelRequest, rememberModelRequest, sameModelRequest,
  modelSettingsSummary, modelSummaryPresentation, modelOperationSummary, chooseModelSummary,
} from '../src/threadModels.ts';

const source = {
  threadId: 'thread-one', source: 'desktop', current: { model: 'gpt-6-astra', effort: 'ultra' },
  revision: 'observed-revision', models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra', supportedEfforts: ['low', 'high', 'ultra'], defaultEffort: 'high' }],
  canChange: true, canChangeModel: false, checkedAt: 1,
};
const pending = { threadId: 'thread-one', requestId: 'request-one', model: 'gpt-6-astra', effort: 'high', status: 'pending' };
const memory = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};

test('cached model summaries contain only display data, never a revision, capability or receipt', () => {
  const summary = modelSettingsSummary({ ...source, operation: pending });
  assert.deepEqual(summary, { current: source.current, source: 'desktop', models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }] });
  assert.equal(modelSummaryPresentation(summary).label, 'GPT-6 Astra · Ultra');
  assert.equal(modelSummaryPresentation(summary).saved, false);
  assert.equal(modelSummaryPresentation({ ...summary, source: 'saved' }).saved, true);
  assert.equal(modelSettingsSummary({ ...source, current: null }), null);
  assert.equal(modelSettingsSummary({ ...source, current: { model: null, effort: null } }), null);
  const named = modelSettingsSummary({ ...source, models: [{ ...source.models[0], displayName: 'Desktop choice' }] });
  assert.equal(modelSummaryPresentation(named).label, 'Desktop choice · Ultra');
  source.current.model = 'changed-after-projection';
  assert.equal(summary.current.model, 'gpt-6-astra');
  source.current.model = 'gpt-6-astra';
});

test('only a confirmed model operation supplies a display snapshot when its follow-up read fails', () => {
  for (const status of ['pending', 'unknown', 'rejected', 'changed']) {
    assert.equal(modelOperationSummary({ ...pending, status }, source), null);
  }
  const confirmed = modelOperationSummary({ ...pending, status: 'succeeded', current: { model: 'gpt-6-astra', effort: 'low' } }, source);
  assert.deepEqual(confirmed, { current: { model: 'gpt-6-astra', effort: 'low' }, source: 'desktop',
    models: [{ id: 'gpt-6-astra', name: 'GPT-6 Astra' }] });
  const recovered = modelOperationSummary({ ...pending, status: 'succeeded' }, null);
  assert.equal(modelSummaryPresentation(recovered).label, 'GPT-6 Astra · High');
});

test('a saved or unavailable fallback cannot replace or renew an observed desktop summary', () => {
  const confirmed = modelOperationSummary({ ...pending, status: 'succeeded' }, source);
  for (const fallback of [
    { ...source, source: 'saved', current: source.current, revision: null, canChange: false },
    { ...source, source: 'unavailable', current: null, revision: null, canChange: false },
  ]) {
    const choice = chooseModelSummary(fallback, confirmed);
    assert.equal(choice.summary, confirmed);
    assert.equal(choice.refreshCache, false);
    assert.equal(modelSummaryPresentation(choice.summary).label, 'GPT-6 Astra · High');
    // Only display selection changes: permissions still belong to this read.
    assert.equal(modelSettingsRequest(fallback, 'gpt-6-astra', 'high', 'blocked'), null);
  }
});

test('a real desktop read wins and a changed saved fingerprint admits new persistent information', () => {
  const confirmed = modelOperationSummary({ ...pending, status: 'succeeded' }, source);
  const desktop = chooseModelSummary(source, confirmed);
  assert.equal(desktop.refreshCache, true);
  assert.equal(modelSummaryPresentation(desktop.summary).label, 'GPT-6 Astra · Ultra');
  // The component drops previous when the catalog fingerprint changes.
  const saved = chooseModelSummary({ ...source, source: 'saved' }, null);
  assert.equal(saved.refreshCache, true);
  assert.equal(saved.summary.source, 'saved');
  assert.equal(modelSummaryPresentation(saved.summary).saved, true);
  const unavailable = chooseModelSummary({ ...source, source: 'unavailable', current: null }, null);
  assert.deepEqual(unavailable, { summary: null, refreshCache: true });
});

test('model labels use the current catalog and retain unfamiliar model identities', () => {
  assert.equal(modelSettingsLabel(source.current, source.models), 'GPT-6 Astra · Ultra');
  assert.equal(modelSettingsLabel(source.current), 'GPT-6 Astra · Ultra');
  assert.equal(modelName('vendor/custom-model:2026.10'), 'vendor/custom-model:2026.10');
  assert.equal(modelName('provider-id', [{ id: 'provider-id', name: 'API name', displayName: 'Desktop name' }]), 'Desktop name');
  assert.equal(modelName('gpt-6-astra', [{ id: 'gpt-6-astra', name: 'GPT-6-Astra' }]), 'GPT-6 Astra');
  assert.equal(modelName('custom-id', [{ id: 'custom-id', name: 'My-GPT-6-Astra' }]), 'My-GPT-6-Astra');
  assert.equal(effortName('low'), 'Light');
  assert.equal(effortName('xhigh'), 'Extra High');
  assert.equal(effortName('future-effort'), 'future-effort');
  assert.equal(modelSettingsLabel({ model: null, effort: 'ultra' }), '模型未提供 · Ultra');
  assert.equal(modelSettingsLabel(null), '暂未读取');
  assert.equal(modelSettingsLabel({ model: null, effort: null }), '暂未读取');
  assert.equal(modelSettingsLabel({ model: 'gpt-6-astra', effort: null }), 'GPT-6 Astra');
  assert.equal(modelPresentation(null, { model: null, effort: null }).saved, false);
});

test('saved values remain identified as saved and cannot authorize a write', () => {
  const saved = { ...source, source: 'saved', revision: null, canChange: false };
  assert.deepEqual(modelPresentation(null, source.current), { value: source.current, label: 'GPT-6 Astra · Ultra', saved: true });
  assert.equal(modelPresentation(saved).saved, true);
  assert.equal(modelPresentation(source, { model: 'old-model', effort: 'low' }).saved, false);
  assert.deepEqual(modelPresentation({ ...source, source: 'unavailable', current: null }, source.current).value, source.current);
  assert.equal(modelSettingsRequest(saved, 'gpt-6-astra', 'high', 'next'), null);
  assert.equal(modelSettingsRequest({ ...saved, canChange: true, revision: 'stale' }, 'gpt-6-astra', 'high', 'next'), null);
});

test('effort updates carry the observed revision without changing the model', () => {
  assert.deepEqual(modelSettingsRequest(source, 'gpt-6-astra', 'high', 'next'), {
    requestId: 'next', model: 'gpt-6-astra', effort: 'high', expectedRevision: 'observed-revision',
  });
  assert.equal(modelSettingsRequest(source, 'gpt-6-astra', 'ultra', 'unchanged'), null);
  assert.equal(modelSettingsRequest(source, 'gpt-6-astra', 'unsupported', 'bad'), null);
  const other = { id: 'another-model', name: 'Another', supportedEfforts: ['high'], defaultEffort: 'high' };
  assert.equal(modelSettingsRequest({ ...source, models: [...source.models, other] }, 'another-model', 'high', 'bad'), null);
  assert.equal(modelSettingsRequest({ ...source, revision: null }, 'gpt-6-astra', 'high', 'bad'), null);
  assert.equal(modelSettingsRequest({ ...source, canChange: false }, 'gpt-6-astra', 'high', 'bad'), null);
});

test('dynamic catalogs determine valid effort and preserve it only when supported', () => {
  const option = { id: 'example', name: 'Example', supportedEfforts: ['medium', 'max'], defaultEffort: 'max' };
  assert.equal(effortForModel(option, 'medium'), 'medium');
  assert.equal(effortForModel(option, 'ultra'), 'max');
  assert.equal(effortForModel({ ...option, defaultEffort: 'invalid' }, 'ultra'), 'medium');
  assert.equal(effortForModel({ ...option, supportedEfforts: [] }, 'ultra'), '');
  assert.equal(effortForModel(undefined, 'ultra'), '');
});

test('receipt ownership rejects a different thread or request, including late responses', () => {
  assert.equal(sameModelRequest(pending, { ...pending, requestId: 'other' }), false);
  assert.equal(sameModelRequest(pending, { ...pending, threadId: 'other' }), false);
  assert.equal(mergeModelOperation(pending, { ...pending, threadId: 'other', status: 'succeeded' }), pending);
  assert.equal(mergeModelOperation(pending, { ...pending, requestId: 'other', status: 'succeeded' }), pending);
  const terminal = { ...pending, status: 'succeeded' };
  assert.equal(mergeModelOperation(terminal, pending), terminal);
  assert.equal(mergeModelOperation(terminal, { ...pending, status: 'unknown' }), terminal);
});

test('unknown outcomes keep their identity until a terminal readback', () => {
  const unknown = mergeModelOperation(pending, { ...pending, status: 'unknown' });
  assert.equal(modelUnresolved(unknown), true);
  assert.equal(modelUnresolved(pending), true);
  for (const status of ['succeeded', 'rejected', 'changed']) {
    const confirmed = mergeModelOperation(unknown, { ...pending, status });
    assert.equal(modelUnresolved(confirmed), false);
    assert.equal(confirmed.requestId, pending.requestId);
  }
  assert.match(modelOperationText(unknown), /尚未确认.*核对/);
  assert.match(modelOperationText({ ...pending, status: 'changed' }), /已在其他地方变化.*重新读取/);
});

test('POST pre-reservation rejections and the explicit not-forwarded relay result allow a new submission', () => {
  assert.equal(modelFailureStatus({ status: 503, code: 'relay_not_forwarded' }), 'rejected');
  for (const status of [400, 401, 403, 404, 409]) assert.equal(modelFailureStatus({ status }), 'rejected');
  for (const failure of [new Error('timeout'), { status: 503 }, { status: 502, code: 'relay_not_forwarded' }, { status: 503, code: 'upstream_timeout' }, null]) {
    assert.equal(modelFailureStatus(failure), 'unknown');
  }
});

test('recovery stores only thread and request identity and a stale receipt cannot remove a newer request', () => {
  const storage = memory();
  assert.equal(rememberModelRequest({ ...pending, privateText: 'never persist' }, storage), true);
  assert.deepEqual(readModelRequest(pending.threadId, storage), { threadId: pending.threadId, requestId: pending.requestId });
  assert.deepEqual(JSON.parse([...storage.values.values()][0]), { threadId: pending.threadId, requestId: pending.requestId });
  const newer = { ...pending, requestId: 'request-two' };
  rememberModelRequest(newer, storage);
  forgetModelRequest(pending, storage);
  assert.equal(readModelRequest(pending.threadId, storage).requestId, 'request-two');
  forgetModelRequest(newer, storage);
  assert.equal(readModelRequest(pending.threadId, storage), null);
});

test('corrupt or mismatched recovery records never select a different conversation', () => {
  const storage = memory();
  rememberModelRequest(pending, storage);
  const key = [...storage.values.keys()][0];
  for (const corrupt of ['{', 'null', JSON.stringify({ threadId: 'other', requestId: pending.requestId }), JSON.stringify({ threadId: pending.threadId, requestId: '../other' })]) {
    storage.setItem(key, corrupt);
    assert.equal(readModelRequest(pending.threadId, storage), null);
  }
  assert.equal(rememberModelRequest({ threadId: '../other', requestId: 'request' }, storage), false);
  assert.equal(rememberModelRequest(pending, { setItem() { throw new Error('blocked'); } }), false);
});

test('model settings recovery is scoped to the selected Mac', () => {
  const storage = memory();
  rememberModelRequest(pending, storage);
  const originalWindow = globalThis.window;
  try {
    globalThis.window = { location: { search: '?machine=wandou' }, localStorage: { getItem() { return null; } } };
    assert.equal(readModelRequest(pending.threadId, storage), null);
    const remote = { ...pending, requestId: 'remote-request' };
    rememberModelRequest(remote, storage);
    assert.equal(readModelRequest(pending.threadId, storage).requestId, remote.requestId);
    assert.equal(storage.values.size, 2);
    assert.ok([...storage.values.keys()].some(key => key.startsWith('pocket.machine.wandou.')));
  } finally {
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  }
  assert.equal(readModelRequest(pending.threadId, storage).requestId, pending.requestId);
});

test('readonly and unavailable states give a short actionable explanation', () => {
  assert.match(modelSourceHint({ ...source, reason: 'thread_archived' }), /取消归档/);
  assert.match(modelSourceHint({ ...source, source: 'saved', canChange: false, reason: 'owner_unavailable' }), /连接后可修改/);
  assert.match(modelSourceHint({ ...source, reason: 'lifecycle_pending' }), /管理操作/);
  assert.match(modelSourceHint({ ...source, reason: 'model_catalog_unavailable' }), /可用模型/);
  assert.doesNotMatch(modelSourceHint({ ...source, reason: 'opaque_internal_code' }), /opaque_internal_code/);
});

test('edit intent connects only when the desktop owner is unavailable', () => {
  const unavailable = { ...source, source: 'saved', canChange: false, revision: null };
  for (const reason of ['owner_unavailable', 'desktop_unavailable', 'not_connected']) assert.equal(modelCanConnect({ ...unavailable, reason }), true);
  for (const reason of ['operation_in_progress', 'thread_not_ready', 'model_catalog_unavailable', 'model_state_changed', 'desktop_protocol_error', 'needs_input', '', undefined]) {
    assert.equal(modelCanConnect({ ...unavailable, reason }), false);
    assert.doesNotMatch(modelSourceHint({ ...unavailable, reason }), /连接后可修改/);
  }
  assert.equal(modelCanConnect({ ...source, canChange: false, reason: 'owner_unavailable' }), false);
  assert.equal(modelCanConnect(null), false);
});

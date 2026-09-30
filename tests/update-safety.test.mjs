import test from 'node:test';
import assert from 'node:assert/strict';
import { createReloadSafety, getReloadBlocker, holdReload, isReloadBlockingRequest } from '../src/updateSafety.ts';
import { api } from '../src/api.ts';
const response = (data = {}, status = 200) => new Response(JSON.stringify(data), { status });

test('reload checks read current draft state rather than the registration snapshot', () => {
  const safety = createReloadSafety(), drafts = new Map();
  const remove = safety.register(() => [...drafts.values()].some(d => d.text || d.requestId || d.revision != null) ? 'Unfinished draft' : null);
  assert.equal(safety.getBlocker(), null);
  drafts.set('another task', { text: 'Unsent input' });
  assert.equal(safety.getBlocker(), 'Unfinished draft');
  drafts.clear(); drafts.set('question', { text: '' });
  assert.equal(safety.getBlocker(), null);
  drafts.set('outbox', { text: '', revision: 0 });
  assert.equal(safety.getBlocker(), 'Unfinished draft');
  drafts.clear(); drafts.set('receipt', { text: '', requestId: 'pending' });
  assert.equal(safety.getBlocker(), 'Unfinished draft');
  remove();
  assert.equal(safety.getBlocker(), null);
});

test('operation holds survive component removal and release independently exactly once', () => {
  const safety = createReloadSafety();
  const remove = safety.register(() => 'Draft');
  const first = safety.hold('Saving'), second = safety.hold('Sending');
  remove();
  assert.equal(safety.getBlocker(), 'Saving');
  first(); first();
  assert.equal(safety.getBlocker(), 'Sending');
  second();
  assert.equal(safety.getBlocker(), null);
});

test('each guard registration has its own lifetime and a failed guard cannot authorize reload', () => {
  const safety = createReloadSafety(), shared = () => 'Input';
  const first = safety.register(shared), second = safety.register(shared);
  first(); assert.equal(safety.getBlocker(), 'Input');
  second(); assert.equal(safety.getBlocker(), null);
  const remove = safety.register(() => { throw new Error('Unavailable state'); });
  assert.equal(safety.getBlocker(), '操作尚未完成，请稍后更新。');
  remove(); assert.equal(safety.getBlocker(), null);
});

test('catalog polling and source sync do not block update, while mutations do', () => {
  for (const verb of ['GET', 'get', 'HEAD', 'OPTIONS']) assert.equal(isReloadBlockingRequest('/api/tasks/id/history', verb), false);
  assert.equal(isReloadBlockingRequest('/api/sync', 'POST'), false);
  assert.equal(isReloadBlockingRequest('/api/sync?manual=1', 'post'), false);
  for (const verb of ['POST', 'PATCH', 'DELETE']) assert.equal(isReloadBlockingRequest('/api/tasks/id', verb), true);
  assert.equal(isReloadBlockingRequest('/api/sync-other', 'POST'), true);
});

test('an API mutation holds until its response is consumed; reads remain unblocked', async () => {
  const original = globalThis.fetch;
  try {
    for (const [path, method, blocking] of [['/api/catalog', 'GET', false], ['/api/sync', 'POST', false], ['/api/tasks/id', 'PATCH', true]]) {
      let complete;
      globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { complete = resolve; }) });
      const pending = api(path, method);
      await Promise.resolve();
      assert.equal(Boolean(getReloadBlocker()), blocking);
      complete({ saved: true });
      assert.deepEqual(await pending, { saved: true });
      assert.equal(getReloadBlocker(), null);
    }
  } finally { globalThis.fetch = original; }
});

test('CSRF refresh keeps the original mutation hold until its existing retry settles', async () => {
  const original = globalThis.fetch;
  const requests = [];
  let finish;
  try {
    globalThis.fetch = async (path, options) => {
      requests.push([path, options.method || 'GET']);
      assert.ok(getReloadBlocker());
      if (requests.length === 1) return response({ error: '请求已过期，请刷新页面' }, 403);
      if (requests.length === 2) return response({ csrfToken: 'test-token' });
      return new Promise(resolve => { finish = resolve; });
    };
    const pending = api('/api/tasks/id', 'PATCH', { note: 'Synthetic note' });
    for (let tick = 0; !finish && tick < 30; tick++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(finish, 'the existing CSRF retry reached the pending response');
    assert.ok(getReloadBlocker());
    finish(response({ saved: true }));
    await pending;
    assert.equal(getReloadBlocker(), null);
    assert.deepEqual(requests, [['/api/tasks/id', 'PATCH'], ['/api/catalog', 'GET'], ['/api/tasks/id', 'PATCH']]);
  } finally { globalThis.fetch = original; }
});

test('failed API calls release only their own hold and never replay an unknown mutation', async () => {
  const original = globalThis.fetch;
  const releaseOther = holdReload('Another operation');
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new Error('Network unavailable'); };
    await assert.rejects(api('/api/tasks/id/messages', 'POST', { requestId: 'synthetic' }), /Network unavailable/);
    assert.equal(calls, 1);
    assert.equal(getReloadBlocker(), 'Another operation');
    releaseOther();
    assert.equal(getReloadBlocker(), null);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid response'); } });
    await assert.rejects(api('/api/tasks/id', 'PATCH'), /Invalid response/);
    assert.equal(getReloadBlocker(), null);
    globalThis.fetch = async () => response({ error: 'Conflict' }, 409);
    await assert.rejects(api('/api/tasks/id', 'PATCH'), { status: 409 });
    assert.equal(getReloadBlocker(), null);
  } finally { releaseOther(); globalThis.fetch = original; }
});

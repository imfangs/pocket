import test from 'node:test';
import assert from 'node:assert/strict';
import { api, setToken } from '../src/api.ts';
import { getReloadBlocker } from '../src/updateSafety.ts';

test('attachment PUT sends the raw File with its MIME, CSRF and a reload hold, rather than JSON encoding it', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const file = new File(['image bytes'], 'picture.png', { type: 'image/png' });
  let finish, request;
  globalThis.fetch = async (path, options) => { request = { path, options }; return new Promise(resolve => { finish = () => resolve(new Response('{"id":"uploaded"}', { headers: { 'Content-Type': 'application/json' } })); }); };
  setToken('fixture-token');
  const sending = api('/api/tasks/thread/attachments/upload?name=picture.png', 'PUT', file, { raw: true, contentType: file.type });
  assert.equal(request.options.body, file);
  assert.equal(request.options.headers['Content-Type'], 'image/png');
  assert.equal(request.options.headers['X-Navigator-Token'], 'fixture-token');
  assert.equal(request.options.cache, 'no-store'); assert.ok(getReloadBlocker());
  finish(); assert.deepEqual(await sending, { id: 'uploaded' }); assert.equal(getReloadBlocker(), null);
});

test('raw PUT refreshes an explicitly rejected CSRF token with the same File, but a lost response never replays', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const file = new File(['text'], 'notes.txt', { type: 'text/plain' }), calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    if (calls.length === 1) return new Response(JSON.stringify({ error: '请求已过期，请刷新页面' }), { status: 403 });
    if (path === '/api/catalog') return new Response(JSON.stringify({ csrfToken: 'fresh-token' }));
    return new Response(JSON.stringify({ ok: true }));
  };
  await api('/api/tasks/thread/attachments/upload', 'PUT', file, { raw: true, contentType: file.type });
  assert.equal(calls.length, 3); assert.equal(calls[0].options.body, file); assert.equal(calls[2].options.body, file);
  assert.equal(calls[2].options.headers['X-Navigator-Token'], 'fresh-token');
  let retries = 0; globalThis.fetch = async () => { retries++; throw new Error('connection lost'); };
  await assert.rejects(api('/api/tasks/thread/attachments/upload', 'PUT', file, { raw: true, contentType: file.type }), /connection lost/);
  assert.equal(retries, 1); assert.equal(getReloadBlocker(), null);
});

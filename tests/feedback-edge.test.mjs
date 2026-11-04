import test from 'node:test';
import assert from 'node:assert/strict';
import { worker } from './helpers/worker-profile.mjs';

const origin = 'https://pocket.example.com';
const signatures = { 'webhook-id': 'fixture', 'webhook-timestamp': '123', 'webhook-signature': 'v1,fixture' };
function fixture(t) {
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options, body: await new Response(options.body).text() });
    return Response.json({ accepted: false }, { headers: { 'X-Pocket-Machine': new URL(url).hostname.startsWith('wandou.') ? 'wandou' : 'ged' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return { calls, env: { NAVIGATOR_MACHINE_KEYS: JSON.stringify({ wandou: 'a'.repeat(64) }),
    NAVIGATOR_CONNECTION: { get: async key => ({ connected: true, machineId: key === 'origin' ? 'ged' : 'wandou',
      publicOrigin: `https://${key === 'origin' ? 'ged' : 'wandou'}.trycloudflare.com` }) } } };
}

test('only signed feedback machine routes bypass browser Origin and never forward browser credentials', async t => {
  const f = fixture(t);
  for (const prefix of ['/api', '/api/machines/wandou']) {
    for (const suffix of ['webhook', 'relay/wandou', 'relay-status/wandou']) {
      const response = await worker.fetch(new Request(`${origin}${prefix}/feedback/${suffix}`, { method: 'POST',
        headers: { ...signatures, 'Content-Type': 'application/json', Authorization: 'Bearer private',
          Cookie: 'navigator_session=ged; navigator_session_wandou=wandou', 'X-Navigator-Token': 'csrf' }, body: '{"fixture":true}' }), f.env);
      assert.equal(response.status, 200);
      const forwarded = f.calls.at(-1);
      assert.equal(forwarded.body, '{"fixture":true}');
      assert(forwarded.url.endsWith(`/api/feedback/${suffix}`));
      for (const [key, value] of Object.entries(signatures)) assert.equal(forwarded.options.headers.get(key), value);
      for (const key of ['Origin', 'Cookie', 'Authorization', 'X-Navigator-Token']) assert.equal(forwarded.options.headers.get(key), null);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  }
});

test('signed route exceptions cannot be reused for browser requests, unsigned callbacks or ordinary writes', async t => {
  const f = fixture(t);
  for (const headers of [{}, { ...signatures, 'webhook-signature': '' }, { ...signatures, Origin: origin },
    { ...signatures, Origin: 'https://other.example' }, { ...signatures, 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await worker.fetch(new Request(origin + '/api/feedback/webhook', { method: 'POST', headers }), f.env);
    assert([401, 403].includes(response.status));
  }
  for (const path of ['/api/feedback', '/api/feedback/webhook/extra', '/api/feedback/relay/wandou/extra',
    '/api/feedback/relay-status/WANDOU', '/api/tasks', '/api/auth/login']) {
    const response = await worker.fetch(new Request(origin + path, { method: 'POST', headers: signatures }), f.env);
    assert.equal(response.status, 403, path);
  }
  assert.equal(f.calls.length, 0);
  const response = await worker.fetch(new Request(origin + '/api/feedback', { method: 'POST',
    headers: { ...signatures, Origin: origin, Cookie: 'navigator_session=fixture', 'X-Navigator-Token': 'csrf' }, body: '{}' }), f.env);
  assert.equal(response.status, 200);
  const forwarded = f.calls.at(-1).options.headers;
  assert.equal(forwarded.get('Cookie'), 'navigator_session=fixture');
  assert.equal(forwarded.get('X-Navigator-Token'), 'csrf');
  for (const key of Object.keys(signatures)) assert.equal(forwarded.get(key), null);
});

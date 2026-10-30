import test from "node:test";
import assert from "node:assert/strict";
import worker from "../edge/worker.mjs";
import { readResponseKind } from '../shared/read-response.mjs';
const env = {
  NAVIGATOR_CONNECTION: {
    get: async () => ({
      connected: true,
      publicOrigin: "https://sample.trycloudflare.com",
    }),
  },
};
test("client versions cross the gateway as optional bounded diagnostics, never as an access gate", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(options.headers);
    return new Response('{}', { headers: { 'X-Pocket-Machine': 'ged' } });
  };
  try {
    for (const version of ['a'.repeat(64), '1.2.3+build.4', undefined, 'bad/version', 'a'.repeat(161)]) {
      const response = await worker.fetch(new Request('https://x.fangs.cc/api/catalog', {
        headers: version === undefined ? {} : { 'X-Pocket-Client-Version': version },
      }), env);
      assert.equal(response.status, 200);
      assert.equal(seen.at(-1).get('X-Pocket-Client-Version'), version && /^[a-z0-9][a-z0-9._+-]{0,159}$/i.test(version) ? version : null);
    }
  } finally { globalThis.fetch = original; }
});
test("stable gateway forwards only approved API headers and never exposes local CLI credentials", async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return new Response(JSON.stringify({ authenticated: true }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie":
          "navigator_session=test; HttpOnly; Secure; SameSite=Strict; Path=/",
      },
    });
  };
  try {
    const r = await worker.fetch(
      new Request("https://x.fangs.cc/api/auth/login", {
        method: "POST",
        headers: {
          Origin: "https://x.fangs.cc",
          "Content-Type": "application/json",
          Authorization: "Bearer never-forward",
          Cookie: "navigator_session=old",
        },
        body: '{"passphrase":"synthetic"}',
      }),
      env,
    );
    assert.equal(r.status, 200);
    assert.equal(seen.url, "https://sample.trycloudflare.com/api/auth/login");
    assert.equal(
      seen.options.headers.get("Origin"),
      "https://sample.trycloudflare.com",
    );
    assert.equal(seen.options.headers.get("Authorization"), null);
    assert.match(r.headers.get("set-cookie"), /HttpOnly/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(seen.options.redirect, "manual");
  } finally {
    globalThis.fetch = original;
  }
});
test("gateway rejects cross-site requests and arbitrary upstream targets before forwarding", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must not fetch");
  };
  try {
    let r = await worker.fetch(
      new Request("https://x.fangs.cc/api/catalog", {
        headers: { Origin: "https://evil.example" },
      }),
      env,
    );
    assert.equal(r.status, 403);
    r = await worker.fetch(new Request("https://x.fangs.cc/api/catalog"), {
      NAVIGATOR_CONNECTION: {
        get: async () => ({
          connected: true,
          publicOrigin: "http://127.0.0.1:1234",
        }),
      },
    });
    assert.equal(r.status, 503);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("attachment uploads retain their stream and get time for mobile transfer and local image conversion", async () => {
  const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
  const budgets = [], calls = [];
  AbortSignal.timeout = milliseconds => { budgets.push(milliseconds); return new AbortController().signal; };
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method, bytes: options.body ? await new Response(options.body).text() : null });
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
  const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    const attachment=`/api/tasks/${id}/attachments/${id}`;
    const put=await worker.fetch(new Request('https://x.fangs.cc'+attachment+'?name=photo.heic', {
      method:'PUT',headers:{Origin:'https://x.fangs.cc','Content-Type':'image/heic'},body:'synthetic original bytes'
    }),env);
    assert.equal(put.status,200);
    assert.equal(calls[0].bytes,'synthetic original bytes');
    assert.ok(calls[0].url.endsWith(attachment+'?name=photo.heic'));
    assert.equal(budgets[0],180000);
    for (const [method,path] of [['GET',attachment+'?metadata=1'],['POST',`/api/tasks/${id}/messages`],['PUT','/api/unsupported']])
      await worker.fetch(new Request('https://x.fangs.cc'+path,{method,headers:{Origin:'https://x.fangs.cc'}}),env);
    assert.deepEqual(budgets.slice(1),[20000,20000,20000]);
  } finally { globalThis.fetch=originalFetch; AbortSignal.timeout=originalTimeout; }
});

test("gateway distinguishes requests it never forwarded from ambiguous upstream failures", async () => {
  const original = globalThis.fetch;
  const request = () => new Request("https://x.fangs.cc/api/tasks", {
    method: "POST", headers: { Origin: "https://x.fangs.cc", "Content-Type": "application/json" }, body: '{}',
  });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("upstream failed", { status: 503 }); };
  try {
    for (const get of [async () => null, async () => ({ connected: true, publicOrigin: "http://127.0.0.1" }),
      async () => ({ connected: true, publicOrigin: "invalid" }), async () => { throw new Error("KV unavailable"); }]) {
      const response = await worker.fetch(request(), { NAVIGATOR_CONNECTION: { get } });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "relay_not_forwarded");
    }
    assert.equal(calls, 0, "a definite failure must have zero upstream attempts");
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "relay_unavailable");
    globalThis.fetch = async () => { calls++; throw new Error("lost reply after possible execution"); };
    const lost = await worker.fetch(request(), env);
    assert.equal((await lost.json()).code, "relay_unavailable");
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('conditional read headers and bodyless responses survive the public gateway on the four allowed routes', async () => {
  const original = globalThis.fetch, calls = [], id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  const etag = `W/"pocket-read-v1-${'a'.repeat(64)}"`;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(null, { status: options.method === 'POST' ? 204 : 304,
      headers: { ETag: etag, 'X-Pocket-Machine': 'ged', 'X-Pocket-Checked-At': '1234',
        'X-Pocket-Source-Synced-At': '1233', 'X-Pocket-Turn-Observed-At': '1232',
        'Server-Timing': 'desktop_history;dur=1.1', Vary: 'Accept-Encoding' } });
  };
  try {
    for (const [method, path] of [['GET', '/api/catalog'], ['POST', '/api/sync'],
      ['GET', `/api/tasks/${id}/transcript`], ['GET', `/api/tasks/${id}/history`]]) {
      assert.ok(readResponseKind(path, method), 'standalone Worker allowlist agrees with the shared protocol');
      const response = await worker.fetch(new Request(`https://x.fangs.cc${path}`, { method,
        headers: { Origin: 'https://x.fangs.cc', Cookie: 'navigator_session=fixture',
          'If-None-Match': etag, 'X-Pocket-Read-Version': etag, 'X-Navigator-Token': 'csrf' } }), env);
      assert.equal(response.status, method === 'POST' ? 204 : 304);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('ETag'), etag);
      assert.equal(response.headers.get('X-Pocket-Machine'), 'ged');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('X-Pocket-Checked-At'), '1234');
      assert.equal(response.headers.get('X-Pocket-Source-Synced-At'), '1233');
      assert.equal(response.headers.get('X-Pocket-Turn-Observed-At'), '1232');
      assert.equal(response.headers.get('Server-Timing'), 'desktop_history;dur=1.1');
      const forwarded = calls.at(-1).options.headers;
      assert.equal(forwarded.get('If-None-Match'), method === 'GET' ? etag : null);
      assert.equal(forwarded.get('X-Pocket-Read-Version'), method === 'POST' ? etag : null);
      assert.equal(forwarded.get('X-Navigator-Token'), 'csrf');
      assert.equal(forwarded.get('Cookie'), 'navigator_session=fixture');
    }
  } finally { globalThis.fetch = original; }
});

test('gateway keeps conditional reads isolated from writes, receipt lookups, redirects and other machines', async () => {
  const original = globalThis.fetch, calls = [], id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  const etag = `W/"pocket-read-v1-${'b'.repeat(64)}"`;
  let status = 304, machine = 'ged';
  globalThis.fetch = async (_url, options) => {
    calls.push(options);
    return new Response(null, { status, headers: { ETag: etag, 'X-Pocket-Machine': machine } });
  };
  try {
    for (const [method, path] of [['POST', '/api/tasks'], ['GET', `/api/tasks/${id}/messages/${id}`],
      ['GET', `/api/tasks/${id}/attachments`], ['GET', '/api/sync']]) {
      const response = await worker.fetch(new Request(`https://x.fangs.cc${path}`, { method,
        headers: { Origin: 'https://x.fangs.cc', 'If-None-Match': etag, 'X-Pocket-Read-Version': etag } }), env);
      assert.equal(response.status, 503);
      assert.equal(calls.at(-1).headers.get('If-None-Match'), null);
      assert.equal(calls.at(-1).headers.get('X-Pocket-Read-Version'), null);
    }
    status = 302;
    assert.equal((await worker.fetch(new Request('https://x.fangs.cc/api/catalog'), env)).status, 503);
    status = 304; machine = 'wandou';
    assert.equal((await worker.fetch(new Request('https://x.fangs.cc/api/catalog'), env)).status, 503);
  } finally { globalThis.fetch = original; }
});

test('history page reads preserve the opaque cursor and get a bounded longer read timeout', async t => {
  let seen, timeout;
  t.mock.method(AbortSignal, 'timeout', value => { timeout = value; return new AbortController().signal; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen = { url: String(url), method: options.method, cookie: options.headers.get('Cookie') };
    return new Response(JSON.stringify({ source: 'rollout', messages: [], hasMore: false, nextCursor: null, page: { kind: 'older' } }), {
      headers: { 'Content-Type': 'application/json', 'X-Pocket-Machine': 'ged' },
    });
  });
  const response = await worker.fetch(new Request('https://x.fangs.cc/api/tasks/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa/transcript-page?before=signed_opaque.cursor&limit=40', {
    headers: { Cookie: 'navigator_session=page-test' },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(seen.url, 'https://sample.trycloudflare.com/api/tasks/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa/transcript-page?before=signed_opaque.cursor&limit=40');
  assert.equal(seen.method, 'GET'); assert.equal(seen.cookie, 'navigator_session=page-test');
  assert.equal(timeout, 45000);
});

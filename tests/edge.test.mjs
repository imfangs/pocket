import test from "node:test";
import assert from "node:assert/strict";
import worker from "../edge/worker.mjs";
const env = {
  NAVIGATOR_CONNECTION: {
    get: async () => ({
      connected: true,
      publicOrigin: "https://sample.trycloudflare.com",
    }),
  },
};
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

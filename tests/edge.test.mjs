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

import test from "node:test";
import assert from "node:assert/strict";
import { worker } from "./helpers/worker-profile.mjs";

const origin = "https://x.fangs.cc";
const keys = JSON.stringify({ wandou: "b".repeat(64), studio: "c".repeat(64) });
function fixture(t, respond = () => new Response('{}', { headers: { "X-Pocket-Machine": "wandou" } })) {
  const calls = [], reads = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return respond(url, options);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return { calls, reads, env: {
    NAVIGATOR_MACHINE_KEYS: keys,
    NAVIGATOR_CONNECTION: { get: async (key) => {
      reads.push(key);
      const machineId = key === "origin" ? "ged" : key.slice("origin:".length);
      return { connected: true, publicOrigin: `https://${machineId}.trycloudflare.com`, machineId };
    } },
  } };
}
const request = (path, init) => new Request(origin + path, init);

test("legacy and explicit machine routes select only their own KV record and canonical API path", async (t) => {
  const f = fixture(t, (url) => new Response('{}', {
    headers: { "X-Pocket-Machine": new URL(url).hostname.split('.')[0] },
  }));
  for (const [path, machineId] of [["/api/catalog", "ged"], ["/api/machines/ged/catalog", "ged"],
    ["/api/machines/wandou/catalog", "wandou"], ["/api/machines/studio/catalog", "studio"]]) {
    const response = await worker.fetch(request(path + "?limit=25&query=a%20b"), f.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Pocket-Machine"), machineId);
    assert.equal(f.calls.at(-1).url, `https://${machineId}.trycloudflare.com/api/catalog?limit=25&query=a%20b`);
  }
  assert.deepEqual(f.reads, ["origin", "origin", "origin:wandou", "origin:studio"]);
});

test("unknown machines and invalid remote config never look up or fall back to Ged", async (t) => {
  const f = fixture(t);
  for (const [path, map, status, machineId] of [
    ["/api/machines/missing/catalog", keys, 404, "missing"],
    ["/api/machines/constructor/catalog", "{}", 404, "constructor"],
    ["/api/machines/wandou/catalog", undefined, 404, "wandou"],
    ["/api/machines/wandou/catalog", "bad json", 503, "wandou"],
    ["/api/machines/wandou/catalog", "null", 503, "wandou"],
    ["/api/machines/wandou/catalog", "[]", 503, "wandou"],
    ["/api/machines/wandou/catalog", '{"wandou":"bad verifier"}', 503, "wandou"],
    ["/api/machines/wandou", keys, 400, "wandou"],
    ["/api/machines/%77andou/catalog", keys, 400, "invalid"],
    ["/api/machines", keys, 400, "invalid"],
  ]) {
    const response = await worker.fetch(request(path), { ...f.env, NAVIGATOR_MACHINE_KEYS: map });
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get("X-Pocket-Machine"), machineId);
    assert.equal((await response.json()).code, "relay_not_forwarded");
  }
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.calls, []);
  // A bad remote config cannot break the previously configured default machine.
  globalThis.fetch = async () => new Response('{}');
  assert.equal((await worker.fetch(request("/api/catalog"), { ...f.env, NAVIGATOR_MACHINE_KEYS: "bad json" })).status, 200);
  assert.deepEqual(f.reads, ["origin"]);
});

test("each machine receives only its selected session cookie under the upstream name", async (t) => {
  const f = fixture(t, (url) => new Response('{}', {
    headers: { "X-Pocket-Machine": new URL(url).hostname.split('.')[0] },
  }));
  for (const [machineId, cookies, expected] of [
    ["ged", "navigator_session=default; navigator_session_wandou=remote; analytics=other", "navigator_session=default"],
    ["wandou", "navigator_session=default; navigator_session_wandou=remote; navigator_session_studio=studio", "navigator_session=remote"],
    ["studio", "navigator_session=default; navigator_session_wandou=remote; navigator_session_studio=studio", "navigator_session=studio"],
    ["wandou", "navigator_session=default; navigator_session_wandou_extra=wrong", null],
    ["ged", "navigator_session_wandou=remote", null],
  ]) {
    const path = machineId === "ged" ? "/api/auth/session" : `/api/machines/${machineId}/auth/session`;
    const response = await worker.fetch(request(path, { headers: {
      Cookie: cookies, Authorization: "Bearer local-only", "X-Navigator-Token": "csrf",
    } }), f.env);
    assert.equal(response.status, 200);
    const forwarded = f.calls.at(-1).options.headers;
    assert.equal(forwarded.get("Cookie"), expected);
    assert.equal(forwarded.get("Authorization"), null);
    assert.equal(forwarded.get("X-Navigator-Token"), "csrf");
  }
});

test("remote login and logout cookies are renamed with flags and Expires intact; unrelated cookies are dropped", async (t) => {
  const flags = "; Path=/; HttpOnly; Secure; SameSite=Strict";
  let cookies = [], currentRuntime;
  const f = fixture(t, () => {
    const headers = new Headers({ "X-Pocket-Machine": "wandou", "Access-Control-Allow-Origin": "*" });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    const response = new Response('{}', { headers });
    if (currentRuntime === "workers-getAll") {
      Object.defineProperty(response.headers, "getSetCookie", { value: undefined });
      Object.defineProperty(response.headers, "getAll", { value: name => {
        assert.equal(name, "Set-Cookie"); return cookies;
      } });
    }
    return response;
  });
  for (const session of ["test" + flags, "" + flags + "; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"])
    for (const runtime of ["standard", "workers-getAll"]) {
      currentRuntime = runtime;
      cookies = ["navigator_session=" + session, "navigator_session_wandou=attack" + flags,
        "navigator_session_studio=attack" + flags, "unrelated=attack" + flags];
      const response = await worker.fetch(request("/api/machines/wandou/auth/login", {
        method: "POST", headers: { Origin: origin }, body: '{}',
      }), f.env);
      assert.equal(response.status, 200);
      assert.deepEqual(response.headers.getSetCookie(), ["navigator_session_wandou=" + session]);
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
});

test("default response cookies cannot overwrite a remote session", async (t) => {
  const f = fixture(t, () => new Response('{}', { headers: [
    ["Set-Cookie", "navigator_session=default; Secure; HttpOnly; SameSite=Strict; Path=/"],
    ["Set-Cookie", "navigator_session_wandou=attack; Path=/"],
  ] }));
  const response = await worker.fetch(request("/api/auth/login", { method: "POST", headers: { Origin: origin } }), f.env);
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers.getSetCookie(), ["navigator_session=default; Secure; HttpOnly; SameSite=Strict; Path=/"]);
});

test("remote attachment uploads and image previews preserve bytes and query parameters after path rewriting", async (t) => {
  const budgets = [], originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = value => { budgets.push(value); return new AbortController().signal; };
  t.after(() => { AbortSignal.timeout = originalTimeout; });
  const f = fixture(t);
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", attachment = `/tasks/${id}/attachments/${id}`;
  const put = await worker.fetch(request("/api/machines/wandou" + attachment + "?name=photo.heic", {
    method: "PUT", headers: { Origin: origin, "Content-Type": "image/heic" }, body: "image bytes",
  }), f.env);
  assert.equal(put.status, 200);
  assert.equal(await new Response(f.calls[0].options.body).text(), "image bytes");
  assert.equal(f.calls[0].url, "https://wandou.trycloudflare.com/api" + attachment + "?name=photo.heic");
  assert.equal(f.calls[0].options.headers.get("Origin"), "https://wandou.trycloudflare.com");
  for (const suffix of [attachment + "?preview=1", `/tasks/${id}/images/${id}?variant=thumbnail`]) {
    assert.equal((await worker.fetch(request("/api/machines/wandou" + suffix), f.env)).status, 200);
    assert.equal(f.calls.at(-1).url, "https://wandou.trycloudflare.com/api" + suffix);
  }
  assert.deepEqual(budgets, [180000, 20000, 20000]);
});

test("remote security errors name their target and retain Host, Origin and mutation protections", async (t) => {
  const f = fixture(t);
  for (const input of [
    new Request("https://evil.example/api/machines/wandou/catalog"),
    request("/api/machines/wandou/catalog", { headers: { Origin: "https://evil.example" } }),
    request("/api/machines/wandou/catalog", { headers: { "Sec-Fetch-Site": "cross-site" } }),
    request("/api/machines/wandou/tasks", { method: "POST" }),
  ]) {
    const response = await worker.fetch(input, f.env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("X-Pocket-Machine"), "wandou");
    assert.equal((await response.json()).code, "relay_not_forwarded");
  }
  assert.deepEqual(f.calls, []); assert.deepEqual(f.reads, []);
});

test("all machine routing failures retain forwarding certainty and never leak a mismatched upstream response", async (t) => {
  const f = fixture(t);
  const input = () => request("/api/machines/wandou/tasks", { method: "POST", headers: { Origin: origin }, body: '{}' });
  for (const get of [async () => null, async () => { throw new Error(); },
    async () => ({ connected: true, publicOrigin: "https://ged.trycloudflare.com", machineId: "ged" }),
    async () => ({ connected: true, publicOrigin: "https://wandou.trycloudflare.com/private" })]) {
    const response = await worker.fetch(input(), { ...f.env, NAVIGATOR_CONNECTION: { get } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("X-Pocket-Machine"), "wandou");
    assert.equal((await response.json()).code, "relay_not_forwarded");
  }
  assert.deepEqual(f.calls, []);
  for (const [status, machineId] of [[200, undefined], [200, "ged"], [302, "wandou"], [503, "wandou"]]) {
    globalThis.fetch = async () => new Response('must not expose other machine data', { status, headers: {
      ...(machineId && { "X-Pocket-Machine": machineId }), "Set-Cookie": "navigator_session=must-not-leak",
    } });
    const response = await worker.fetch(input(), f.env);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("X-Pocket-Machine"), "wandou");
    assert.equal(response.headers.get("Set-Cookie"), null);
    const body = await response.json();
    assert.equal(body.code, "relay_unavailable");
    assert.ok(!JSON.stringify(body).includes("must not expose"));
  }
  globalThis.fetch = async () => { throw new Error("reply lost after possible execution"); };
  const lost = await worker.fetch(input(), f.env);
  assert.equal(lost.headers.get("X-Pocket-Machine"), "wandou");
  assert.equal((await lost.json()).code, "relay_unavailable");
  globalThis.fetch = async () => new Response('{}', { headers: { "X-Pocket-Machine": "wandou" } });
  const wrongDefault = await worker.fetch(request("/api/catalog"), f.env);
  assert.equal(wrongDefault.headers.get("X-Pocket-Machine"), "ged");
  assert.equal((await wrongDefault.json()).code, "relay_unavailable");
});

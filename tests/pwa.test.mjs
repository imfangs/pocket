import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
test("worker handles real fetch failures and 502 navigations with only the public offline response", async () => {
  const handlers = {};
  let fail = true;
  let cached=[];
  const context = {
    URL,
    Response,
    fetch: async () => {
      if (fail) throw new Error("offline");
      return new Response("origin unavailable", { status: 502 });
    },
    caches: {
      open:async()=>({addAll:async files=>{cached=[...files];}}),
      match: async (path) => {
        assert.equal(path, "/offline.html");
        return new Response("PUBLIC OFFLINE PAGE");
      },
    },
    self: {
      skipWaiting:async()=>{},
      location: { origin: "https://example.test" },
      addEventListener: (name, fn) => (handlers[name] = fn),
    },
  };
  vm.runInNewContext(
    readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"),
    context,
  );
  let installing;handlers.install({waitUntil:p=>installing=p});await installing;
  assert.ok(cached.length>0&&cached.every(path=>path==='/offline.html'||path==='/manifest.webmanifest'||path.startsWith('/icons/')));
  const navigation = async () => {
    let promise;
    handlers.fetch({
      request: {
        url: "https://example.test/",
        method: "GET",
        mode: "navigate",
      },
      respondWith: (p) => (promise = p),
    });
    return (await promise).text();
  };
  assert.equal(await navigation(), "PUBLIC OFFLINE PAGE");
  fail = false;
  assert.equal(await navigation(), "PUBLIC OFFLINE PAGE");
  let intercepted = false;
  handlers.fetch({
    request: {
      url: "https://example.test/api/catalog",
      method: "GET",
      mode: "navigate",
    },
    respondWith: () => (intercepted = true),
  });
  assert.equal(intercepted, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../edge/worker.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishConnection } from "../bin/publish-connection.mjs";
import { connectionHealth } from "../bin/connection-state.mjs";

const token = "a".repeat(64);
const hash = createHash("sha256").update(token).digest("hex");
const endpoint = "https://x.fangs.cc/api/relay/register";
const connection = { connected: true, publicOrigin: "https://sample.trycloudflare.com" };
const request = (body = connection, authorization = `Bearer ${token}`, extra = {}) =>
  new Request(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization, ...extra }, body: JSON.stringify(body) });

test("Mac registration renews a short-lived route without a Wrangler OAuth session", async () => {
  const writes = [];
  const env = { NAVIGATOR_REGISTRATION_SHA256: hash, NAVIGATOR_CONNECTION: { put: async (...args) => writes.push(args) } };
  const r = await worker.fetch(request(), env);
  assert.equal(r.status, 200);
  const receipt = await r.json();
  assert.equal(receipt.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "origin");
  assert.equal(JSON.parse(writes[0][1]).publicOrigin, connection.publicOrigin);
  assert.equal(writes[0][2].expirationTtl, 900);
  assert.ok(Date.parse(receipt.expiresAt) > Date.now());
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("registration rejects browser cookies, wrong keys and unsafe targets without writing KV", async () => {
  let writes = 0;
  const env = { NAVIGATOR_REGISTRATION_SHA256: hash, NAVIGATOR_CONNECTION: { put: async () => writes++ } };
  assert.equal((await worker.fetch(request(connection, ""), env)).status, 401);
  assert.equal((await worker.fetch(request(connection, "Bearer wrong", {Cookie: "navigator_session=test"}), env)).status, 401);
  assert.equal((await worker.fetch(request(connection, `Bearer ${token}`, {Origin:"https://evil.example"}), env)).status, 403);
  assert.equal((await worker.fetch(request({...connection,padding:"x".repeat(2048)}), env)).status, 413);
  assert.equal((await worker.fetch(request({...connection,connected:"yes"}), env)).status, 400);
  for (const publicOrigin of ["http://sample.trycloudflare.com", "https://127.0.0.1", "https://sample.trycloudflare.com.evil.example", "https://user:pass@sample.trycloudflare.com", "https://sample.trycloudflare.com/path", "https://sample.trycloudflare.com/?token=bad"]) {
    assert.equal((await worker.fetch(request({connected:true,publicOrigin}), env)).status, 400);
  }
  assert.equal((await worker.fetch(request(), { NAVIGATOR_CONNECTION: env.NAVIGATOR_CONNECTION })).status, 503);
  assert.equal(writes, 0);
});

test("publisher uses only the private registration key and verifies receipts without CLI credentials", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "navigator-registration-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeFileSync(join(dataDir, "relay-registration.json"), JSON.stringify({ token }), {mode:0o600});
  const stored = [];
  const env = { NAVIGATOR_REGISTRATION_SHA256: hash, NAVIGATOR_CONNECTION: {put:async (...args)=>stored.push(args)} };
  const options = {dataDir, config:{publicOrigin:"https://x.fangs.cc"}, fetch:async (url,init)=>{
    assert.equal(String(url), endpoint);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Origin, undefined);
    return worker.fetch(new Request(url,init),env);
  }};
  const receipt = await publishConnection(connection,options);
  assert.equal(receipt.entryOrigin,"https://x.fangs.cc");
  assert.equal(stored.length,1);
  await assert.rejects(publishConnection(connection,{...options,fetch:async()=>new Response("bad",{status:401})}), {code:"registration_http_401"});
  await assert.rejects(publishConnection(connection,{...options,fetch:async()=>new Response('{}')}), {code:"registration_receipt_invalid"});
  await assert.rejects(publishConnection(connection,{...options,fetch:async()=>{throw new Error('secret='+token);}}), {message:"registration_network_error"});
});

test("connected tunnel is unhealthy when registration failed or expired", () => {
  const now=Date.now();
  const state={...connection,published:true,expiresAt:new Date(now+60000).toISOString()};
  assert.equal(connectionHealth(state,now).ok,true);
  assert.equal(connectionHealth({...state,published:false},now).ok,false);
  assert.equal(connectionHealth({...state,expiresAt:new Date(now-1).toISOString()},now).ok,false);
  assert.equal(connectionHealth({...state,connected:false},now).ok,false);
  assert.equal(connectionHealth(connection,now).ok,false);
});

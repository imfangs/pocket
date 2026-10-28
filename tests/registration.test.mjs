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
  assert.equal(receipt.machineId, "ged");
  assert.equal(r.headers.get("X-Pocket-Machine"), "ged");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "origin");
  assert.equal(JSON.parse(writes[0][1]).publicOrigin, connection.publicOrigin);
  assert.equal(writes[0][2].expirationTtl, 1800);
  assert.equal(Date.parse(receipt.expiresAt) - Date.parse(receipt.publishedAt), 1800000);
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

test("registration binds each token to its machine and cannot overwrite another machine's route", async () => {
  const remoteToken = "b".repeat(64), remoteHash = createHash("sha256").update(remoteToken).digest("hex");
  const writes = [];
  const env = { NAVIGATOR_REGISTRATION_SHA256: hash,
    NAVIGATOR_MACHINE_KEYS: JSON.stringify({ wandou: remoteHash, studio: remoteHash, ged: remoteHash }),
    NAVIGATOR_CONNECTION: { put: async (...args) => writes.push(args) } };
  for (const [machineId, credential, status] of [["wandou", token, 401], ["ged", remoteToken, 401],
    [undefined, remoteToken, 401], ["missing", token, 404], ["constructor", token, 404],
    ["wandou", remoteToken, 200], ["studio", remoteToken, 200], ["ged", token, 200]]) {
    const response = await worker.fetch(request({ ...connection, machineId }, `Bearer ${credential}`), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("X-Pocket-Machine"), machineId || "ged");
    if (status === 200) {
      const receipt = await response.json();
      assert.equal(receipt.machineId, machineId);
      assert.equal(writes.at(-1)[0], machineId === "ged" ? "origin" : `origin:${machineId}`);
      assert.equal(JSON.parse(writes.at(-1)[1]).machineId, machineId);
    }
  }
  assert.equal(writes.length, 3);
  for (const machineId of [null, "", "Wandou", "wandou/ged", "a".repeat(33), {}, 1])
    assert.equal((await worker.fetch(request({ ...connection, machineId }), env)).status, 400);
  for (const map of ["not json", "null", "[]", '{"wandou":"invalid"}']) {
    const response = await worker.fetch(request({ ...connection, machineId: "wandou" }), { ...env, NAVIGATOR_MACHINE_KEYS: map });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("X-Pocket-Machine"), "wandou");
  }
  assert.equal(writes.length, 3);
});

test("publisher selects config or environment machine, includes it in registration and checks receipt identity", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "navigator-machine-registration-"));
  const previousMachine = process.env.NAVIGATOR_MACHINE_ID;
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (previousMachine === undefined) delete process.env.NAVIGATOR_MACHINE_ID;
    else process.env.NAVIGATOR_MACHINE_ID = previousMachine;
  });
  delete process.env.NAVIGATOR_MACHINE_ID;
  writeFileSync(join(dataDir, "relay-registration.json"), JSON.stringify({ token }), { mode: 0o600 });
  const validReceipt = { ok: true, entryOrigin: "https://x.fangs.cc", publicOrigin: connection.publicOrigin,
    publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString() };
  const selected = [];
  const options = { dataDir, config: { publicOrigin: "https://x.fangs.cc" }, fetch: async (url, init) => {
    assert.equal(String(url), endpoint);
    const input = JSON.parse(init.body); selected.push(input.machineId);
    return Response.json({ ...validReceipt, machineId: input.machineId }, { headers: { "X-Pocket-Machine": input.machineId } });
  } };
  assert.equal((await publishConnection(connection, options)).machineId, "ged");
  process.env.NAVIGATOR_MACHINE_ID = "wandou";
  assert.equal((await publishConnection(connection, options)).machineId, "wandou");
  assert.equal((await publishConnection(connection, { ...options, config: { ...options.config, machineId: "studio" } })).machineId, "studio");
  assert.deepEqual(selected, ["ged", "wandou", "studio"]);
  for (const machineId of [undefined, "ged", "studio", null]) {
    await assert.rejects(publishConnection(connection, { ...options, fetch: async () => Response.json({ ...validReceipt, machineId }) }),
      { code: "registration_receipt_invalid" });
  }
  await assert.rejects(publishConnection(connection, { ...options, fetch: async () => Response.json({ ...validReceipt, machineId: "wandou" },
    { headers: { "X-Pocket-Machine": "ged" } }) }), { code: "registration_receipt_invalid" });
  // Only default Ged can accept an old worker's receipt with no machine identity.
  const legacy = await publishConnection(connection, { ...options, config: { ...options.config, machineId: "ged" },
    fetch: async () => Response.json(validReceipt) });
  assert.equal(legacy.machineId, "ged");
  for (const machineId of ["", null, "Wandou", "wandou/ged", {}, "a".repeat(33)])
    await assert.rejects(publishConnection(connection, { ...options, config: { ...options.config, machineId } }),
      { code: "registration_machine_invalid" });
  process.env.NAVIGATOR_MACHINE_ID = "wandou/ged";
  await assert.rejects(publishConnection(connection, options), { code: "registration_machine_invalid" });
  assert.deepEqual(selected, ["ged", "wandou", "studio"]);
});

test("a remote publisher registers directly into its own short-lived KV route", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "navigator-remote-registration-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const remoteToken = "c".repeat(64), remoteHash = createHash("sha256").update(remoteToken).digest("hex");
  writeFileSync(join(dataDir, "relay-registration.json"), JSON.stringify({ token: remoteToken }), { mode: 0o600 });
  const writes = [], env = { NAVIGATOR_REGISTRATION_SHA256: hash, NAVIGATOR_MACHINE_KEYS: JSON.stringify({ wandou: remoteHash }),
    NAVIGATOR_CONNECTION: { put: async (...args) => writes.push(args) } };
  const result = await publishConnection(connection, { dataDir, config: { publicOrigin: "https://x.fangs.cc", machineId: "wandou" },
    fetch: async (url, init) => worker.fetch(new Request(url, init), env) });
  assert.equal(result.machineId, "wandou");
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], "origin:wandou");
  assert.equal(JSON.parse(writes[0][1]).machineId, "wandou");
  assert.equal(writes[0][2].expirationTtl, 1800);
  assert.equal(Date.parse(result.expiresAt) - Date.parse(result.publishedAt), 1800000);
});

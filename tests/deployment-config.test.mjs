import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import http from "node:http";
import { readDeploymentConfig, normalizeDeploymentConfig, readClientProfile } from "../server/deployment-config.mjs";
import { makeApp } from "../server/index.mjs";
import { NavigatorStore } from "../server/store.mjs";
import { AccessControl } from "../server/auth.mjs";
import { runInNewContext } from "node:vm";

const temp = t => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-deployment-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const publicConfig = { schemaVersion: 1, publicOrigin: "https://pocket.example.com", machineId: "my-mac" };

test("explicit deployment origins are narrow and legacy defaults remain unchanged", () => {
  const legacy = normalizeDeploymentConfig();
  assert.equal(legacy.configured, false); assert.equal(legacy.minimumPassphraseLength, 4);
  assert.deepEqual(legacy.allowedHosts, ["127.0.0.1", "localhost", "[::1]", "threads.local"]);
  const own = normalizeDeploymentConfig({ ...publicConfig, allowedHosts: ["pocket.example.com", "MY-MAC.example.ts.net", "100.100.2.3"] });
  assert.equal(own.publicOrigin, publicConfig.publicOrigin); assert.equal(own.minimumPassphraseLength, 12);
  assert.equal(own.machineId, "my-mac");
  assert.deepEqual(own.allowedHosts, ["127.0.0.1", "localhost", "[::1]", "pocket.example.com", "my-mac.example.ts.net", "100.100.2.3"]);
  assert.ok(!own.allowedHosts.includes("threads.local"));
  assert.equal(normalizeDeploymentConfig({ ...publicConfig, publicOrigin: "https://my-mac.tailnet.ts.net:8443/" }).publicOrigin, "https://my-mac.tailnet.ts.net:8443");
  assert.ok(normalizeDeploymentConfig({ ...publicConfig, allowedHosts: ["fd7a:115c:a1e0:0:0:0:0:2"] }).allowedHosts.includes("[fd7a:115c:a1e0::2]"));
  assert.equal(normalizeDeploymentConfig({ schemaVersion: 1 }).minimumPassphraseLength, 4);
});

test("unsafe or malformed deployment values fail without echoing their input", () => {
  const invalid = [null, [], {}, { schemaVersion: 2 }, { ...publicConfig, extra: "unused" },
    ...["http://pocket.example.com", "https://pocket.example.com/private", "https://pocket.example.com?secret=value", "https://owner:secret@pocket.example.com", "https://pocket.example.com#secret"].map(publicOrigin => ({ ...publicConfig, publicOrigin })),
    ...["*", "*.example.com", "domain:443", "https://domain", "domain/path", ".bad", "bad..domain", "-bad.domain"].map(host => ({ ...publicConfig, allowedHosts: [host] })),
    ...["../mac", "Mac", "my mac", ""].map(machineId => ({ ...publicConfig, machineId })),
    ...[4, 11, null, "12", 129].map(minimumPassphraseLength => ({ ...publicConfig, minimumPassphraseLength }))];
  for (const value of invalid) assert.throws(() => normalizeDeploymentConfig(value), error => {
    assert.equal(error.message, "Invalid Pocket deployment configuration"); return true;
  });
});

test("deployment files require an absolute path and are bounded and fail-closed", t => {
  const directory = temp(t), file = join(directory, "deployment.json");
  assert.throws(() => readDeploymentConfig("relative.json"), /absolute file path/);
  assert.throws(() => readDeploymentConfig(join(directory, "missing.json")), /Unable to read/);
  writeFileSync(file, JSON.stringify(publicConfig)); assert.equal(readDeploymentConfig(file).machineId, "my-mac");
  writeFileSync(file, "null"); assert.throws(() => readDeploymentConfig(file), /Invalid Pocket/);
  writeFileSync(file, "{bad"); assert.throws(() => readDeploymentConfig(file), /Invalid Pocket/);
  writeFileSync(file, " ".repeat(65537)); assert.throws(() => readDeploymentConfig(file), /Invalid Pocket/);
});

test("an external public client profile is absolute, validated and does not admit private configuration", t => {
  const directory = temp(t), file = join(directory, "client.json");
  assert.throws(() => readClientProfile("relative.json"), /absolute file path/);
  assert.throws(() => readClientProfile(join(directory, "missing.json")), /Unable to read/);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, defaultMachine: "ged", machines: [{ id: "ged", label: "First Mac" }, { id: "wandou", label: "Second Mac" }], publicOrigin: publicConfig.publicOrigin }));
  assert.equal(readClientProfile(file).machines.length, 2);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, defaultMachine: "local", machines: [{ id: "local", label: "Mac" }], localToken: "PRIVATE_NOT_PUBLIC" }));
  assert.throws(() => readClientProfile(file), /Invalid Pocket client configuration/);
  writeFileSync(file, "{malformed PRIVATE_NOT_PUBLIC");
  assert.throws(() => readClientProfile(file), error => { assert.ok(!error.message.includes("PRIVATE_NOT_PUBLIC")); return true; });
});

test("new password policy preserves existing credentials and sessions until an explicit replacement", t => {
  const directory = temp(t);
  let store = new NavigatorStore(directory), auth = new AccessControl(directory, store.db);
  auth.setPassphrase("4826");
  const saved = readFileSync(auth.configPath), savedPass = readFileSync(auth.passphrasePath), token = auth.localToken;
  const session = auth.login("4826", "fixture"), request = { headers: { cookie: `navigator_session=${session.token}` } };
  store.close(); store = new NavigatorStore(directory); auth = new AccessControl(directory, store.db, { minimumPassphraseLength: 12 });
  t.after(() => store.close());
  assert.ok(readFileSync(auth.configPath).equals(saved)); assert.ok(readFileSync(auth.passphrasePath).equals(savedPass));
  assert.ok(auth.authenticate(request)); assert.ok(auth.login("4826", "fixture").token);
  assert.throws(() => auth.setPassphrase("short"), /12–128/); assert.ok(auth.authenticate(request));
  auth.setPassphrase("a-new-long-passphrase"); assert.equal(auth.authenticate(request), false);
  assert.ok(auth.localToken === token); assert.equal(auth.config().passwordPolicyMinimum, 12);
});

test("a newly initialized public policy generates a valid private password without exposing it", t => {
  const directory = temp(t), store = new NavigatorStore(directory);
  t.after(() => store.close());
  const auth = new AccessControl(directory, store.db, { minimumPassphraseLength: 16 });
  const generated = readFileSync(auth.passphrasePath, "utf8").trim();
  assert.ok(generated.length >= 16 && generated.length <= 128); assert.ok(auth.login(generated, "fixture").token);
  assert.equal(auth.config().passwordPolicyMinimum, 16);
  for (const minimumPassphraseLength of [null, "12", 3, 129])
    assert.throws(() => new AccessControl(directory, store.db, { minimumPassphraseLength }), /Invalid Pocket passphrase policy/);
  const strongStore = new NavigatorStore(join(directory, "maximum-policy"));
  try {
    const strong = new AccessControl(strongStore.directory, strongStore.db, { minimumPassphraseLength: 128 });
    const password = readFileSync(strong.passphrasePath, "utf8").trim();
    assert.equal(password.length, 128); assert.ok(strong.login(password, "fixture").token);
  } finally { strongStore.close(); }
});

test("malformed authentication configuration errors never disclose file contents or paths", t => {
  const directory = temp(t), store = new NavigatorStore(directory);
  t.after(() => store.close());
  const auth = new AccessControl(directory, store.db);
  writeFileSync(auth.configPath, '{"localToken":"PRIVATE_FIXTURE_TOKEN"');
  assert.throws(() => auth.config(), error => {
    assert.equal(error.message, "登录配置损坏，保持拒绝访问");
    assert.ok(!error.message.includes("PRIVATE_FIXTURE_TOKEN") && !error.message.includes(directory)); return true;
  });
  writeFileSync(auth.configPath, "null"); assert.throws(() => auth.config(), /登录配置损坏/);
});

test("own HTTPS reverse proxy retains Host, Origin, CSRF and remote-bearer protections", async t => {
  const directory = temp(t), app = makeApp({ dataDir: directory, codexHome: directory, deploymentConfig: publicConfig,
    readSource: () => ({ threads: [], projects: [], sourceInfo: { syncedAt: 1 } }),
    automations: { read: () => ({ ok: true, automations: [] }) } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(done => app.server.close(done)));
  const port = app.server.address().port;
  const request = (path, method = "GET", extra = {}, body) => new Promise((done, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method,
      headers: { Host: "pocket.example.com", "X-Forwarded-Proto": "https", ...extra } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; });
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request("/api/health")).status, 200);
  assert.equal((await request("/api/health", "GET", { Host: "other.example.com" })).status, 403);
  assert.equal((await request("/api/health", "GET", { "X-Forwarded-Proto": "http" })).status, 403);
  assert.equal((await request("/api/health", "GET", { "X-Forwarded-Proto": "ftp" })).status, 403);
  assert.equal((await request("/api/health", "GET", { Host: "pocket.example.com:8443" })).status, 403);
  assert.equal((await request("http://localhost/api/health")).status, 403);
  assert.equal((await request("/api/deployment/status")).status, 401);
  assert.equal((await request("/api/catalog", "GET", { Authorization: `Bearer ${app.auth.localToken}` })).status, 401);
  assert.equal((await request("/api/deployment/status", "GET", { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${app.auth.localToken}` })).status, 401);
  assert.equal((await request("/api/deployment/status", "GET", { Host: `127.0.0.1:${port}`, "X-Forwarded-Proto": "", "CF-Connecting-IP": "198.51.100.1", Authorization: `Bearer ${app.auth.localToken}` })).status, 401);
  assert.equal((await request("/api/deployment/status", "GET", { Host: `127.0.0.1:${port}`, "X-Forwarded-Proto": "", Authorization: `Bearer ${app.auth.localToken}` })).status, 200);
  const passphrase = readFileSync(app.auth.passphrasePath, "utf8").trim();
  const login = await request("/api/auth/login", "POST", { Origin: publicConfig.publicOrigin, "Content-Type": "application/json" }, { passphrase });
  assert.equal(login.status, 200); assert.ok(login.headers["set-cookie"][0].includes("Secure"));
  const Cookie = login.headers["set-cookie"][0].split(";")[0];
  assert.equal((await request("/api/catalog", "GET", { Cookie, Origin: "https://other.example.com" })).status, 403);
  assert.equal((await request("/api/sync", "POST", { Cookie, Origin: publicConfig.publicOrigin, "Content-Type": "application/json" }, {})).status, 403);
  const status = await request("/api/deployment/status", "GET", { Cookie }); assert.equal(status.status, 200);
  const metadata = status.json(); assert.equal(metadata.machineId, "my-mac"); assert.equal(metadata.authentication.minimumPassphraseLength, 12);
  assert.equal(metadata.readiness.source, true); assert.equal(metadata.readiness.desktop, "not_checked");
  assert.equal(metadata.readiness.publicEntry, "not_checked");
  assert.ok(!status.text.includes("pocket.example.com") && !status.text.includes(directory) && !status.text.includes(passphrase) && !status.text.includes(app.auth.localToken));
});

test("liveness stays minimal while authenticated readiness records a failed source scan", async t => {
  const directory = temp(t), app = makeApp({ dataDir: directory, codexHome: directory,
    deploymentConfig: { schemaVersion: 1, machineId: "local" }, readSource: () => { throw new Error("PRIVATE_DIAGNOSTIC_SOURCE"); } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(done => app.server.close(done)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const live = await fetch(base + "/api/health"); assert.deepEqual(await live.json(), { ok: true, app: "codex-navigator", machineId: "local" });
  assert.equal((await fetch(base + "/api/deployment/status")).status, 401);
  const status = await fetch(base + "/api/deployment/status", { headers: { Authorization: `Bearer ${app.auth.localToken}` } });
  assert.equal(status.status, 200); const body = await status.text(), result = JSON.parse(body);
  assert.equal(result.readiness.source, false); assert.equal(result.readiness.storage, true);
  assert.ok(!body.includes("PRIVATE_DIAGNOSTIC_SOURCE") && !body.includes(directory));
});

test("the public client script exposes only a validated profile and escapes script-shaped labels", async t => {
  const directory = temp(t), label = "My <script> Mac\u2028test";
  const app = makeApp({ dataDir: directory, codexHome: directory, deploymentConfig: publicConfig,
    clientConfig: { schemaVersion: 1, defaultMachine: "my-mac", machines: [{ id: "my-mac", label }], publicOrigin: publicConfig.publicOrigin },
    readSource: () => ({ threads: [], projects: [], sourceInfo: {} }) });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(done => app.server.close(done)));
  const request = extra => new Promise((done, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: app.server.address().port, path: "/client-config.js",
      headers: { Host: "pocket.example.com", "X-Forwarded-Proto": "https", ...extra } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
    }); req.on("error", reject); req.end();
  });
  const script = await request({}); assert.equal(script.status, 200); assert.match(script.headers["content-type"], /javascript/);
  assert.equal(script.headers["cache-control"], "no-store"); assert.ok(!script.headers["set-cookie"]);
  assert.ok(!script.body.includes("<script>") && !script.body.includes("\u2028"));
  assert.ok(!script.body.includes(directory) && !script.body.includes(app.auth.localToken) && !script.body.includes("passwordPolicyMinimum"));
  const context = {}; runInNewContext(script.body, context);
  assert.equal(context.POCKET_CLIENT_CONFIG.defaultMachine, "my-mac"); assert.equal(context.POCKET_CLIENT_CONFIG.machines[0].label, label);
  assert.equal((await request({ Host: "other.example.com" })).status, 403);
  assert.equal((await request({ Origin: "https://other.example.com" })).status, 403);
});

test("invalid supplied client metadata is rejected before a data store is created", t => {
  const directory = temp(t);
  for (const clientConfig of [null, { schemaVersion: 1, defaultMachine: "local", machines: [{ id: "local", label: "Mac" }], secret: "not-public" }])
    assert.throws(() => makeApp({ dataDir: join(directory, "must-not-create"), clientConfig }), /Invalid Pocket client configuration/);
  assert.equal(existsSync(join(directory, "must-not-create")), false);
});

test("an explicit IPv6 HTTPS origin admits its normalized host and retains origin protection", async t => {
  const directory = temp(t), origin = "https://[fd7a:115c:a1e0::1]:8443";
  const app = makeApp({ dataDir: directory, codexHome: directory,
    deploymentConfig: { schemaVersion: 1, publicOrigin: origin, machineId: "ipv6" },
    readSource: () => ({ threads: [], projects: [], sourceInfo: {} }) });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(done => app.server.close(done)));
  const request = extra => new Promise((done, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: app.server.address().port, path: "/api/health",
      headers: { Host: "[fd7a:115c:a1e0::1]:8443", "X-Forwarded-Proto": "https", ...extra } }, res => {
      res.resume(); res.on("end", () => done(res.statusCode));
    }); req.on("error", reject); req.end();
  });
  assert.equal(await request({}), 200);
  assert.equal(await request({ Host: "[fd7a:115c:a1e0:0:0:0:0:1]:8443" }), 200);
  assert.equal(await request({ Host: "[fd7a:115c:a1e0::2]:8443" }), 403);
  assert.equal(await request({ Host: "[not-an-ip]:8443" }), 403);
  assert.equal(await request({ "X-Forwarded-Proto": "http" }), 403);
});

test("a configured own entry also admits exactly its validated registered transport", async t => {
  const directory = temp(t), transport = "https://owned-route.trycloudflare.com";
  writeFileSync(join(directory, "connection.json"), JSON.stringify({ publicOrigin: transport, temporary: true, connected: true }));
  const app = makeApp({ dataDir: directory, codexHome: directory, deploymentConfig: publicConfig,
    readSource: () => ({ threads: [], projects: [], sourceInfo: {} }) });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(done => app.server.close(done)));
  const request = (path, method = "GET", extra = {}, body) => new Promise((done, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: app.server.address().port, path, method,
      headers: { Host: "owned-route.trycloudflare.com", "X-Forwarded-Proto": "https", ...extra } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => done({ status: res.statusCode, headers: res.headers, text }));
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await request("/api/health")).status, 200);
  assert.equal((await request("/api/health", "GET", { Host: "unknown-route.trycloudflare.com" })).status, 403);
  assert.equal((await request("/api/health", "GET", { "X-Forwarded-Proto": "http" })).status, 403);
  assert.equal((await request("/api/catalog", "GET", { Authorization: `Bearer ${app.auth.localToken}` })).status, 401);
  const passphrase = readFileSync(app.auth.passphrasePath, "utf8").trim();
  const login = await request("/api/auth/login", "POST", { Origin: transport, "Content-Type": "application/json" }, { passphrase });
  assert.equal(login.status, 200); assert.ok(login.headers["set-cookie"][0].includes("Secure"));
  const Cookie = login.headers["set-cookie"][0].split(";")[0];
  assert.equal((await request("/api/catalog", "GET", { Cookie })).status, 200);
  assert.equal((await request("/api/catalog", "GET", { Cookie, Origin: publicConfig.publicOrigin })).status, 403);
  writeFileSync(join(directory, "connection.json"), JSON.stringify({ publicOrigin: transport + "/private", connected: true }));
  assert.equal((await request("/api/health")).status, 403);
  writeFileSync(join(directory, "connection.json"), JSON.stringify({ publicOrigin: transport, connected: false }));
  assert.equal((await request("/api/health")).status, 403);
});

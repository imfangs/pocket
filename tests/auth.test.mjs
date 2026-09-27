import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import http from "node:http";
import { makeApp } from "../server/index.mjs";
import { NavigatorStore } from "../server/store.mjs";
import { AccessControl } from "../server/auth.mjs";
const source = () => ({
  threads: [
    {
      id: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
      title: "PRIVATE_FIXTURE",
      projectId: null,
      archived: false,
    },
  ],
  projects: [],
  sourceInfo: { syncedAt: 1 },
});
const temp = (t) => {
  const p = mkdtempSync(join(tmpdir(), "navigator-auth-"));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
};
test("password config is private and hashed; sessions survive process restart and revoke on rotation", (t) => {
  const p = temp(t);
  let s = new NavigatorStore(p),
    a = new AccessControl(p, s.db);
  const pass = readFileSync(a.passphrasePath, "utf8").trim(),
    cfg = readFileSync(a.configPath, "utf8");
  assert.ok(!cfg.includes(pass));
  assert.equal(statSync(a.configPath).mode & 0o777, 0o600);
  const login = a.login(pass, "test");
  const req = { headers: { cookie: `navigator_session=${login.token}` } };
  assert.ok(a.authenticate(req));
  s.close();
  s = new NavigatorStore(p);
  a = new AccessControl(p, s.db);
  assert.ok(a.authenticate(req));
  assert.throws(() => a.setPassphrase("123"), /4–128/);
  assert.ok(a.authenticate(req));
  a.setPassphrase("4826");
  assert.equal(a.authenticate(req), false);
  assert.throws(() => a.login(pass, "test"), (e) => e.status === 401);
  assert.ok(a.login("4826", "test").token);
  s.close();
});
test("login limits repeated guesses and validates session expiry", (t) => {
  const s = new NavigatorStore(temp(t));
  t.after(() => s.close());
  const a = new AccessControl(s.directory, s.db),
    pass = readFileSync(a.passphrasePath, "utf8").trim();
  for (let i = 0; i < 10; i++)
    assert.throws(
      () => a.login("wrong", "limited"),
      (e) => e.status === 401,
    );
  assert.throws(
    () => a.login(pass, "limited"),
    (e) => e.status === 429,
  );
  const result = a.login(pass, "other");
  s.db.prepare("UPDATE auth_sessions SET expires_at=0").run();
  assert.equal(
    a.authenticate({
      headers: { cookie: `navigator_session=${result.token}` },
    }),
    false,
  );
});
test("anonymous cannot read private endpoints; remote cookie login works and local bearer cannot cross tunnel", async (t) => {
  const app = makeApp({
    dataDir: temp(t),
    readSource: source,
    connection: { publicOrigin: "https://fixture.trycloudflare.com" },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => new Promise((r) => app.server.close(r)));
  const port = app.server.address().port;
  const request = (path, method = "GET", extra = {}, body) =>
    new Promise((resolve, reject) => {
      const headers = {
        Host: "fixture.trycloudflare.com",
        "X-Forwarded-Proto": "https",
        ...extra,
      };
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method, headers },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text,
              json: () => JSON.parse(text),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  for (const path of ["/api/catalog", "/api/export", "/api/connection"]) {
    const r = await request(path);
    assert.equal(r.status, 401);
    assert.ok(!r.text.includes("PRIVATE_FIXTURE"));
  }
  let r = await request("/api/catalog", "GET", {
    Authorization: `Bearer ${app.auth.localToken}`,
  });
  assert.equal(r.status, 401);
  const pass = readFileSync(app.auth.passphrasePath, "utf8").trim();
  const loginHeaders = {
    Origin: "https://fixture.trycloudflare.com",
    "Content-Type": "application/json",
  };
  r = await request("/api/auth/login", "POST", loginHeaders, {
    passphrase: pass,
  });
  assert.equal(r.status, 200);
  const setCookie = r.headers["set-cookie"][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Secure/);
  const Cookie = setCookie.split(";")[0];
  r = await request("/api/catalog", "GET", { Cookie });
  assert.equal(r.status, 200);
  assert.match(r.text, /PRIVATE_FIXTURE/);
  assert.match(r.headers["cache-control"], /no-store/);
  const csrf = r.json().csrfToken;
  r = await request(
    "/api/auth/logout",
    "POST",
    { ...loginHeaders, Cookie },
    {},
  );
  assert.equal(r.status, 200);
  r = await request("/api/catalog", "GET", { Cookie });
  assert.equal(r.status, 401);
  r = await request(
    "/api/sync",
    "POST",
    { ...loginHeaders, "X-Navigator-Token": csrf, Cookie },
    {},
  );
  assert.equal(r.status, 401);
  r = await request(
    "/api/auth/login",
    "POST",
    { Origin: "https://evil.example", "Content-Type": "application/json" },
    { passphrase: pass },
  );
  assert.equal(r.status, 403);
});
test("manifest declares standalone mode and real icon files", () => {
  const root = new URL("../public/", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(new URL("manifest.webmanifest", root), "utf8"),
  );
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"));
  for (const i of manifest.icons)
    assert.ok(statSync(new URL(i.src.slice(1), root)).size > 100);
});

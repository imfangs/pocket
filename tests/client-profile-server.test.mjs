import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { runInNewContext } from "node:vm";
import http from "node:http";
import { makeApp } from "../server/index.mjs";

test("an explicit public client file preserves a multi-Mac profile without serving credentials", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-client-profile-")), file = join(directory, "client.json");
  const profile = { schemaVersion: 1, defaultMachine: "ged", machines: [{ id: "ged", label: "First Mac" }, { id: "wandou", label: "Second Mac" }], publicOrigin: "https://pocket.example.com" };
  writeFileSync(file, JSON.stringify(profile));
  const previous = process.env.NAVIGATOR_CLIENT_CONFIG; let app;
  process.env.NAVIGATOR_CLIENT_CONFIG = file;
  try {
    app = makeApp({ dataDir: join(directory, "data"), codexHome: directory,
      deploymentConfig: { schemaVersion: 1, publicOrigin: profile.publicOrigin, machineId: "ged" },
      readSource: () => ({ threads: [], projects: [], sourceInfo: {} }) });
  } finally {
    if (previous === undefined) delete process.env.NAVIGATOR_CLIENT_CONFIG; else process.env.NAVIGATOR_CLIENT_CONFIG = previous;
  }
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise(done => app.server.close(() => { rmSync(directory, { recursive: true, force: true }); done(); })));
  const result = await new Promise((done, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: app.server.address().port, path: "/client-config.js",
      headers: { Host: "pocket.example.com", "X-Forwarded-Proto": "https" } }, res => {
      let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
    }); req.on("error", reject); req.end();
  });
  assert.equal(result.status, 200); const context = {}; runInNewContext(result.body, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.POCKET_CLIENT_CONFIG)), profile);
  assert.ok(!result.body.includes(directory) && !result.body.includes(app.auth.localToken));
  assert.equal(result.headers["cache-control"], "no-store"); assert.ok(!result.headers["set-cookie"]);
});

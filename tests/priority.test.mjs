import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { NavigatorStore } from "../server/store.mjs";
import { makeApp } from "../server/index.mjs";
import { readCodexSource } from "../server/source.mjs";
import { worker } from "./helpers/worker-profile.mjs";

const one = "11111111-1111-7111-8111-111111111111";
const two = "22222222-2222-7222-8222-222222222222";
const unknown = "44444444-4444-7444-8444-444444444444";
const source = () => ({
  threads: [one, two].map((id, index) => ({
    id, title: `Priority fixture ${index}`, cwd: "/sample", projectId: "project",
    pinned: index === 0, pinnedOrder: index === 0 ? 0 : -1,
    updatedAt: 3000 - index * 1000, archived: false, separator: false,
  })),
  projects: [{ id: "project", name: "Fixture" }], sourceInfo: { scope: "synthetic" },
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pocket-priority-"));
  let store = new NavigatorStore(directory);
  store.sync(source());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, get store() { return store; },
    reopen() { store.close(); store = new NavigatorStore(directory); return store; },
  };
}
const states = thread => ({ codexPinned: thread.codexPinned, pocketPriority: thread.pocketPriority });
const rawSources = store => store.db.prepare("SELECT * FROM source_threads ORDER BY id").all();
const backups = directory => existsSync(join(directory, "backups")) ? readdirSync(join(directory, "backups")) : [];

test("Codex pins and Pocket priority are independent through enable, disable and legacy overrides", t => {
  const { store } = fixture(t);
  assert.deepEqual(states(store.thread(one)), { codexPinned: true, pocketPriority: false });
  assert.deepEqual(states(store.thread(two)), { codexPinned: false, pocketPriority: false });
  store.patchThread(one, { note: "keep", intent: "later", groupIds: [], expectedRevision: 0 });
  const original = rawSources(store);
  const enabled = store.setPriority(one, { priority: true });
  assert.deepEqual(states(enabled), { codexPinned: true, pocketPriority: true });
  assert.equal(enabled.note, "keep");
  assert.equal(enabled.revision, 1);
  assert.equal(enabled.updatedAt, 3000);
  const disabled = store.setPriority(one, { priority: false });
  assert.deepEqual(states(disabled), { codexPinned: true, pocketPriority: false });
  assert.equal(disabled.pinned, false, "old PWA effective pin remains compatible");
  assert.equal(disabled.pinSource, "pocket");
  assert.equal(disabled.archived, false);
  assert.deepEqual(rawSources(store), original);
  store.setPin(one, { pinned: true });
  store.setPin(two, { pinned: false });
  assert.deepEqual(states(store.thread(one)), { codexPinned: true, pocketPriority: true });
  assert.deepEqual(states(store.thread(two)), { codexPinned: false, pocketPriority: false });
  for (const thread of store.catalog().threads)
    assert.deepEqual(thread, { ...store.thread(thread.id), ...store.annotation(thread.id, thread) });
});

test("priority sets are idempotent, including unset false, without revision, order or backup churn", t => {
  const { store, directory } = fixture(t);
  store.setPriority(one, { priority: false });
  store.setPriority(two, { priority: false });
  assert.deepEqual(store.export().pins, []);
  assert.deepEqual(backups(directory), []);
  assert.equal(store.thread(one).pinRevision, 0);
  for (const priority of [true, false]) {
    const first = store.setPriority(one, { priority });
    const pins = store.export().pins, files = backups(directory);
    assert.deepEqual(store.setPriority(one, { priority }), first);
    assert.deepEqual(store.export().pins, pins);
    assert.deepEqual(backups(directory), files);
  }
  assert.equal(store.thread(one).pinRevision, 2);
});

test("native pin changes beneath either Pocket preference advance a shared revision without changing priority", t => {
  const { store } = fixture(t);
  store.setPriority(one, { priority: true });
  store.setPin(two, { pinned: false });
  const revision = store.thread(one).pinRevision;
  const next = source();
  next.threads[0].pinned = false;
  next.threads[0].pinnedOrder = -1;
  next.threads[1].pinned = true;
  next.threads[1].pinnedOrder = 0;
  store.sync(next);
  assert.deepEqual(states(store.thread(one)), { codexPinned: false, pocketPriority: true });
  assert.deepEqual(states(store.thread(two)), { codexPinned: true, pocketPriority: false });
  assert.equal(store.thread(one).pinned, true);
  assert.equal(store.thread(two).pinned, false);
  assert.equal(store.thread(one).pinRevision, revision + 1);
  next.threads[0].title = "Only title changed";
  store.sync(next);
  assert.equal(store.thread(one).pinRevision, revision + 1);
  next.threads[1].pinnedOrder = 7;
  store.sync(next);
  assert.equal(store.thread(one).pinRevision, revision + 2);
});

test("existing true and false preferences round trip via unchanged backups and survive reopening", t => {
  const f = fixture(t), store = f.store;
  store.setPin(one, { pinned: false });
  store.setPin(two, { pinned: true });
  const backup = store.export();
  assert.ok(backup.pins.every(pin => typeof pin.pinned === "boolean"));
  store.setPriority(one, { priority: true });
  store.setPriority(two, { priority: false });
  store.restore(backup);
  assert.deepEqual(store.export().pins, backup.pins);
  assert.deepEqual(states(store.thread(one)), { codexPinned: true, pocketPriority: false });
  assert.deepEqual(states(store.thread(two)), { codexPinned: false, pocketPriority: true });
  const reopened = f.reopen();
  assert.deepEqual(states(reopened.thread(two)), { codexPinned: false, pocketPriority: true });
  const legacy = { ...backup };
  delete legacy.pins;
  reopened.restore(legacy);
  assert.equal(reopened.thread(two).pocketPriority, true);
  reopened.restore({ ...backup, pins: [] });
  assert.deepEqual(states(reopened.thread(one)), { codexPinned: true, pocketPriority: false });
  assert.equal(reopened.thread(two).pocketPriority, false);
});

test("untrusted projected fields in source and backups never grant Pocket priority or replace native pin truth", t => {
  const { store } = fixture(t);
  const forged = source();
  forged.threads[0].codexPinned = false;
  forged.threads[0].pocketPriority = true;
  forged.threads[1].codexPinned = true;
  forged.threads[1].pocketPriority = true;
  store.sync(forged);
  assert.deepEqual(states(store.thread(one)), { codexPinned: true, pocketPriority: false });
  assert.deepEqual(states(store.thread(two)), { codexPinned: false, pocketPriority: false });
  store.patchThread(one, { note: "kept" });
  const backup = store.export();
  backup.codexPinned = false;
  backup.pocketPriority = true;
  backup.threads = forged.threads;
  backup.annotations[0].pocketPriority = true;
  backup.annotations[0].codexPinned = false;
  store.restore(backup);
  assert.deepEqual(states(store.thread(one)), { codexPinned: true, pocketPriority: false });
  assert.equal(store.annotation(one).note, "kept");
  assert.throws(() => store.patchThread(one, { pocketPriority: true }), error => error.status === 400);
  store.setPriority(two, { priority: true });
  const malformed = store.export();
  malformed.pins[0].pocketPriority = true;
  assert.throws(() => store.restore(malformed), error => error.status === 400);
  assert.equal(store.thread(two).pocketPriority, true);
});

test("priority metadata preserves source exclusion and rejects invalid input or revision overflow atomically", t => {
  const { store } = fixture(t);
  for (const input of [null, [], {}, { priority: 1 }, { priority: "true" }, { priority: true, pinned: true }])
    assert.throws(() => store.setPriority(one, input), error => error.status === 400);
  assert.throws(() => store.setPriority(unknown, { priority: false }), error => error.status === 404);
  store.setPriority(one, { priority: true });
  store.sync({ ...source(), threads: source().threads.slice(1), excludedThreadIds: [one], excludedThreadStates: [{ id: one, archived: true }] });
  store.setPriority(one, { priority: false });
  assert.equal(store.thread(one).archived, true);
  assert.equal(store.thread(one).sourceExcluded, true);
  assert.ok(!store.catalog().threads.some(thread => thread.id === one));
  store.set("pinRevision", Number.MAX_SAFE_INTEGER);
  const before = store.export().pins;
  assert.throws(() => store.setPriority(two, { priority: true }), error => error.status === 400);
  assert.deepEqual(store.export().pins, before);
  assert.equal(store.setPriority(two, { priority: false }).pinRevision, Number.MAX_SAFE_INTEGER);
});

test("priority endpoint enforces auth, CSRF and strict input, returns both values, and invokes no native owner", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-priority-http-"));
  let ownerCalls = 0;
  const app = makeApp({ dataDir: directory, codexHome: directory, readSource: source,
    desktopRequest: async () => { ownerCalls++; return { ok: false }; },
    openThread: async () => { ownerCalls++; },
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await fetch(base + "/api/catalog", { headers: auth }).then(r => r.json());
  const headers = { ...auth, Origin: base, "Content-Type": "application/json", "X-Navigator-Token": catalog.csrfToken };
  const call = (input, extra = {}, id = one) => fetch(`${base}/api/tasks/${id}/priority`, {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(input),
  });
  assert.equal((await call({ priority: true }, { Authorization: "" })).status, 401);
  assert.equal((await call({ priority: true }, { "X-Navigator-Token": "" })).status, 403);
  assert.equal((await call({ priority: true }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await call({ priority: true }, { "Content-Type": "text/plain" })).status, 415);
  for (const input of [null, [], {}, { priority: 1 }, { priority: "true" }, { priority: true, toggle: true }, { priority: true, codexPinned: false }])
    assert.equal((await call(input)).status, 400);
  assert.equal((await call({ priority: true }, {}, unknown)).status, 404);
  assert.deepEqual(app.store.export().pins, []);
  app.store.patchThread(one, { note: "kept", groupIds: [] });
  for (const priority of [true, false]) {
    const result = await call({ priority });
    assert.equal(result.status, 200);
    const thread = await result.json();
    assert.deepEqual(states(thread), { codexPinned: true, pocketPriority: priority });
    assert.equal(thread.note, "kept");
    assert.deepEqual(thread.groupIds, []);
    const pins = app.store.export().pins;
    assert.equal((await call({ priority })).status, 200);
    assert.deepEqual(app.store.export().pins, pins);
    const reread = await fetch(base + "/api/catalog", { headers: auth }).then(r => r.json());
    assert.deepEqual(states(reread.threads.find(t => t.id === one)), states(thread));
  }
  assert.equal(ownerCalls, 0);
});

test("priority changes leave original Codex SQLite and global pin files byte-identical", t => {
  const f = fixture(t), home = mkdtempSync(join(tmpdir(), "pocket-priority-source-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const database = join(home, "state_5.sqlite"), globalPath = join(home, ".codex-global-state.json");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,source TEXT)");
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?)").run(one, "Original fixture", "/sample", 0, 1, 2, "app");
  db.close();
  writeFileSync(globalPath, JSON.stringify({ "pinned-thread-ids": [one] }));
  const hashes = () => [database, globalPath].map(path => createHash("sha256").update(readFileSync(path)).digest("hex"));
  const before = hashes();
  f.store.sync(readCodexSource(home));
  for (const priority of [true, false]) {
    f.store.setPriority(one, { priority });
    f.store.sync(readCodexSource(home));
    assert.deepEqual(states(f.store.thread(one)), { codexPinned: true, pocketPriority: priority });
  }
  assert.deepEqual(hashes(), before);
});

test("stable gateway forwards the priority request body and existing same-origin session headers", async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options, body: await new Response(options.body).text() };
    return new Response(JSON.stringify({ codexPinned: true, pocketPriority: true }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request(`https://pocket.example.com/api/tasks/${one}/priority`, {
      method: "POST", headers: { Origin: "https://pocket.example.com", "Content-Type": "application/json", Cookie: "navigator_session=fixture", "X-Navigator-Token": "fixture-csrf" },
      body: '{"priority":true}',
    }), { NAVIGATOR_CONNECTION: { get: async () => ({ connected: true, publicOrigin: "https://sample.trycloudflare.com" }) } });
    assert.equal(response.status, 200);
    assert.equal(seen.url, `https://sample.trycloudflare.com/api/tasks/${one}/priority`);
    assert.equal(seen.options.headers.get("Cookie"), "navigator_session=fixture");
    assert.equal(seen.options.headers.get("X-Navigator-Token"), "fixture-csrf");
    assert.equal(seen.body, '{"priority":true}');
    assert.deepEqual(await response.json(), { codexPinned: true, pocketPriority: true });
  } finally { globalThis.fetch = original; }
});

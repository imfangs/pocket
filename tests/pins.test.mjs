import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { NavigatorStore } from "../server/store.mjs";
import { makeApp } from "../server/index.mjs";
import { readCodexSource } from "../server/source.mjs";
import { filterThreads } from "../src/model.ts";

const one = "11111111-1111-7111-8111-111111111111";
const two = "22222222-2222-7222-8222-222222222222";
const three = "33333333-3333-7333-8333-333333333333";
const unknown = "44444444-4444-7444-8444-444444444444";
const source = () => ({
  threads: [one, two, three].map((id, index) => ({
    id, title: `Fixture ${index}`, cwd: "/sample", projectId: "project",
    pinned: index === 0, pinnedOrder: index === 0 ? 0 : -1,
    updatedAt: 3000 - index * 1000, archived: false, separator: false,
  })),
  projects: [{ id: "project", name: "Fixture" }], sourceInfo: { scope: "synthetic" },
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pocket-pins-"));
  let store = new NavigatorStore(directory);
  store.sync(source());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, get store() { return store; },
    reopen() { store.close(); store = new NavigatorStore(directory); return store; },
  };
}
const ordered = (store) => filterThreads(store.catalog().threads, store.groups(), "all", null, "", "", false, "pinned").map(t => t.id);
const rawSources = (store) => store.db.prepare("SELECT * FROM source_threads ORDER BY id").all();

test("unset Pocket pins follow the Mac source; explicit values survive later source changes", t => {
  const { store } = fixture(t);
  assert.equal(store.thread(one).pinned, true);
  assert.equal(store.thread(one).pinnedOrder, 0);
  assert.equal(store.thread(one).pinSource, "codex");
  assert.equal(store.thread(two).pinned, false);
  assert.deepEqual(store.export().pins, []);
  store.setPin(one, { pinned: false });
  // Choosing an already false value must still remember the user's decision.
  store.setPin(two, { pinned: false });
  const next = source();
  next.threads[1].pinned = true;
  next.threads[1].pinnedOrder = 1;
  next.threads[2].pinned = true;
  next.threads[2].pinnedOrder = 2;
  store.sync(next);
  assert.equal(store.thread(one).pinned, false);
  assert.equal(store.thread(one).pinSource, "pocket");
  assert.equal(store.thread(two).pinned, false);
  assert.equal(store.thread(two).pinSource, "pocket");
  assert.equal(store.thread(three).pinned, true);
  assert.equal(store.thread(three).pinSource, "codex");
  assert.equal(store.thread(three).pinnedOrder, 2);
  for (const thread of store.catalog().threads)
    assert.deepEqual(thread, { ...store.thread(thread.id), ...store.annotation(thread.id, thread) });
});

test("new Pocket pins lead native pins, persist after reopening, and preserve annotations and source activity", t => {
  const f = fixture(t), store = f.store;
  const before = rawSources(store);
  store.patchThread(two, { note: "keep", intent: "later", groupIds: [], expectedRevision: 0 });
  const pinTwo = store.setPin(two, { pinned: true });
  assert.equal(pinTwo.note, "keep");
  assert.equal(pinTwo.intent, "later");
  assert.deepEqual(pinTwo.groupIds, []);
  assert.equal(pinTwo.revision, 1);
  assert.equal(pinTwo.updatedAt, 2000);
  store.setPin(three, { pinned: true });
  assert.deepEqual(ordered(store), [three, two, one]);
  assert.equal(store.patchThread(two, { note: "fresh", expectedRevision: 1 }).pinned, true);
  assert.equal(store.recordOpen(two).pinnedOrder, pinTwo.pinnedOrder);
  assert.deepEqual(rawSources(store), before);
  const reopened = f.reopen();
  assert.deepEqual(ordered(reopened), [three, two, one]);
  assert.equal(reopened.annotation(two).note, "fresh");
});

test("repeating a pin target leaves order, time and backups unchanged; unpin then pin moves it first", t => {
  const { store, directory } = fixture(t);
  store.setPin(two, { pinned: true });
  store.setPin(three, { pinned: true });
  const before = store.export().pins;
  const pinRevision = store.thread(two).pinRevision;
  const backups = readdirSync(join(directory, "backups"));
  store.setPin(two, { pinned: true });
  assert.deepEqual(store.export().pins, before);
  assert.equal(store.thread(two).pinRevision, pinRevision);
  assert.deepEqual(readdirSync(join(directory, "backups")), backups);
  assert.deepEqual(ordered(store), [three, two, one]);
  store.setPin(two, { pinned: false });
  const unpinned = store.export().pins;
  store.setPin(two, { pinned: false });
  assert.deepEqual(store.export().pins, unpinned);
  store.setPin(two, { pinned: true });
  assert.deepEqual(ordered(store), [two, three, one]);
  // Explicitly selecting an inherited true value also creates a stable override.
  store.setPin(one, { pinned: true });
  assert.deepEqual(ordered(store), [one, two, three]);
});

test("pin revision is global, durable and advances only for changes including explicit restore clearing", t => {
  const f = fixture(t), store = f.store;
  assert.ok(store.catalog().threads.every(thread => thread.pinRevision === 0));
  const pinned = store.setPin(two, { pinned: true });
  assert.equal(pinned.pinRevision, 1);
  assert.ok(store.catalog().threads.every(thread => thread.pinRevision === pinned.pinRevision));
  assert.equal(store.thread(one).pinRevision, pinned.pinRevision);
  const backup = store.export();
  store.setPin(three, { pinned: true });
  const current = store.thread(two).pinRevision;
  assert.equal(current, 2);
  const same = store.export();
  // Backup object/array order has no bearing on an actual state change.
  same.pins.reverse();
  same.pins = same.pins.map(pin => ({ updated_at: pin.updated_at, position: pin.position, pinned: pin.pinned, thread_id: pin.thread_id }));
  store.restore(same);
  assert.equal(store.thread(one).pinRevision, current);
  const legacy = { ...backup };
  delete legacy.pins;
  store.restore(legacy);
  assert.equal(store.thread(one).pinRevision, current);
  store.restore(backup);
  assert.equal(store.thread(one).pinRevision, current + 1);
  store.restore({ ...backup, pins: [] });
  assert.equal(store.thread(one).pinRevision, current + 2);
  assert.equal(store.thread(two).pinned, false);
  store.restore({ ...backup, pins: [] });
  assert.equal(store.thread(one).pinRevision, current + 2);
  const reopened = f.reopen();
  assert.equal(reopened.thread(one).pinRevision, current + 2);
  assert.deepEqual(reopened.export().pins, []);
  assert.equal(reopened.setPin(two, { pinned: true }).pinRevision, current + 3);
});

test("pin revision overflow rejects a mutation and restore without changing pins or annotations", t => {
  const { store } = fixture(t);
  store.setPin(two, { pinned: true });
  store.patchThread(two, { note: "keep" });
  store.set("pinRevision", Number.MAX_SAFE_INTEGER);
  const before = store.export();
  assert.throws(() => store.setPin(three, { pinned: true }), error => error.status === 400);
  assert.deepEqual(store.export().pins, before.pins);
  assert.throws(() => store.restore({ ...before, pins: [] }), error => error.status === 400);
  assert.deepEqual(store.export().pins, before.pins);
  assert.deepEqual(store.export().annotations, before.annotations);
  assert.equal(store.thread(two).pinRevision, Number.MAX_SAFE_INTEGER);
  assert.equal(store.setPin(two, { pinned: true }).pinRevision, Number.MAX_SAFE_INTEGER);
});

test("source pin changes advance the revision once while unrelated updates and overridden pins do not", t => {
  const { store } = fixture(t);
  assert.equal(store.thread(one).pinRevision, 0);
  const next = source();
  next.threads[0].title = "New title";
  next.threads[0].updatedAt = 9000;
  store.sync(next);
  assert.equal(store.thread(one).pinRevision, 0);
  next.threads[0].pinnedOrder = 2;
  next.threads[1].pinned = true;
  next.threads[1].pinnedOrder = 0;
  store.sync(next);
  assert.equal(store.thread(one).pinRevision, 1);
  assert.equal(store.thread(one).pinSource, "codex");
  store.sync(next);
  assert.equal(store.thread(one).pinRevision, 1);
  store.setPin(one, { pinned: false });
  const localRevision = store.thread(one).pinRevision;
  next.threads[0].pinnedOrder = 0;
  store.sync(next);
  assert.equal(store.thread(one).pinRevision, localRevision);
  assert.equal(store.thread(one).pinSource, "pocket");
  assert.equal(store.thread(one).pinned, false);
  next.threads[1].pinned = false;
  store.sync(next);
  assert.equal(store.thread(two).pinRevision, localRevision + 1);
  assert.equal(store.thread(two).pinned, false);
  const before = store.catalog();
  const invalid = structuredClone(next);
  invalid.threads[1].pinned = true;
  invalid.threads.push(invalid.threads[0]);
  assert.throws(() => store.sync(invalid), /重复/);
  assert.deepEqual(store.catalog(), before);
});

test("pin metadata survives missing sources and does not alter archive state", t => {
  const { store } = fixture(t);
  store.setPin(two, { pinned: true });
  store.sync({ ...source(), threads: [] });
  assert.equal(store.thread(two).missing, true);
  assert.equal(store.thread(two).pinned, true);
  store.setPin(one, { pinned: false });
  const next = source();
  next.threads[1].archived = true;
  store.sync(next);
  assert.equal(store.thread(two).missing, false);
  assert.equal(store.thread(two).archived, true);
  assert.equal(store.thread(two).pinned, true);
  store.setPin(two, { pinned: false });
  assert.equal(store.thread(two).archived, true);
});

test("new backups round trip pin and unpin; old backups preserve overrides and explicit empty pins clears them", t => {
  const { store } = fixture(t);
  store.setPin(one, { pinned: false });
  store.setPin(two, { pinned: true });
  store.setPin(three, { pinned: true });
  const backup = store.export();
  assert.ok(backup.pins.every(pin => typeof pin.pinned === "boolean"));
  store.setPin(two, { pinned: false });
  store.restore(backup);
  assert.deepEqual(store.export().pins, backup.pins);
  assert.deepEqual(ordered(store), [three, two, one]);
  const legacy = { ...backup };
  delete legacy.pins;
  store.setPin(two, { pinned: false });
  const current = store.export().pins;
  store.restore(legacy);
  assert.deepEqual(store.export().pins, current);
  store.restore({ ...backup, pins: [] });
  assert.deepEqual(store.export().pins, []);
  assert.equal(store.thread(one).pinned, true);
  assert.equal(store.thread(one).pinSource, "codex");
  assert.equal(store.thread(two).pinned, false);
  assert.equal(store.thread(three).pinned, false);
});

test("invalid pins are rejected before restore and a failed annotation restore rolls pins back too", t => {
  const { store } = fixture(t);
  store.setPin(two, { pinned: true });
  store.patchThread(two, { note: "keep" });
  const before = store.export(), valid = before.pins[0];
  const invalidPins = [null, {}, [null], [{ ...valid, pinned: 1 }],
    [{ ...valid, position: 0 }], [{ ...valid, position: null }],
    [{ ...valid, pinned: false }], [{ ...valid, updated_at: -1 }],
    [{ ...valid, thread_id: "../elsewhere" }], [{ ...valid, extra: true }],
    [valid, valid], [valid, { ...valid, thread_id: three }]];
  for (const pins of invalidPins) {
    assert.throws(() => store.restore({ ...before, pins }), error => error.status === 400);
    assert.deepEqual(store.export().pins, before.pins);
    assert.deepEqual(store.export().annotations, before.annotations);
  }
  const bad = structuredClone(before);
  bad.pins = [];
  bad.annotations[0].revision = Number.MAX_SAFE_INTEGER;
  const pinRevision = store.thread(two).pinRevision;
  assert.throws(() => store.restore(bad), error => error.status === 400);
  assert.deepEqual(store.export().pins, before.pins);
  assert.deepEqual(store.export().annotations, before.annotations);
  assert.deepEqual(store.groups(), before.groups);
  assert.equal(store.thread(two).pinRevision, pinRevision);
  store.restore({ ...before, pins: [{ ...valid, thread_id: unknown }] });
  assert.ok(store.export().pins.some(pin => pin.thread_id === unknown));
  store.sync({ ...source(), threads: [...source().threads, { ...source().threads[1], id: unknown }] });
  assert.equal(store.thread(unknown).pinned, true);
});

test("pin HTTP endpoint enforces auth, CSRF and a strict set payload and returns effective metadata without owner calls", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-pin-http-"));
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
  const call = (input, extra = {}, id = two) => fetch(`${base}/api/tasks/${id}/pin`, {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(input),
  });
  assert.equal((await call({ pinned: true }, { Authorization: "" })).status, 401);
  assert.equal((await call({ pinned: true }, { "X-Navigator-Token": "" })).status, 403);
  assert.equal((await call({ pinned: true }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await call({ pinned: true }, { "Content-Type": "text/plain" })).status, 415);
  for (const input of [null, [], {}, { pinned: 1 }, { pinned: "true" }, { pinned: true, toggle: true }])
    assert.equal((await call(input)).status, 400);
  assert.equal((await call({ pinned: true }, {}, unknown)).status, 404);
  assert.deepEqual(app.store.export().pins, []);
  app.store.patchThread(two, { note: "kept", groupIds: [] });
  const result = await call({ pinned: true });
  assert.equal(result.status, 200);
  const thread = await result.json();
  assert.equal(thread.id, two);
  assert.equal(thread.pinned, true);
  assert.ok(thread.pinnedOrder < 0);
  assert.equal(thread.pinRevision, 1);
  assert.equal(thread.pinSource, "pocket");
  assert.equal(thread.note, "kept");
  assert.deepEqual(thread.groupIds, []);
  const pins = app.store.export().pins;
  assert.equal((await call({ pinned: true })).status, 200);
  assert.deepEqual(app.store.export().pins, pins);
  const synced = await fetch(base + "/api/sync", { method: "POST", headers, body: "{}" }).then(r => r.json());
  assert.equal(synced.threads.find(t => t.id === two).pinned, true);
  assert.equal((await call({ pinned: false })).status, 200);
  const reread = await fetch(base + "/api/catalog", { headers: auth }).then(r => r.json());
  assert.equal(reread.threads.find(t => t.id === two).pinned, false);
  assert.equal(ownerCalls, 0);
});

test("Pocket pin and unpin leave original Codex SQLite and global pin files byte-identical", t => {
  const f = fixture(t), home = mkdtempSync(join(tmpdir(), "pocket-pin-source-"));
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
  f.store.setPin(one, { pinned: false });
  f.store.sync(readCodexSource(home));
  assert.equal(f.store.thread(one).pinned, false);
  assert.equal(readCodexSource(home).threads[0].pinned, true);
  f.store.setPin(one, { pinned: true });
  assert.ok(f.store.thread(one).pinnedOrder < 0);
  assert.deepEqual(hashes(), before);
});

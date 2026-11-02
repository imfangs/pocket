import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { NavigatorStore } from "../server/store.mjs";
import { makeApp } from "../server/index.mjs";
import { readCodexSource } from "../server/source.mjs";
import worker from "../edge/worker.mjs";

const one = "11111111-1111-7111-8111-111111111111";
const two = "22222222-2222-7222-8222-222222222222";
const unknown = "44444444-4444-7444-8444-444444444444";
const source = () => ({
  threads: [one, two].map((id, index) => ({ id, hostId: "local", title: `Hidden fixture ${index}`, cwd: "/sample",
    projectId: "project", pinned: index === 0, pinnedOrder: index === 0 ? 0 : -1,
    updatedAt: 3000 - index * 1000, createdAt: 1000, lastMessageAt: 2000,
    archived: false, separator: false })),
  projects: [{ id: "project", name: "Fixture" }], sourceInfo: { scope: "synthetic" },
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pocket-hidden-"));
  let store = new NavigatorStore(directory); store.sync(source());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, reopen() { store.close(); store = new NavigatorStore(directory); return store; } };
}
const projection = thread => ({ pocketHidden: thread.pocketHidden, hiddenRevision: thread.hiddenRevision });
const sourceRows = store => store.db.prepare("SELECT * FROM source_threads ORDER BY id").all();
const backups = directory => existsSync(join(directory, "backups")) ? readdirSync(join(directory, "backups")) : [];

test("hiding is independent Pocket metadata and catalog retains the complete conversation", t => {
  const { store } = fixture(t);
  store.patchThread(one, { note: "keep", intent: "later", groupIds: [], expectedRevision: 0 });
  store.setPriority(one, { priority: true });
  const before = store.thread(one), native = sourceRows(store), annotations = store.export().annotations;
  const hidden = store.setHidden(one, { hidden: true });
  assert.deepEqual(projection(before), { pocketHidden: false, hiddenRevision: 0 });
  assert.deepEqual(hidden, { ...before, ...store.annotation(one, before), pocketHidden: true, hiddenRevision: 1 });
  assert.deepEqual(sourceRows(store), native);
  assert.deepEqual(store.export().annotations, annotations);
  assert.equal(store.thread(one).pinRevision, before.pinRevision);
  assert.equal(store.thread(one).titleRevision, before.titleRevision);
  assert.equal(store.catalog().threads.length, 2);
  assert.deepEqual(store.catalog().threads.find(thread => thread.id === one), hidden);
  assert.equal(store.thread(two).hiddenRevision, 1);
  assert.equal(store.thread(two).pocketHidden, false);
  assert.equal(store.setHidden(one, { hidden: false }).archived, false);
  assert.equal(store.thread(one).hiddenRevision, 2);
});

test("explicit hidden sets are idempotent without backup, timestamp or revision churn", t => {
  const { store, directory } = fixture(t);
  store.setHidden(one, { hidden: false });
  assert.deepEqual(store.hiddenThreads(), []); assert.deepEqual(backups(directory), []);
  for (const hidden of [true, false]) {
    const result = store.setHidden(one, { hidden });
    const rows = store.hiddenThreads(), files = backups(directory);
    assert.deepEqual(store.setHidden(one, { hidden }), result);
    assert.deepEqual(store.hiddenThreads(), rows); assert.deepEqual(backups(directory), files);
  }
  assert.equal(store.thread(one).hiddenRevision, 2);
});

test("hidden state survives sync, source absence, archival, reopen and a legacy database", t => {
  const f = fixture(t), store = f.store;
  // Reopening a database created before hidden_threads existed only adds the new table.
  store.db.exec("DROP TABLE hidden_threads");
  const migrated = f.reopen();
  assert.deepEqual(projection(migrated.thread(one)), { pocketHidden: false, hiddenRevision: 0 });
  migrated.setHidden(one, { hidden: true });
  const next = source(); next.threads[0].title = "Renamed in Codex"; next.threads[0].archived = true;
  next.threads[0].pinned = false; migrated.sync(next);
  assert.equal(migrated.thread(one).title, "Renamed in Codex");
  assert.equal(migrated.thread(one).archived, true); assert.equal(migrated.thread(one).pocketHidden, true);
  assert.equal(migrated.thread(one).hiddenRevision, 1);
  migrated.sync({ ...next, threads: [] });
  assert.equal(migrated.thread(one).missing, true); assert.equal(migrated.thread(one).pocketHidden, true);
  const reopened = f.reopen();
  assert.deepEqual(projection(reopened.thread(one)), { pocketHidden: true, hiddenRevision: 1 });
  assert.equal(reopened.setHidden(one, { hidden: false }).archived, true);
  const another = fixture(t).store;
  assert.deepEqual(projection(another.thread(one)), { pocketHidden: false, hiddenRevision: 0 });
});

test("source and annotation projections cannot forge visibility, and native exclusions remain independent", t => {
  const { store } = fixture(t), forged = source();
  forged.threads[0].pocketHidden = true; forged.threads[0].hiddenRevision = 999;
  store.sync(forged);
  assert.deepEqual(projection(store.thread(one)), { pocketHidden: false, hiddenRevision: 0 });
  assert.throws(() => store.patchThread(one, { pocketHidden: true }), error => error.status === 400);
  store.setHidden(one, { hidden: true });
  store.sync({ ...source(), threads: source().threads.slice(1), excludedThreadIds: [one], excludedThreadStates: [{ id: one, archived: true }] });
  const unhidden = store.setHidden(one, { hidden: false });
  assert.equal(unhidden.sourceExcluded, true); assert.equal(unhidden.archived, true);
  assert.ok(!store.catalog().threads.some(thread => thread.id === one));
});

test("hidden backup is optional, round trips and never resets the local revision", t => {
  const { store } = fixture(t);
  store.setHidden(one, { hidden: true }); store.setHidden(two, { hidden: true }); store.setHidden(two, { hidden: false });
  const backup = store.export();
  assert.equal(backup.version, 1); assert.ok(backup.hiddenThreads.every(entry => typeof entry.hidden === "boolean"));
  assert.ok(backup.hiddenThreads.every(entry => Object.keys(entry).sort().join() === "hidden,thread_id,updated_at"));
  const revision = store.thread(one).hiddenRevision;
  store.restore(backup);
  assert.equal(store.thread(one).hiddenRevision, revision, "same hidden rows do not advance visibility revision");
  store.setHidden(one, { hidden: false });
  const beforeRestore = store.thread(one).hiddenRevision;
  store.restore({ ...backup, hiddenRevision: 0 });
  assert.equal(store.thread(one).pocketHidden, true);
  assert.equal(store.thread(one).hiddenRevision, beforeRestore + 1);
  assert.deepEqual(store.export().hiddenThreads, backup.hiddenThreads);
  const legacy = { ...backup }; delete legacy.hiddenThreads;
  store.restore(legacy);
  assert.equal(store.thread(one).pocketHidden, true);
  assert.equal(store.thread(one).hiddenRevision, beforeRestore + 1);
  store.restore({ ...backup, hiddenThreads: [] });
  assert.deepEqual(store.hiddenThreads(), []);
  assert.equal(store.thread(one).pocketHidden, false);
  assert.equal(store.thread(one).hiddenRevision, beforeRestore + 2);
  // Preferences can be recovered before the corresponding source becomes available.
  store.restore({ ...backup, hiddenThreads: [{ thread_id: unknown, hidden: true, updated_at: 0 }] });
  store.sync({ ...source(), threads: [...source().threads, { ...source().threads[0], id: unknown }] });
  assert.equal(store.thread(unknown).pocketHidden, true);
});

test("invalid input, malformed backup and overflow cannot partially mutate visibility", t => {
  const { store } = fixture(t);
  for (const input of [null, [], {}, { hidden: 1 }, { hidden: "true" }, { hidden: true, archived: true }])
    assert.throws(() => store.setHidden(one, input), error => error.status === 400);
  assert.throws(() => store.setHidden(unknown, { hidden: true }), error => error.status === 404);
  store.setHidden(one, { hidden: true });
  const backup = store.export(), valid = backup.hiddenThreads[0];
  for (const hiddenThreads of [null, {}, [null], [valid, valid], [{ ...valid, hidden: 1 }],
    [{ ...valid, thread_id: "bad/id" }], [{ ...valid, updated_at: -1 }], [{ ...valid, hiddenRevision: 5 }]]) {
    assert.throws(() => store.restore({ ...backup, hiddenThreads }), error => error.status === 400);
    assert.deepEqual(store.hiddenThreads(), backup.hiddenThreads);
    assert.deepEqual(store.export().annotations, backup.annotations);
  }
  store.set("hiddenRevision", Number.MAX_SAFE_INTEGER);
  assert.throws(() => store.setHidden(two, { hidden: true }), error => error.status === 400);
  assert.deepEqual(store.hiddenThreads(), backup.hiddenThreads);
  assert.equal(store.setHidden(one, { hidden: true }).hiddenRevision, Number.MAX_SAFE_INTEGER);
  assert.throws(() => store.restore({ ...backup, hiddenThreads: [] }), error => error.status === 400);
  assert.deepEqual(store.hiddenThreads(), backup.hiddenThreads);
  assert.deepEqual(store.export().annotations, backup.annotations);
});

test("hidden endpoint requires auth and CSRF, preserves queued data and never calls a native owner", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pocket-hidden-http-"));
  let ownerCalls = 0;
  const app = makeApp({ dataDir: directory, codexHome: directory, readSource: source,
    desktopRequest: async () => { ownerCalls++; return { ok: false }; }, openThread: async () => { ownerCalls++; } });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await fetch(base + "/api/catalog", { headers: auth }).then(response => response.json());
  const headers = { ...auth, Origin: base, "Content-Type": "application/json", "X-Navigator-Token": catalog.csrfToken };
  const call = (input, extra = {}, id = one) => fetch(`${base}/api/tasks/${id}/hidden`, {
    method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(input) });
  assert.equal((await call({ hidden: true }, { Authorization: "" })).status, 401);
  assert.equal((await call({ hidden: true }, { "X-Navigator-Token": "" })).status, 403);
  assert.equal((await call({ hidden: true }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await call({ hidden: true }, { "Content-Type": "text/plain" })).status, 415);
  for (const input of [null, [], {}, { hidden: 1 }, { hidden: "true" }, { hidden: true, toggle: true }, { hidden: true, scope: null }])
    assert.equal((await call(input)).status, 400);
  assert.equal((await call({ hidden: true, scope: "other-source" })).status, 409);
  assert.equal(app.store.thread(one).pocketHidden, false);
  assert.equal(app.store.thread(one).hiddenRevision, 0);
  assert.equal((await call({ hidden: true }, {}, unknown)).status, 404);
  app.store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,'unknown',?)").run("kept-query", one, "synthetic", 1);
  app.store.db.prepare("INSERT INTO outgoing_messages(id,thread_id,text,revision) VALUES(?,?,?,?)").run("kept-query", one, "Keep the unknown query", 2);
  const queue = () => [app.store.db.prepare("SELECT * FROM dispatches").all(), app.store.db.prepare("SELECT * FROM outgoing_messages").all()];
  const before = queue();
  for (const hidden of [true, false]) {
    const response = await call({ hidden, scope: catalog.sourceInfo.pocketRead.scope }); assert.equal(response.status, 200);
    const thread = await response.json(); assert.equal(thread.pocketHidden, hidden); assert.equal(thread.archived, false);
    assert.equal(thread.visibilityScope, catalog.sourceInfo.pocketRead.scope);
    assert.ok(Number.isSafeInteger(thread.hiddenRevision));
    const reread = await fetch(base + "/api/catalog", { headers: auth }).then(value => value.json());
    assert.deepEqual(projection(reread.threads.find(value => value.id === one)), projection(thread));
    assert.deepEqual(queue(), before);
  }
  assert.equal(ownerCalls, 0);
});

test("hiding leaves original Codex SQLite and global state byte-identical", t => {
  const f = fixture(t), home = mkdtempSync(join(tmpdir(), "pocket-hidden-source-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const database = join(home, "state_5.sqlite"), globals = join(home, ".codex-global-state.json");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,source TEXT)");
  db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?)").run(one, "Original", "/sample", 0, 1, 2, "app"); db.close();
  writeFileSync(globals, JSON.stringify({ "pinned-thread-ids": [one] }));
  const hash = () => [database, globals].map(path => createHash("sha256").update(readFileSync(path)).digest("hex"));
  const before = hash(); f.store.sync(readCodexSource(home));
  for (const hidden of [true, false]) { f.store.setHidden(one, { hidden }); f.store.sync(readCodexSource(home)); }
  assert.deepEqual(hash(), before);
});

test("the existing gateway preserves explicit hidden state and same-origin session headers", async () => {
  const original = globalThis.fetch; let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options, body: await new Response(options.body).text() };
    return new Response(JSON.stringify({ pocketHidden: true, hiddenRevision: 1 }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request(`https://x.fangs.cc/api/tasks/${one}/hidden`, {
      method: "POST", headers: { Origin: "https://x.fangs.cc", "Content-Type": "application/json", Cookie: "navigator_session=fixture", "X-Navigator-Token": "fixture-csrf" },
      body: '{"hidden":true}',
    }), { NAVIGATOR_CONNECTION: { get: async () => ({ connected: true, publicOrigin: "https://sample.trycloudflare.com" }) } });
    assert.equal(response.status, 200); assert.equal(seen.url, `https://sample.trycloudflare.com/api/tasks/${one}/hidden`);
    assert.equal(seen.options.headers.get("Cookie"), "navigator_session=fixture");
    assert.equal(seen.options.headers.get("X-Navigator-Token"), "fixture-csrf"); assert.equal(seen.body, '{"hidden":true}');
  } finally { globalThis.fetch = original; }
});

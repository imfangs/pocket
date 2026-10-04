import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readCodexSource } from "../server/source.mjs";
import { NavigatorStore } from "../server/store.mjs";
import { makeApp } from "../server/index.mjs";
const id1 = "11111111-1111-7111-8111-111111111111",
  id2 = "22222222-2222-7222-8222-222222222222";
const thread = (id, title) => ({
  id,
  title,
  hostId: "local",
  cwd: "/sample",
  projectId: "project",
  projectName: "Sample",
  archived: false,
  pinned: false,
  pinnedOrder: -1,
  separator: false,
  source: "vscode",
  createdAt: 1000,
  updatedAt: 2000,
  branch: null,
});
const source = () => ({
  threads: [thread(id1, "示例任务一"), thread(id2, "示例任务二")],
  projects: [
    {
      id: "project",
      name: "Sample",
      paths: ["/sample"],
      order: 0,
      separator: false,
    },
  ],
  sourceInfo: { syncedAt: Date.now(), scope: "synthetic", total: 2 },
});
function temp(t) {
  const p = mkdtempSync(join(tmpdir(), "navigator-test-"));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
function storeFor(t) {
  const s = new NavigatorStore(temp(t));
  t.after(() => s.close());
  s.sync(source());
  return s;
}
test("source import resolves desktop identity and pins, prefers renamed title, never writes source", (t) => {
  const home = temp(t),
    file = join(home, "state_5.sqlite"),
    db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,source TEXT,name TEXT,thread_source TEXT,agent_path TEXT,project_id TEXT);`,
  );
  const insert = db.prepare(
    "INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    id1,
    "old prompt",
    "/different",
    0,
    1,
    2,
    "vscode",
    "当前名称",
    "user",
    null,
    null,
  );
  insert.run(
    id2,
    "child",
    "/sample",
    0,
    1,
    2,
    "vscode",
    "child",
    "subagent",
    "/root/review",
    null,
  );
  db.close();
  const global = {
    "local-projects": {
      project: { id: "project", name: "Sample", rootPaths: ["/sample"] },
    },
    "project-order": ["project"],
    "pinned-thread-ids": [id1],
    "thread-project-assignments": {
      [id1]: { projectKind: "local", projectId: "project" },
    },
  };
  writeFileSync(join(home, ".codex-global-state.json"), JSON.stringify(global));
  const hash = () =>
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    before = hash();
  const s = readCodexSource(home);
  assert.equal(s.threads.length, 1);
  assert.equal(s.threads[0].title, "当前名称");
  assert.equal(s.threads[0].pinned, true);
  assert.equal(s.threads[0].projectId, "project");
  assert.equal(s.threads[0].cwd, "/different");
  assert.equal(s.threads[0].updatedAt, 2000);
  assert.equal(hash(), before);
});
test("recent activity follows updated timestamps even when native recency stays hours behind", t => {
  const home=temp(t), db=new DatabaseSync(join(home,'state_5.sqlite'));
  t.after(()=>db.close());
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,source TEXT,recency_at_ms INTEGER,updated_at_ms INTEGER)');
  const insert=db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)');
  insert.run(id1,'Active task','/sample',0,1,100,'app',1000,100500);
  insert.run(id2,'Legacy task','/sample',0,1,200,'app',1000,null);
  writeFileSync(join(home,'.codex-global-state.json'),JSON.stringify({'pinned-thread-ids':[]}));
  const read=()=>readCodexSource(home).threads;
  assert.equal(read().find(t=>t.id===id1).updatedAt,100500);
  assert.equal(read().find(t=>t.id===id2).updatedAt,200000);
  db.prepare('UPDATE threads SET updated_at_ms=? WHERE id=?').run(500000,id1);
  const store=new NavigatorStore(temp(t));t.after(()=>store.close());
  store.sync(readCodexSource(home));
  assert.equal(store.catalog().threads.find(t=>t.id===id1).updatedAt,500000);
});
test("sync preserves user intent and notes, retains absent source and restores it on reappearance", (t) => {
  const s = storeFor(t);
  s.patchThread(id1, {
    intent: "later",
    note: "下次从这里继续",
    reviewAt: "2026-10-01",
    groupIds: [],
    expectedRevision: 0,
  });
  const next = source();
  next.threads[0].title = "新的原版标题";
  s.sync(next);
  let one = s.catalog().threads.find((t) => t.id === id1);
  assert.equal(one.note, "下次从这里继续");
  assert.equal(one.title, "新的原版标题");
  assert.deepEqual(one.groupIds, []);
  s.sync({ ...next, threads: [] });
  assert.equal(s.catalog().threads[0].missing, true);
  s.failSync(new Error("source unavailable"));
  assert.equal(s.catalog().threads.length, 2);
  assert.match(s.catalog().sourceError, /unavailable/);
  s.sync(next);
  assert.equal(s.catalog().threads[0].missing, false);
  assert.equal(s.catalog().sourceError, null);
});
test("conflicting editor revisions cannot overwrite a newer note", (t) => {
  const s = storeFor(t);
  s.patchThread(id1, { note: "first", expectedRevision: 0 });
  assert.throws(
    () => s.patchThread(id1, { note: "stale", expectedRevision: 0 }),
    (e) => e.status === 409,
  );
  assert.equal(s.annotation(id1).note, "first");
  assert.throws(() => s.patchThread(id1, { archived: true }), /未知字段/);
  assert.throws(() => s.patchThread(id1, { reviewAt: "2026-02-31" }), /日期/);
});
test("a manual group never captures all projectless threads through null equality", (t) => {
  const s = storeFor(t);
  const data = source();
  data.threads[0].projectId = null;
  s.sync(data);
  s.saveGroup({ name: "手动集合" });
  assert.deepEqual(s.catalog().threads.find((t) => t.id === id1).groupIds, []);
  assert.equal(
    s.catalog().threads.find((t) => t.id === id2).groupIds.length,
    1,
  );
});
test("groups reject cycles, deletion retains nested groups and task notes", (t) => {
  const s = storeFor(t),
    parent = s.groups()[0],
    child = s.saveGroup({ name: "child", parentId: parent.id });
  assert.throws(
    () => s.saveGroup({ parentId: child.id }, parent.id),
    /自身或子分组/,
  );
  s.patchThread(id1, { note: "keep", groupIds: [parent.id, child.id] });
  s.deleteGroup(parent.id);
  assert.equal(s.groups()[0].parentId, null);
  assert.equal(s.annotation(id1).note, "keep");
  assert.deepEqual(s.annotation(id1).groupIds, [child.id]);
  s.sync(source());
  assert.equal(s.groups().length, 1); // A deleted source group is not silently recreated.
});
test("batch is atomic, and backup restore survives reopening", (t) => {
  const p = temp(t),
    s = new NavigatorStore(p);
  s.sync(source());
  assert.throws(() => s.batch([id1, "missing"], { intent: "later" }), /找不到/);
  assert.equal(s.annotation(id1).intent, "none");
  s.batch([id1, id2], { intent: "later" });
  s.patchThread(id1, { note: "persist" });
  const backup = s.export();
  s.patchThread(id1, { note: "changed" });
  s.restore(backup);
  assert.equal(s.annotation(id1).note, "persist");
  const bad = structuredClone(backup);
  bad.groups[0].parentId = bad.groups[0].id;
  assert.throws(() => s.restore(bad), /层级/);
  s.close();
  const reopened = new NavigatorStore(p);
  assert.equal(reopened.annotation(id1).note, "persist");
  reopened.close();
});
test("restore revisions reject editors opened before restoring an older backup", (t) => {
  const s = storeFor(t);
  s.patchThread(id1, { note: "saved in backup", expectedRevision: 0 });
  const backup = s.export();
  const stale = s.patchThread(id1, { note: "newer local note", expectedRevision: 1 });
  s.restore(backup);
  assert.equal(s.annotation(id1).note, "saved in backup");
  assert.ok(s.annotation(id1).revision > stale.revision);
  assert.throws(
    () => s.patchThread(id1, { note: "stale overwrite", expectedRevision: stale.revision }),
    (e) => e.status === 409,
  );
  const restored = s.annotation(id1);
  s.patchThread(id1, { note: "fresh edit", expectedRevision: restored.revision });
  assert.equal(s.annotation(id1).note, "fresh edit");
});
test("restore keeps revisions for omitted annotations and formerly implicit defaults", (t) => {
  const s = storeFor(t);
  const backup = s.export();
  const stale = s.patchThread(id1, { note: "not in the backup", groupIds: [] });
  const defaultRevision = s.annotation(id2).revision;
  s.restore(backup);
  for (const [id, revision] of [[id1, stale.revision], [id2, defaultRevision]]) {
    const restored = s.annotation(id, s.thread(id));
    assert.equal(restored.note, "");
    assert.deepEqual(restored.groupIds, [backup.groups[0].id]);
    assert.ok(restored.revision > revision);
    assert.throws(
      () => s.patchThread(id, { note: "stale overwrite", expectedRevision: revision }),
      (e) => e.status === 409,
    );
  }
});
test("restore advances imported revisions and rolls back when they cannot advance safely", (t) => {
  const s = storeFor(t);
  s.patchThread(id1, { note: "original" });
  const backup = s.export();
  backup.annotations[0].revision = 100;
  s.restore(backup);
  assert.equal(s.annotation(id1).revision, 101);
  const before = s.export();
  backup.annotations[0].revision = Number.MAX_SAFE_INTEGER;
  assert.throws(() => s.restore(backup), (e) => e.status === 400);
  assert.deepEqual(s.groups(), before.groups);
  assert.deepEqual(s.export().annotations, before.annotations);
});
test("HTTP requires same origin and token, opens the exact known original id, never creates a new thread", async (t) => {
  const p = temp(t);
  mkdirSync(join(p, "dist"));
  writeFileSync(join(p, "dist/index.html"), "<html>synthetic</html>");
  const opens = [];
  const { server, store, auth } = makeApp({
    dataDir: join(p, "data"),
    dist: join(p, "dist"),
    readSource: source,
    openThread: async (id) => opens.push(id),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const localAuthorization = { Authorization: `Bearer ${auth.localToken}` };
  const c = await fetch(origin + "/api/catalog", {
    headers: localAuthorization,
  }).then((r) => r.json());
  let r = await fetch(origin + `/api/tasks/${id1}`, {
    method: "PATCH",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/json",
      "X-Navigator-Token": c.csrfToken,
    },
    body: "{}",
  });
  assert.equal(r.status, 403);
  r = await fetch(origin + `/api/tasks/${id1}`, {
    method: "PATCH",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 403);
  const headers = {
    ...localAuthorization,
    Origin: origin,
    "Content-Type": "application/json",
    "X-Navigator-Token": c.csrfToken,
  };
  r = await fetch(origin + `/api/tasks/${id1}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ intent: "later", note: "verified" }),
  });
  assert.equal(r.status, 200);
  assert.equal(store.annotation(id1).note, "verified");
  r = await fetch(origin + `/api/open/${id1}`, { method: "POST", headers });
  assert.equal(r.status, 200);
  assert.deepEqual(opens, [id1]);
  assert.equal((await r.json()).status, "handoff_requested");
  r = await fetch(origin + "/api/open/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", {
    method: "POST",
    headers,
  });
  assert.equal(r.status, 404);
  assert.equal(opens.length, 1);
  r = await fetch(origin + "/api/health", {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(r.status, 403);
});

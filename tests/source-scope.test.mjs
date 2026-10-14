import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readCodexSource } from "../server/source.mjs";

function fixture(t, { legacy = false, global = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pocket-source-scope-"));
  const database = join(home, "state_5.sqlite");
  const globalPath = join(home, ".codex-global-state.json");
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT, cwd TEXT, archived INTEGER,
    created_at INTEGER, updated_at INTEGER, source TEXT
    ${legacy ? "" : ", thread_source TEXT, agent_path TEXT, project_id TEXT"}
  )`);
  writeFileSync(globalPath, JSON.stringify({ "pinned-thread-ids": [], ...global }));
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  function add(id, fields = {}) {
    const row = { id, title: "普通会话", cwd: "/sample", archived: 0,
      created_at: 1, updated_at: 2, source: "vscode",
      ...(!legacy && { thread_source: null, agent_path: null, project_id: null }), ...fields };
    const names = Object.keys(row);
    db.prepare(`INSERT INTO threads (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
      .run(...Object.values(row));
  }
  return { home, db, add, globalPath,
    read: () => readCodexSource(home),
    hashes: () => [database, globalPath].map(path => createHash("sha256").update(readFileSync(path)).digest("hex")) };
}

test("background exec tasks are excluded by provenance, including six parallel topic jobs, without archiving them", t => {
  const f = fixture(t, { global: { "pinned-thread-ids": ["exec-0"] } });
  const longTitle = "你是六个并行选题会话之一，专责测试选题。".repeat(20);
  for (let i = 0; i < 6; i++) f.add(`exec-${i}`, { source: "exec", thread_source: "user", title: longTitle });
  f.add("ordinary-long-title", { title: longTitle, thread_source: "user" });
  const before = f.hashes();
  const result = f.read();
  assert.deepEqual(result.threads.map(row => row.id), ["ordinary-long-title"]);
  assert.deepEqual(new Set(result.excludedThreadIds), new Set(Array.from({ length: 6 }, (_, i) => `exec-${i}`)));
  assert.deepEqual(result.excludedThreadStates, result.excludedThreadIds.map(id => ({ id, archived: false })));
  assert.equal(result.sourceInfo.excludedBackground, 6);
  assert.equal(result.sourceInfo.excludedTotal, 6);
  assert.equal(result.sourceInfo.active, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM threads WHERE archived=0").get().count, 7);
  assert.deepEqual(f.hashes(), before);
});

test("ordinary app, cli and vscode roots and a new empty Pocket thread remain available without a desktop catalog", t => {
  const f = fixture(t);
  f.add("app-root", { source: "app", thread_source: "user", agent_path: "/root" });
  f.add("cli-root", { source: "cli", agent_path: "/root" });
  f.add("pocket-empty", { title: "", source: "vscode" });
  f.add("automation", { thread_source: "automation" });
  f.add("agent-created", { thread_source: "agent_created_thread" });
  f.add("archived-root", { archived: 1 });
  const result = f.read();
  assert.deepEqual(result.threads.map(row => row.id), ["app-root", "cli-root", "pocket-empty", "automation", "agent-created", "archived-root"]);
  assert.equal(result.threads.find(row => row.id === "pocket-empty").title, "未命名会话");
  assert.equal(result.threads.find(row => row.id === "archived-root").archived, true);
  assert.equal(result.sourceInfo.active, 5);
  assert.equal(result.sourceInfo.archived, 1);
  assert.deepEqual(result.excludedThreadIds, []);
  assert.deepEqual(result.excludedThreadStates, []);
});

test("excluded archive facts match the current source and correspond exactly to every excluded identity", t => {
  const f = fixture(t);
  f.add("active-background", { source: "exec", archived: 0 });
  f.add("archived-background", { source: "exec", archived: 1 });
  f.add("archived-hidden", { thread_source: "chatgpt_hidden", archived: 1 });
  f.add("active-child", { thread_source: "subagent", archived: 0 });
  f.add("archived-other", { source: "unknown", archived: 1 });
  f.add("visible", { archived: 1 });
  const before = f.read();
  const expected = [
    { id: "active-background", archived: false },
    { id: "archived-background", archived: true },
    { id: "archived-hidden", archived: true },
    { id: "active-child", archived: false },
    { id: "archived-other", archived: true },
  ];
  assert.deepEqual(before.excludedThreadStates, expected);
  assert.deepEqual(before.excludedThreadIds, before.excludedThreadStates.map(state => state.id));
  f.db.prepare("UPDATE threads SET archived=? WHERE id=?").run(1, "active-background");
  f.db.prepare("UPDATE threads SET archived=? WHERE id=?").run(0, "archived-background");
  const after = f.read();
  assert.deepEqual(after.excludedThreadStates, expected.map(state => ({ ...state,
    archived: state.id === "active-background" ? true : state.id === "archived-background" ? false : state.archived })));
  assert.deepEqual(after.excludedThreadIds, after.excludedThreadStates.map(state => state.id));
  assert.deepEqual(before.excludedThreadStates, expected);
});

test("invalid excluded archive flags fail the entire read rather than invent an archive fact", t => {
  const f = fixture(t);
  f.add("good-excluded", { source: "exec", archived: 1 });
  f.add("bad-excluded", { source: "exec", archived: null });
  for (const archived of [null, 2, -1]) {
    f.db.prepare("UPDATE threads SET archived=? WHERE id=?").run(archived, "bad-excluded");
    let result;
    assert.throws(() => { result = f.read(); }, /threads.archived/);
    assert.equal(result, undefined);
  }
});

test("desktop hidden thread types are excluded for both active and archived rows while ordinary names are preserved", t => {
  const f = fixture(t);
  const hidden = ["chatgpt_hidden", "ambient_suggestions", "pull_request_fix_automation"];
  for (const [i, kind] of hidden.entries()) f.add(kind, { thread_source: kind, archived: i % 2 });
  f.add("visible", { title: "ambient_suggestions", thread_source: "ambient_suggestion_task" });
  const result = f.read();
  assert.deepEqual(result.threads.map(row => row.id), ["visible"]);
  assert.deepEqual(new Set(result.excludedThreadIds), new Set(hidden));
  assert.equal(result.sourceInfo.excludedHidden, 3);
  assert.equal(result.sourceInfo.excludedTotal, 3);
});

test("native spawn edges exclude unmarked children together with legacy subagent markers, but never their parent", t => {
  const f = fixture(t);
  f.db.exec("CREATE TABLE thread_spawn_edges(parent_thread_id TEXT NOT NULL, child_thread_id TEXT PRIMARY KEY, status TEXT)");
  f.add("parent");
  f.add("edge-child");
  f.add("flag-child", { thread_source: "subagent", archived: 1 });
  f.add("path-child", { agent_path: "/root/review" });
  f.add("duplicate-reasons", { source: "exec", thread_source: "subagent", agent_path: "/root/child" });
  f.db.prepare("INSERT INTO thread_spawn_edges VALUES(?,?,?)").run("parent", "edge-child", "completed");
  f.db.prepare("INSERT INTO thread_spawn_edges VALUES(?,?,?)").run("parent", "not-in-source", "completed");
  const result = f.read();
  assert.deepEqual(result.threads.map(row => row.id), ["parent"]);
  assert.deepEqual(new Set(result.excludedThreadIds), new Set(["edge-child", "flag-child", "path-child", "duplicate-reasons"]));
  assert.equal(result.sourceInfo.excludedChildren, 4);
  assert.equal(result.sourceInfo.excludedTotal, 4);
});

test("exclusion IDs cover the full source snapshot, including unsupported sources omitted by the old SQL query", t => {
  const f = fixture(t);
  f.add("normal");
  f.add("structured-child", { source: '{"subagent":{"thread_spawn":{}}}', thread_source: "subagent" });
  f.add("guardian", { source: '{"subagent":{"other":"guardian"}}', thread_source: "guardian_review" });
  f.add("unknown-source", { source: "unknown", archived: 1 });
  const result = f.read();
  assert.deepEqual(result.threads.map(row => row.id), ["normal"]);
  assert.deepEqual(new Set(result.excludedThreadIds), new Set(["structured-child", "guardian", "unknown-source"]));
  assert.equal(result.sourceInfo.excludedChildren, 1);
  assert.equal(result.sourceInfo.excludedSources, 2);
  assert.equal(result.sourceInfo.excludedTotal, 3);
});

test("legacy source schemas without spawn edges or optional provenance columns still preserve ordinary roots", t => {
  const f = fixture(t, { legacy: true });
  f.add("root");
  f.add("background", { source: "exec" });
  const result = f.read();
  assert.deepEqual(result.threads.map(row => row.id), ["root"]);
  assert.deepEqual(result.excludedThreadIds, ["background"]);
});

test("an existing but incompatible spawn-edge table fails the complete sync without publishing partial exclusions", t => {
  const f = fixture(t);
  f.add("root");
  f.add("background", { source: "exec" });
  const published = f.read();
  f.db.exec("CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, renamed_child_id TEXT)");
  let next;
  assert.throws(() => { next = f.read(); }, /thread_spawn_edges.*child_thread_id/);
  assert.equal(next, undefined);
  assert.deepEqual(published.threads.map(row => row.id), ["root"]);
  assert.deepEqual(published.excludedThreadIds, ["background"]);
});

test("invalid native child identities fail closed instead of silently exposing possible children", t => {
  const f = fixture(t);
  f.add("root");
  f.db.exec("CREATE TABLE thread_spawn_edges(child_thread_id TEXT)");
  for (const bad of [null, "", " "]) {
    f.db.prepare("INSERT INTO thread_spawn_edges VALUES(?)").run(bad);
    assert.throws(f.read, /thread_spawn_edges.*child_thread_id/);
    f.db.exec("DELETE FROM thread_spawn_edges");
  }
});

test("unreadable source metadata yields no result or partial exclusion list", t => {
  const f = fixture(t);
  f.add("root");
  f.add("background", { source: "exec" });
  writeFileSync(f.globalPath, JSON.stringify({ "pinned-thread-ids": null }));
  let result;
  assert.throws(() => { result = f.read(); }, /置顶列表/);
  assert.equal(result, undefined);
});

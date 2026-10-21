import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NavigatorStore } from "../server/store.mjs";
import { DesktopService } from "../server/desktop.mjs";
import { LifecycleService } from "../server/lifecycle.mjs";
import { TaskStatusService } from "../server/task-statuses.mjs";
import { filterThreads, preserveOpenThread } from "../src/model.ts";
import { needsUserInput, smartThreadScore } from "../src/smartOrder.ts";
import { projectNavigationItems } from "../src/projectNavigation.ts";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const thread = (key, extra = {}) => ({
  id: key, title: key, cwd: "/fixture", projectId: null, projectName: "无项目",
  source: "exec", archived: false, pinned: false, pinnedOrder: -1, separator: false,
  createdAt: 1000, updatedAt: 2000, lastMessageAt: 2000, missing: false,
  ...extra,
});
const source = (threads = [thread(id), thread(other)], extra = {}) => ({
  threads, projects: [], sourceInfo: { syncedAt: 10000 }, ...extra,
});
const catalog = (threads, extra = {}) => ({
  ...source(threads), groups: [], sourceError: null, ...extra,
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pocket-source-exclusion-"));
  const store = new NavigatorStore(directory);
  store.sync(source());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}

test("explicit exclusions remove cached exec rows without inventing missing or archived state", t => {
  const { store } = fixture(t);
  const before = store.thread(id);
  store.sync(source([thread(other)], { excludedThreadIds: [id, "never-imported"] }));
  assert.deepEqual(store.thread(id), { ...before, sourceExcluded: true });
  assert.deepEqual(store.catalog().threads.map(row => row.id), [other]);
  assert.deepEqual(store.catalog().excludedThreadIds, [id]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM source_threads").get().count, 2);
  assert.equal(filterThreads(store.catalog().threads, "archived", "", "", "smart").length, 0);
});

test("ordinary missing records and failed reads retain their separate recovery behavior", t => {
  const { store } = fixture(t);
  store.sync(source([], { excludedThreadIds: [id] }));
  assert.equal(store.thread(id).sourceExcluded, true);
  assert.equal(store.thread(id).missing, false);
  assert.equal(store.thread(other).missing, true);
  assert.deepEqual(store.catalog().threads.map(row => row.id), [other]);
  const saved = store.catalog();
  store.failSync(new Error("source unavailable"));
  assert.deepEqual(store.catalog(), { ...saved, sourceError: "source unavailable" });
  store.sync(source([]));
  assert.equal(store.thread(id).sourceExcluded, true, "absence cannot undo a known exclusion");
  assert.equal(store.thread(id).missing, true);
  assert.deepEqual(store.catalog().threads.map(row => row.id), [other]);
});

test("excluded rows track authoritative archive changes while retaining metadata and staying outside lists", t => {
  const { store } = fixture(t);
  store.patchThread(id, { expectedRevision: 0, note: "保留说明" }, false);
  store.setPin(id, { pinned: true });
  const original = store.thread(id), annotation = store.annotation(id), pins = store.pins();
  for (const archived of [true, false]) {
    store.sync(source([thread(other)], {
      excludedThreadIds: [id], excludedThreadStates: [{ id, archived }],
    }));
    assert.deepEqual(store.thread(id), { ...original, archived, sourceExcluded: true });
    assert.deepEqual(store.annotation(id), annotation);
    assert.deepEqual(store.pins(), pins);
    assert.deepEqual(store.catalog().threads.map(row => row.id), [other]);
    assert.deepEqual(store.catalog().excludedThreadIds, [id]);
    assert.deepEqual(store.catalog().excludedThreadStates, [{ id, archived }]);
  }
  store.sync(source([thread(other)], { excludedThreadIds: [id] }));
  assert.equal(store.thread(id).archived, false, "older sources without states keep the last known archive fact");
});

test("a returning native row restores its annotation and Pocket pin without changing archive truth", t => {
  const { store } = fixture(t);
  store.patchThread(id, { expectedRevision: 0, note: "保留正文", intent: "later", groupIds: [] }, false);
  store.setPin(id, { pinned: true });
  const annotation = store.annotation(id), pins = store.pins();
  store.sync(source([thread(other)], { excludedThreadIds: [id] }));
  assert.deepEqual(store.annotation(id), annotation);
  assert.deepEqual(store.pins(), pins);
  assert.equal(store.thread(id).archived, false);
  store.sync(source([thread(id, { archived: true, sourceExcluded: true }), thread(other)]));
  const restored = store.catalog().threads.find(row => row.id === id);
  assert.ok(restored);
  assert.equal(restored.sourceExcluded, undefined, "inclusion clears an old or copied exclusion flag");
  assert.equal(restored.archived, true);
  assert.equal(restored.pinned, true);
  assert.equal(restored.note, annotation.note);
  assert.equal(restored.revision, annotation.revision);
  assert.deepEqual(store.pins(), pins);
  assert.deepEqual(store.catalog().excludedThreadIds, []);
});

test("invalid exclusions and failed transactions cannot partially change cache scope", t => {
  const { store } = fixture(t);
  const before = store.catalog();
  for (const excludedThreadIds of [null, {}, "one", [null], [1], [""], [id, id]]) {
    assert.throws(() => store.sync(source([thread(other)], { excludedThreadIds })), /来源排除/);
    assert.deepEqual(store.catalog(), before);
  }
  assert.throws(() => store.sync(source(undefined, { excludedThreadIds: [id] })), /同时被纳入和排除/);
  assert.deepEqual(store.catalog(), before);
  assert.throws(() => store.sync(source([thread(other, { title: "changed" }), thread(other)], {
    excludedThreadIds: [id],
  })), /重复 ID/);
  assert.deepEqual(store.catalog(), before, "the preceding row upsert was rolled back too");
});

test("malformed or mismatched excluded states are rejected atomically", t => {
  const { store } = fixture(t);
  const before = store.catalog();
  for (const excludedThreadStates of [
    null, {}, "states", [], [null], [{ id }], [{ id, archived: 1 }],
    [{ id, archived: "false" }], [{ id: other, archived: true }],
    [{ id, archived: true, missing: false }],
    [{ id, archived: true }, { id, archived: false }],
  ]) {
    assert.throws(() => store.sync(source([thread(other, { title: "must not change" })], {
      excludedThreadIds: [id], excludedThreadStates,
    })), /来源排除状态/);
    assert.deepEqual(store.catalog(), before);
  }
  assert.throws(() => store.sync(source([], {
    excludedThreadIds: [id, other], excludedThreadStates: [{ id, archived: true }, { id, archived: false }],
  })), /来源排除状态/);
  assert.deepEqual(store.catalog(), before);
  assert.throws(() => store.sync(source(undefined, {
    excludedThreadStates: [{ id, archived: true }],
  })), /来源排除状态/);
  assert.deepEqual(store.catalog(), before);
  assert.throws(() => store.sync(source([thread(other, { title: "must roll back" }), thread(other)], {
    excludedThreadIds: [id], excludedThreadStates: [{ id, archived: true }],
  })), /重复 ID/);
  assert.deepEqual(store.catalog(), before);
  store.sync(source(undefined, { excludedThreadIds: [], excludedThreadStates: [] }));
  assert.deepEqual(store.catalog(), before);
});

test("scope changes preserve queued bodies, dispatch receipts and pending lifecycle records", t => {
  const { store, directory } = fixture(t);
  const desktop = new DesktopService(store, directory, () => { throw new Error("unexpected native action"); });
  const lifecycle = new LifecycleService(store, desktop, directory, () => {});
  t.after(() => { lifecycle.stop(); desktop.stopQueue(); });
  store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,turn_id,code,created_at) VALUES(?,?,?,'queued',NULL,NULL,?)")
    .run(requestId, id, "fixture-fingerprint", 1000);
  desktop.queue(id, requestId, "保留已提交的待发正文");
  lifecycle.reserve(requestId, "archive", id, { archived: true });
  const before = {
    outbox: desktop.outbox(id), receipt: desktop.getReceipt(id, requestId),
    lifecycle: lifecycle.row(requestId),
  };
  store.sync(source([thread(other)], { excludedThreadIds: [id] }));
  assert.equal(store.thread(id).sourceExcluded, true, "queued thread lookup remains available by ID");
  assert.deepEqual(desktop.outbox(id), before.outbox);
  assert.deepEqual(desktop.getReceipt(id, requestId), before.receipt);
  assert.deepEqual(lifecycle.row(requestId), before.lifecycle);
});

test("task status candidates and cached replies both reject newly excluded rows", async t => {
  let rows = [thread(id), thread(other, { sourceExcluded: true })], payload;
  const service = new TaskStatusService({ codexHome: "/fixture", threads: () => rows, now: () => 10000,
    read: input => {
      payload = input;
      return { available: true, checkedAt: 10000, states: rows.map(row => ({
        threadId: row.id, status: "running", checkedAt: 10000,
      })) };
    },
  });
  t.after(() => service.stop());
  assert.deepEqual((await service.snapshot()).states.map(row => row.threadId), [id]);
  assert.deepEqual(payload.threadIds, [id]);
  rows = rows.map(row => ({ ...row, sourceExcluded: true }));
  assert.deepEqual((await service.snapshot()).states, []);
});

test("late excluded metadata cannot enter any list, attention count, score or projectless menu", () => {
  const excluded = thread(id, { sourceExcluded: true, needsInput: true, pinned: true, pinSource: "pocket", lastOpenedAt: 2000 });
  const states = new Map([[id, "running"]]);
  for (const view of ["all", "unread", "running", "pinned", "recent", "archived"]) {
    assert.deepEqual(filterThreads([{ ...excluded, archived: view === "archived" }], view, "", "", "smart", states), []);
  }
  assert.deepEqual(filterThreads([excluded], "all", id, "__unassigned__", "smart"), []);
  for (const status of [undefined, "waiting_input", "waiting_approval"]) assert.equal(needsUserInput(excluded, status), false);
  assert.equal(smartThreadScore(excluded, { now: 2000, runtimeStates: states, draftIds: new Set([id]) }), -1);
  assert.deepEqual(projectNavigationItems([], [excluded]), []);
});

test("scope refresh preserves only the open detail; close and reinclusion restore ordinary behavior", () => {
  const original = thread(id), visible = thread(other);
  const initial = catalog([original, visible]);
  const incoming = catalog([visible], { excludedThreadIds: [id] });
  const kept = preserveOpenThread(initial, incoming, id);
  assert.equal(kept.threads.length, 2);
  assert.deepEqual(kept.threads.find(row => row.id === id), { ...original, sourceExcluded: true });
  assert.deepEqual(filterThreads(kept.threads, "all", "", "", "smart").map(row => row.id), [other]);
  assert.deepEqual(preserveOpenThread(kept, kept, null).threads, [visible], "closing discards the detail reference");
  const returned = catalog([original, visible], { excludedThreadIds: [] });
  assert.equal(preserveOpenThread(kept, returned, id), returned);
  assert.equal(returned.threads[0].sourceExcluded, undefined);
  assert.equal(initial.threads[0], original, "source snapshots remain immutable");
});

test("old or malformed scope responses cannot revive a row through late lifecycle metadata", () => {
  const visible = thread(other), stale = thread(id);
  const current = catalog([visible], { excludedThreadIds: [id] });
  for (const extra of [{}, { excludedThreadIds: null }, { excludedThreadIds: [1] }, { excludedThreadIds: [id, id] }]) {
    const incoming = catalog([visible, stale], extra);
    const result = preserveOpenThread(current, incoming, null);
    assert.deepEqual(result.excludedThreadIds, [id]);
    assert.deepEqual(result.threads, [visible]);
  }
  const lifecycleAppend = { ...current, threads: [...current.threads, stale] };
  assert.deepEqual(preserveOpenThread(current, lifecycleAppend, null).threads, [visible]);
  const retained = preserveOpenThread(current, lifecycleAppend, id);
  assert.equal(retained.threads.find(row => row.id === id).sourceExcluded, true);
});

test("open excluded details follow native archive and restore while old replies cannot undo their state", () => {
  const original = thread(id, { note: "保留说明", revision: 2 }), visible = thread(other);
  let current = catalog([original, visible]);
  for (const archived of [true, false]) {
    const incoming = catalog([visible], {
      excludedThreadIds: [id], excludedThreadStates: [{ id, archived }],
    });
    current = preserveOpenThread(current, incoming, id);
    assert.deepEqual(current.threads.find(row => row.id === id), { ...original, archived, sourceExcluded: true });
    assert.deepEqual(filterThreads(current.threads, "all", "", "", "smart").map(row => row.id), [other]);
    for (const extra of [
      {}, { excludedThreadStates: null }, { excludedThreadStates: [] },
      { excludedThreadStates: [{ id, archived: "false" }] },
      { excludedThreadStates: [{ id: other, archived: !archived }] },
      { excludedThreadStates: [{ id, archived: !archived, missing: true }] },
      { excludedThreadStates: [{ id, archived: !archived }, { id, archived: !archived }] },
    ]) {
      const late = catalog([visible, { ...original, archived: !archived }], { excludedThreadIds: [id], ...extra });
      const kept = preserveOpenThread(current, late, id);
      assert.equal(kept.threads.find(row => row.id === id).archived, archived);
      assert.deepEqual(kept.excludedThreadStates, [{ id, archived }]);
      assert.deepEqual(filterThreads(kept.threads, "all", "", "", "smart").map(row => row.id), [other]);
    }
    const oldReply = catalog([visible, { ...original, archived: !archived }]);
    assert.equal(preserveOpenThread(current, oldReply, id).threads.find(row => row.id === id).archived, archived);
  }
  assert.equal(original.archived, false, "updating the detail does not mutate its prior snapshot");
  assert.equal(preserveOpenThread(current, current, null).threads.some(row => row.id === id), false);
  const reappeared = catalog([original, visible], { excludedThreadIds: [], excludedThreadStates: [] });
  assert.equal(preserveOpenThread(current, reappeared, id), reappeared);
});

test("excluded metadata for multiple unfinished drafts survives navigation and is released after clearing", () => {
  const first = thread(id), second = thread(other), visible = thread("visible");
  const current = catalog([first, second, visible]);
  const incoming = catalog([visible], {
    excludedThreadIds: [id, other], excludedThreadStates: [{ id, archived: false }, { id: other, archived: true }],
  });
  const drafts = new Set([id, other]);
  const retained = preserveOpenThread(current, incoming, visible.id, drafts);
  assert.deepEqual(retained.threads.map(row => row.id), [visible.id, id, other]);
  assert.equal(retained.threads.find(row => row.id === other).archived, true);
  assert.deepEqual(filterThreads(retained.threads, "all", "", "", "smart").map(row => row.id), [visible.id]);
  const switched = preserveOpenThread(retained, incoming, other, drafts);
  assert.deepEqual(switched.threads.map(row => row.id), [visible.id, id, other]);
  drafts.delete(id);
  const firstCleared = preserveOpenThread(switched, switched, visible.id, drafts);
  assert.deepEqual(firstCleared.threads.map(row => row.id), [visible.id, other]);
  drafts.clear();
  assert.deepEqual(preserveOpenThread(firstCleared, firstCleared, visible.id, drafts).threads, [visible]);
});

test("an unavailable source does not infer exclusion for the detail being read", () => {
  const original = thread(id), current = catalog([original]);
  const failed = catalog([], { sourceError: "source unavailable" });
  const result = preserveOpenThread(current, failed, id);
  assert.equal(result.threads[0], original);
  assert.equal(result.threads[0].sourceExcluded, undefined);
});

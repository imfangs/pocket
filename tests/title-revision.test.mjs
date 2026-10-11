import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NavigatorStore } from "../server/store.mjs";

const source = () => ({ projects: [], sourceInfo: {}, threads: [
  { id: "one", title: "One", cwd: "/sample", archived: false, updatedAt: 10, pinned: true, pinnedOrder: 0 },
  { id: "two", title: "Two", cwd: "/sample", archived: false, updatedAt: 20, pinned: false, pinnedOrder: -1 },
] });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pocket-title-revision-"));
  let store = new NavigatorStore(directory);
  store.sync(source());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, reopen() { store.close(); store = new NavigatorStore(directory); } };
}

test("title generations advance on actual imported title changes, once per atomic catalog", t => {
  const { store } = fixture(t), next = source();
  assert.ok(store.catalog().threads.every(thread => thread.titleRevision === 0));
  store.sync(next);
  assert.equal(store.thread("one").titleRevision, 0);
  next.threads[0].updatedAt = 30; next.threads[0].archived = true;
  next.threads[1].pinned = true; next.threads[1].pinnedOrder = 1;
  store.sync(next);
  assert.equal(store.thread("one").titleRevision, 0);
  const pinRevision = store.thread("one").pinRevision;
  next.threads[0].title = "First rename"; next.threads[1].title = "Second rename";
  store.sync(next);
  assert.ok(store.catalog().threads.every(thread => thread.titleRevision === 1));
  assert.equal(store.thread("one").pinRevision, pinRevision);
  store.sync(next);
  assert.equal(store.thread("one").titleRevision, 1);
  next.threads[0].title = "Third rename";
  store.sync(next);
  assert.equal(store.thread("two").titleRevision, 2);
});

test("every thread response carries the same current title generation, independently of notes, pins and backups", t => {
  const f = fixture(t), { store } = f, next = source();
  store.patchThread("one", { note: "keep" });
  const backup = store.export(), annotationRevision = store.annotation("one").revision;
  next.threads[0].title = "Renamed";
  store.sync(next);
  assert.equal(store.patchThread("one", { note: "new", expectedRevision: annotationRevision }).titleRevision, 1);
  assert.equal(store.setPin("one", { pinned: false }).titleRevision, 1);
  assert.equal(store.recordOpen("one").titleRevision, 1);
  store.restore(backup);
  assert.equal(store.thread("one").title, "Renamed");
  assert.equal(store.thread("one").titleRevision, 1);
  f.reopen();
  assert.equal(f.store.thread("one").titleRevision, 1);
  next.threads[0].title = "Renamed on Mac";
  f.store.sync(next);
  assert.equal(f.store.thread("one").titleRevision, 2);
});

test("failed source import and generation overflow roll back titles and revisions together", t => {
  const { store } = fixture(t), next = source();
  next.threads[0].title = "Not committed";
  next.threads.push(next.threads[0]);
  assert.throws(() => store.sync(next), /重复/);
  assert.equal(store.thread("one").title, "One");
  assert.equal(store.thread("one").titleRevision, 0);
  next.threads.pop(); store.set("titleRevision", Number.MAX_SAFE_INTEGER);
  assert.throws(() => store.sync(next), /修订编号/);
  assert.equal(store.thread("one").title, "One");
  assert.equal(store.thread("one").titleRevision, Number.MAX_SAFE_INTEGER);
  store.sync(source());
  assert.equal(store.thread("one").titleRevision, Number.MAX_SAFE_INTEGER);
});

test("source title and generation use one SQL snapshot including independent Pocket store connections", t => {
  const { store, directory } = fixture(t);
  const other = new NavigatorStore(directory), next = source();
  try {
    const old = store.catalog();
    next.threads[0].title = "Changed elsewhere";
    other.sync(next);
    const current = store.catalog();
    assert.equal(old.threads[0].titleRevision, 0);
    assert.equal(old.threads[0].title, "One");
    assert.equal(current.threads[0].titleRevision, 1);
    assert.equal(current.threads[0].title, "Changed elsewhere");
    assert.deepEqual(current.threads[0], { ...store.thread("one"), ...store.annotation("one", store.thread("one")) });
  } finally { other.close(); }
});

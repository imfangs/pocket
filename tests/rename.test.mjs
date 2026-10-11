import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeApp } from "../server/index.mjs";

const id = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const other = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const absent = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";
const rid = n => `bbbbbbbb-bbbb-7bbb-8bbb-${String(n).padStart(12, "0")}`;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pocket-rename-"));
  const state = { title: "原会话", name: null, archived: false, missing: false, version: true,
    writes: 0, reads: 0, requests: [], sourceError: false, fingerprintSalt: "one" };
  const source = () => {
    if (state.sourceError) throw Error("synthetic unavailable source");
    return { projects: [], sourceInfo: {}, threads: [
      ...(!state.missing ? [{ id, title: state.title, archived: state.archived, cwd: directory,
        model: "original-model", permissions: "original-permissions", updatedAt: 777,
        pinned: true, pinnedOrder: 0 }] : []),
      { id: other, title: "另一个会话", archived: false, cwd: directory, updatedAt: 555 },
    ] };
  };
  const snapshot = threadId => ({ threadId, title: state.title, name: state.name, archived: state.archived,
    nameFingerprint: digest([state.title, state.name, state.fingerprintSalt]), verified: true,
    processStopped: true, mutationAttempted: false });
  const defaultRequest = async payload => {
    state.requests.push(payload);
    if (payload.operation === "inspect") {
      state.reads++;
      if (state.inspectGate) await state.inspectGate.promise;
      return { ...snapshot(payload.threadId), status: "unchanged", canRename: state.version && !state.archived,
        ...(!state.version ? { code: "app_version_changed" } : {}) };
    }
    state.entered?.resolve();
    if (state.gate) await state.gate.promise;
    if (!state.version) return { ...snapshot(payload.threadId), verified: false, status: "unavailable", code: "app_version_changed" };
    if (payload.expectedName !== state.title || payload.expectedFingerprint !== snapshot(id).nameFingerprint)
      return { ...snapshot(payload.threadId), verified: false, status: "changed", code: "name_changed" };
    state.writes++;
    if (state.commit !== false) { state.name = payload.name; state.title = payload.name; }
    return { ...snapshot(payload.threadId), mutationAttempted: true, processStopped: state.stopped !== false, status: state.result || "renamed",
      verified: !state.result, ...(state.code ? { code: state.code } : {}) };
  };
  const options = { dataDir: directory, codexHome: directory, readSource: source,
    readHistory: () => ({ source: "rollout", runtime: "unavailable", canSend: false, messages: [] }),
    desktopRequest: async () => ({ ok: false, code: "desktop_unavailable", sent: false }),
    openThread: async () => {}, rename: { request: defaultRequest },
    notifications: { pollMs: 100000 }, lifecycle: { tickMs: 100000 },
  };
  let app, base, auth, csrf;
  const launch = async () => {
    app = makeApp(options);
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
    auth = { Authorization: `Bearer ${app.auth.localToken}` };
    csrf = (await fetch(base + "/api/catalog", { headers: auth }).then(response => response.json())).csrfToken;
  };
  await launch();
  t.after(async () => {
    state.gate?.resolve(); state.inspectGate?.resolve();
    await Promise.all([...app.rename.running.values(), ...app.rename.inspections.values()]);
    await new Promise(resolve => app.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (path, method = "GET", body) => {
    const response = await fetch(base + path, { method, headers: { ...auth, Origin: base,
      "Content-Type": "application/json", "X-Navigator-Token": csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { http: response.status, ...await response.json() };
  };
  const nameSource = () => call(`/api/tasks/${id}/name`);
  const input = async (n = 1, name = "新名称") => {
    const previous = await nameSource();
    return { requestId: rid(n), name, expectedName: previous.title, expectedFingerprint: previous.nameFingerprint };
  };
  const settle = async () => { await Promise.all(app.rename.running.values()); };
  return { directory, state, source, snapshot, call, input, settle, nameSource, defaultRequest,
    get app() { return app; }, get base() { return base; }, get auth() { return auth; }, get csrf() { return csrf; },
    restart: async () => { await new Promise(resolve => app.server.close(resolve)); await launch(); },
  };
}

test("rename uses the original title/fingerprint and returns fresh source metadata without changing pins, notes or execution settings", async t => {
  const f = await fixture(t);
  f.app.store.patchThread(id, { note: "保持说明", intent: "reference" });
  f.app.store.setPin(id, { pinned: true });
  const before = f.app.store.catalog().threads.find(thread => thread.id === id);
  const input = await f.input();
  assert.equal((await f.nameSource()).name, null);
  const response = await f.call(`/api/tasks/${id}/name`, "POST", input);
  assert.equal(response.http, 202); assert.equal(response.status, "pending");
  await f.settle();
  const done = await f.call(`/api/tasks/${id}/name/${input.requestId}`);
  assert.equal(done.status, "succeeded"); assert.equal(done.thread.title, input.name);
  assert.equal(done.thread.titleRevision, before.titleRevision + 1);
  for (const field of ["id", "cwd", "model", "permissions", "archived", "updatedAt", "pinRevision", "pinnedOrder", "pinSource", "note", "intent", "revision"])
    assert.deepEqual(done.thread[field], before[field], field);
  assert.equal(f.state.writes, 1);
  assert.equal(f.app.lifecycle.blocked.has(id), false);
  const write = f.state.requests.find(request => request.operation === "rename");
  assert.deepEqual(write, { operation: "rename", threadId: id, codexHome: f.directory,
    name: input.name, expectedName: input.expectedName, expectedFingerprint: input.expectedFingerprint });
});

test("request identity is durable and bound to both thread and normalized input; old requests never replay", async t => {
  const f = await fixture(t), input = await f.input(2, "  名称  ");
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", { ...input, name: "名称" })).status, "succeeded");
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", { ...input, name: "另一名称" })).http, 409);
  assert.equal((await f.call(`/api/tasks/${other}/name`, "POST", input)).http, 409);
  assert.equal((await f.call(`/api/tasks/${other}/name/${input.requestId}`)).http, 404);
  await f.restart();
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", input)).status, "succeeded");
  assert.equal(f.state.writes, 1);
});

test("slow renaming returns immediately, permits message enqueue, and blocks a second rename but not the original execution", async t => {
  const f = await fixture(t), input = await f.input(3);
  f.state.gate = deferred(); f.state.entered = deferred();
  const started = performance.now();
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", input)).http, 202);
  assert.ok(performance.now() - started < 1000);
  await f.state.entered.promise;
  const reads = f.state.reads;
  assert.equal((await f.call(`/api/tasks/${id}/name/${input.requestId}`)).status, "pending");
  const current = await f.nameSource();
  assert.equal(current.canRename, false); assert.equal(current.operation.requestId, input.requestId);
  assert.equal(f.state.reads, reads, "polling a running request does not probe partial source");
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", input)).status, "pending");
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", { ...input, requestId: rid(4) })).http, 409);
  const queued = await f.call(`/api/tasks/${id}/messages`, "POST", { requestId: rid(30), text: "队列保持可用", enqueue: true });
  assert.equal(queued.status, "queued");
  assert.equal(f.app.lifecycle.blocked.has(id), false);
  f.state.gate.resolve(); await f.settle(); assert.equal(f.state.writes, 1);
});

test("unknown committed writes resolve only through read-only inspection and do not repeat a POST", async t => {
  const f = await fixture(t), input = await f.input(5);
  f.state.result = "unknown"; f.state.code = "rename_outcome_unknown";
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  assert.equal(f.app.rename.row(id, input.requestId).status, "unknown");
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", input)).status, "unknown");
  assert.equal((await f.call(`/api/tasks/${id}/name/${input.requestId}`)).status, "succeeded");
  assert.equal(f.state.writes, 1); assert.equal(f.state.reads, 2);
});

test("unknown writers without confirmed shutdown stay unresolved across restart even after the desired name appears", async t => {
  const f = await fixture(t), input = await f.input(6);
  f.state.result = "unknown"; f.state.commit = false; f.state.stopped = false;
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  await f.restart();
  const lookup = await f.call(`/api/tasks/${id}/name/${input.requestId}`);
  assert.equal(lookup.status, "unknown"); assert.equal(lookup.currentTitle, input.expectedName);
  const editor = await f.nameSource();
  assert.equal(editor.operation.status, "unknown"); assert.equal(editor.canRename, false);
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", { ...input, requestId: rid(7) })).http, 409);
  f.state.title = input.name; f.state.name = input.name;
  assert.equal((await f.call(`/api/tasks/${id}/name/${input.requestId}`)).status, "unknown");
  assert.equal(f.state.writes, 1);
});

test("pending work recovered after process restart does not invent evidence that the old writer has stopped", async t => {
  const f = await fixture(t), input = await f.input(8);
  // Persist the exact reservation without starting a native process, as if the
  // server exited between committing the ledger and scheduling its worker.
  const now = Date.now(), payload = { name: input.name, expectedName: input.expectedName, expectedFingerprint: input.expectedFingerprint };
  f.app.store.db.prepare("INSERT INTO rename_operations(id,thread_id,input_hash,payload,status,code,current_title,created_at,updated_at) VALUES(?,?,?,?,'pending',NULL,NULL,?,?)")
    .run(input.requestId, id, digest([id, payload]), JSON.stringify(payload), now, now);
  await f.restart();
  assert.equal(f.app.rename.row(id, input.requestId).status, "unknown");
  assert.equal(f.app.rename.row(id, input.requestId).code, "rename_interrupted");
  assert.equal((await f.call(`/api/tasks/${id}/name/${input.requestId}`)).status, "unknown");
  f.state.title = input.name; f.state.name = input.name;
  assert.equal((await f.call(`/api/tasks/${id}/name/${input.requestId}`)).status, "unknown");
  assert.equal(f.state.writes, 0);
});

test("a stopped unknown writer with unchanged original name and fingerprint resolves as not applied without retrying", async t => {
  const f = await fixture(t), input = await f.input(26);
  f.state.result = "unknown"; f.state.commit = false;
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  assert.equal(f.app.rename.row(id, input.requestId).process_stopped, 1);
  await f.restart();
  const result = await f.call(`/api/tasks/${id}/name/${input.requestId}`);
  assert.equal(result.status, "rejected"); assert.equal(result.code, "rename_not_applied");
  assert.equal(result.message, "已确认名称未改变，可以再次保存。");
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", input)).status, "rejected");
  assert.equal(f.state.writes, 1);
  f.state.commit = true; delete f.state.result;
  const retry = await f.input(27);
  await f.call(`/api/tasks/${id}/name`, "POST", retry); await f.settle();
  assert.equal((await f.call(`/api/tasks/${id}/name/${retry.requestId}`)).status, "succeeded");
  assert.equal(f.state.writes, 2);
});

test("a stopped unknown writer followed by another native name or fingerprint resolves as changed", async t => {
  const f = await fixture(t), input = await f.input(28);
  f.state.result = "unknown"; f.state.commit = false;
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  f.state.fingerprintSalt = "external metadata name changed";
  const result = await f.call(`/api/tasks/${id}/name/${input.requestId}`);
  assert.equal(result.status, "changed"); assert.equal(result.currentTitle, input.expectedName);
  assert.equal(f.state.writes, 1); assert.equal(f.app.rename.active(id), undefined);
  const next = await f.input(29);
  await f.call(`/api/tasks/${id}/name`, "POST", next); await f.settle();
  f.state.title = "Changed on Mac";
  assert.equal((await f.call(`/api/tasks/${id}/name/${next.requestId}`)).status, "changed");
  assert.equal(f.state.writes, 2);
});

test("metadata protection failures remain visible even when the desired name has persisted", async t => {
  const f = await fixture(t), input = await f.input(9);
  f.state.result = "unknown"; f.state.code = "thread_metadata_changed";
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  const result = await f.call(`/api/tasks/${id}/name/${input.requestId}`);
  assert.equal(result.status, "unknown"); assert.equal(result.code, "thread_metadata_changed");
  await f.restart();
  assert.equal((await f.nameSource()).operation.status, "unknown");
  assert.equal(f.state.writes, 1);
});

test("name and raw-name fingerprint conflicts preserve the user's original request and need a fresh request", async t => {
  const f = await fixture(t), input = await f.input(10);
  f.state.fingerprintSalt = "changed without changing displayed title";
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  const result = await f.call(`/api/tasks/${id}/name/${input.requestId}`);
  assert.equal(result.status, "changed"); assert.equal(result.currentTitle, input.expectedName);
  assert.equal(f.state.writes, 0);
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", input)).status, "changed");
  const refreshed = await f.input(11);
  await f.call(`/api/tasks/${id}/name`, "POST", refreshed); await f.settle();
  assert.equal((await f.call(`/api/tasks/${id}/name/${refreshed.requestId}`)).status, "succeeded");
});

test("archived, missing and pending lifecycle targets are never temporarily restored or renamed", async t => {
  const f = await fixture(t), input = await f.input(12);
  f.state.archived = true; f.app.sync();
  assert.equal((await f.nameSource()).canRename, false);
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  assert.equal((await f.call(`/api/tasks/${id}/name/${input.requestId}`)).code, "archived_thread");
  f.state.archived = false; f.state.missing = true; f.app.sync();
  assert.equal((await f.nameSource()).code, "thread_missing");
  const missing = { ...input, requestId: rid(13) };
  await f.call(`/api/tasks/${id}/name`, "POST", missing); await f.settle();
  assert.equal((await f.call(`/api/tasks/${id}/name/${missing.requestId}`)).code, "thread_missing");
  f.state.missing = false; f.app.sync(); f.app.lifecycle.blocked.add(id);
  const pending = { ...input, requestId: rid(14) };
  await f.call(`/api/tasks/${id}/name`, "POST", pending); await f.settle();
  assert.equal((await f.call(`/api/tasks/${id}/name/${pending.requestId}`)).code, "lifecycle_pending");
  assert.equal(f.state.writes, 0);
});

test("an App update before dispatch is rejected and its original request is not replayed after compatibility returns", async t => {
  const f = await fixture(t), input = await f.input(15);
  f.state.version = false;
  const disabled = await f.nameSource();
  assert.equal(disabled.canRename, false); assert.equal(disabled.code, "app_version_changed");
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  const rejected = await f.call(`/api/tasks/${id}/name/${input.requestId}`);
  assert.equal(rejected.status, "rejected"); assert.equal(rejected.code, "app_version_changed");
  f.state.version = true;
  assert.equal((await f.call(`/api/tasks/${id}/name`, "POST", input)).status, "rejected");
  assert.equal(f.state.writes, 0);
});

test("failed source verification keeps the operation unknown until the source independently confirms the new name", async t => {
  const f = await fixture(t), input = await f.input(16);
  f.app.rename.request = async payload => {
    const result = await f.defaultRequest(payload);
    if (payload.operation === "rename") f.state.sourceError = true;
    return result;
  };
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  assert.equal((await f.call(`/api/tasks/${id}/name/${input.requestId}`)).status, "unknown");
  f.state.sourceError = false;
  assert.equal((await f.call(`/api/tasks/${id}/name/${input.requestId}`)).status, "succeeded");
  assert.equal(f.state.writes, 1);
});

test("malformed, mismatched or unstopped success receipts cannot claim the original thread was renamed", async t => {
  const f = await fixture(t), input = await f.input(17);
  f.app.rename.request = async payload => ({ ...f.snapshot(other), status: "renamed", title: payload.name,
    processStopped: false, mutationAttempted: true });
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  assert.equal((await f.call(`/api/tasks/${id}/name/${input.requestId}`)).status, "unknown");
  assert.equal(f.app.store.thread(id).title, input.expectedName);
});

test("concurrent unknown readers share one inspection and never regress a resolved receipt", async t => {
  const f = await fixture(t), input = await f.input(18);
  f.state.result = "unknown";
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  f.state.inspectGate = deferred();
  const a = f.app.rename.get(id, input.requestId), b = f.app.rename.get(id, input.requestId);
  await new Promise(resolve => setImmediate(resolve));
  f.state.inspectGate.resolve();
  assert.ok((await Promise.all([a, b])).every(result => result.status === "succeeded"));
  assert.equal(f.state.reads, 2); assert.equal(f.state.writes, 1);
});

test("an inspection started before the write is never reused to label an applied unknown rename as not applied", async t => {
  const f = await fixture(t), input = await f.input(31), entered = deferred(), release = deferred();
  f.state.result = "unknown";
  f.app.rename.request = async payload => {
    const result = await f.defaultRequest(payload);
    if (payload.operation === "inspect" && f.state.reads === 2) { entered.resolve(); await release.promise; }
    return result;
  };
  const olderRead = f.nameSource(); await entered.promise;
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  const result = await f.call(`/api/tasks/${id}/name/${input.requestId}`);
  assert.equal(result.status, "succeeded"); assert.equal(f.state.reads, 3);
  release.resolve(); await olderRead;
  assert.equal(f.app.rename.row(id, input.requestId).status, "succeeded");
  assert.equal(f.state.writes, 1);
});

test("archive and restore cannot race an unresolved rename or suspend its original owner", async t => {
  const f = await fixture(t), input = await f.input(21);
  f.state.gate = deferred(); f.state.entered = deferred();
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.state.entered.promise;
  for (const archived of [true, false]) {
    const result = await f.call(`/api/tasks/${id}/archive`, "POST", { requestId: rid(22), archived });
    assert.equal(result.http, 409); assert.equal(f.app.lifecycle.blocked.has(id), false);
  }
  f.state.result = "unknown"; f.state.commit = false;
  f.state.gate.resolve(); await f.settle();
  assert.equal((await f.call(`/api/tasks/${id}/archive`, "POST", { requestId: rid(23), archived: true })).http, 409);
  assert.equal(f.app.lifecycle.blocked.has(id), false);
});

test("archive plans reject unresolved renames in their descendants before starting the native archive write", async t => {
  const f = await fixture(t), input = await f.input(24);
  f.state.result = "unknown"; f.state.commit = false;
  await f.call(`/api/tasks/${id}/name`, "POST", input); await f.settle();
  let archiveWrites = 0;
  f.app.lifecycle.archive = async payload => {
    if (payload.operation !== "inspect") archiveWrites++;
    return { status: "ready", fingerprint: "tree", threadIds: [other, id], descendantCount: 1 };
  };
  await f.call(`/api/tasks/${other}/archive`, "POST", { requestId: rid(25), archived: true });
  await Promise.all(f.app.lifecycle.running.values());
  const result = await f.call(`/api/task-operations/${rid(25)}`);
  assert.equal(result.status, "rejected"); assert.equal(result.code, "child_operation_in_progress");
  assert.equal(archiveWrites, 0); assert.equal(f.state.writes, 1);
});

test("name HTTP endpoints enforce authentication, Origin, CSRF, exact IDs and bounded validated input", async t => {
  const f = await fixture(t), input = await f.input(19), path = `/api/tasks/${id}/name`;
  assert.equal((await fetch(f.base + path)).status, 401);
  assert.equal((await fetch(f.base + `${path}/${input.requestId}`)).status, 401);
  assert.equal((await fetch(f.base + path, { method: "POST", headers: { ...f.auth, Origin: f.base,
    "Content-Type": "application/json" }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await fetch(f.base + path, { method: "POST", headers: { ...f.auth, Origin: "https://other.example",
    "Content-Type": "application/json", "X-Navigator-Token": f.csrf }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await f.call(`/api/tasks/not-an-id/name`)).http, 400);
  assert.equal((await f.call(`/api/tasks/${id}/name/not-an-id`)).http, 400);
  assert.equal((await f.call(`/api/tasks/${absent}/name`)).http, 404);
  for (const invalid of [null, [], {}, { ...input, requestId: "bad" }, { ...input, name: "" }, { ...input, name: "a\nb" },
    { ...input, name: "\ttrimmed" }, { ...input, name: "control\u007f" }, { ...input, name: "line\u2028break" },
    { ...input, name: "x".repeat(221) }, { ...input, name: "😀".repeat(111) },
    { ...input, expectedName: null }, { ...input, expectedFingerprint: "bad" }, { ...input, unrelated: true }])
    assert.equal((await f.call(path, "POST", invalid)).http, 400, JSON.stringify(invalid));
  assert.equal((await f.call(path, "POST", { ...input, name: "x".repeat(9000) })).http, 413);
  assert.equal(f.state.writes, 0);
  const limit = await f.input(20, "😀".repeat(110));
  assert.equal((await f.call(path, "POST", limit)).http, 202); await f.settle();
  assert.equal((await f.call(`${path}/${limit.requestId}`)).status, "succeeded");
});

import test from "node:test";
import assert from "node:assert/strict";
import { updateThreadPriority } from "../src/updateThreadPriority.ts";

const thread = { id: "one", pinned: false, pinnedOrder: -1, pinRevision: 5, pinSource: "codex", codexPinned: false, pocketPriority: false };
const confirmed = { ...thread, pinned: true, pocketPriority: true, pinRevision: 6 };
const catalog = (value = confirmed, scope = "scope-a") => ({ threads: [value], sourceInfo: { pocketRead: { scope } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("priority writes remain one explicit legacy-compatible POST with a matching non-regressing result", async () => {
  const calls = [];
  assert.equal(await updateThreadPriority(thread, async (...args) => { calls.push(args); return confirmed; }), confirmed);
  assert.equal(calls.length, 1); assert.equal(calls[0][0], "/api/tasks/one/priority");
  assert.equal(calls[0][1], "POST"); assert.deepEqual(calls[0][2], { priority: true });
});

test("a prior source response is discarded rather than applied or followed by another read", async () => {
  const pending = deferred(), calls = []; let scope = "scope-a";
  const result = updateThreadPriority(thread, async (...args) => { calls.push(args); return pending.promise; },
    { scope, isCurrent: () => scope === "scope-a" });
  scope = "scope-b"; pending.resolve(confirmed);
  await assert.rejects(result, /会话来源已变化/); assert.equal(calls.length, 1);
});

test("an uncertain POST uses a same-source GET to confirm without repeating the write", async () => {
  const calls = [];
  const result = await updateThreadPriority(thread, async (path, method, body) => {
    calls.push({ path, method, body });
    if (method === "POST") throw new TypeError("network failed");
    return catalog();
  }, { scope: "scope-a", isCurrent: () => true });
  assert.equal(result, confirmed); assert.deepEqual(calls.map(value => value.method), ["POST", "GET"]);
});

test("uncertain readback from another source or a stale revision cannot confirm the write", async () => {
  for (const fresh of [catalog(confirmed, "scope-b"), catalog({ ...confirmed, pinRevision: 4 }), catalog({ ...confirmed, id: "other" })]) {
    const calls = [];
    await assert.rejects(updateThreadPriority(thread, async (_path, method) => {
      calls.push(method); if (method === "POST") throw new TypeError("network failed"); return fresh;
    }, { scope: "scope-a", isCurrent: () => true }), /关注状态尚未确认/);
    assert.deepEqual(calls, ["POST", "GET"]);
  }
});

test("scope replacement while a readback is pending revokes its matching result", async () => {
  const pending = deferred(); let current = true;
  const result = updateThreadPriority(thread, async (_path, method) => {
    if (method === "POST") throw new TypeError("network failed"); return pending.promise;
  }, { scope: "scope-a", isCurrent: () => current });
  await Promise.resolve(); await Promise.resolve(); current = false; pending.resolve(catalog());
  await assert.rejects(result, /会话来源已变化/);
});

test("legacy inputs, an already-invalid source and explicit client errors do not trigger recovery", async () => {
  const calls = [];
  const request = async (_path, method) => { calls.push(method); throw Object.assign(new Error("client rejected"), { status: 409 }); };
  const { codexPinned: _ignored, ...legacy } = thread;
  await assert.rejects(updateThreadPriority(legacy, request), /请更新 Mac/);
  await assert.rejects(updateThreadPriority(thread, request, { isCurrent: () => false }), /会话来源已变化/);
  assert.deepEqual(calls, []);
  await assert.rejects(updateThreadPriority(thread, request), /client rejected/); assert.deepEqual(calls, ["POST"]);
});

test("a malformed or older successful reply stays uncertain", async () => {
  for (const value of [{ ...confirmed, pinRevision: 4 }, { ...confirmed, pinRevision: -1 }, { ...confirmed, codexPinned: undefined },
    { ...confirmed, id: "other" }, { ...confirmed, pocketPriority: false }])
    await assert.rejects(updateThreadPriority(thread, async () => value), /关注状态尚未确认/);
});

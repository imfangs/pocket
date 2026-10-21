import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NavigatorStore } from "../server/store.mjs";
import { DesktopService } from "../server/desktop.mjs";
import { makeApp } from "../server/index.mjs";
const id = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const rid = n => `bbbbbbbb-bbbb-7bbb-8bbb-${String(n).padStart(12,"0")}`;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-outbox-"));
  const store = new NavigatorStore(dir);
  store.sync({ threads: [{ id, title: "Fixture", archived: false }], projects: [], sourceInfo: {} });
  const state = { active: true, fail: false, messages: [], calls: [] };
  const request = async payload => {
    if (payload.operation === "history") return { ok: true, source: "desktop", runtime: state.active ? "active" : "idle",
      canSend: true, queueReady: !state.active, messages: state.messages };
    state.calls.push(payload);
    if (state.active && payload.delivery !== "now") return { ok: false, code: "thread_active", sent: false };
    if (state.fail) return { ok: false, code: "dispatch_unknown", sent: null };
    state.active = true;
    return { ok: true, turnId: "turn" };
  };
  const service = new DesktopService(store, "/fixture", request);
  t.after(() => { service.stopQueue(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, state, service, request };
}
test("busy input persists once, edits pause execution, then FIFO sends the saved text", async t => {
  const { service:s, state, store } = fixture(t);
  assert.equal((await s.send(id, { text: "First", requestId: rid(1) })).status, "queued");
  assert.equal((await s.send(id, { text: "First", requestId: rid(1) })).status, "queued");
  await s.send(id, { text: "Second", requestId: rid(2) });
  assert.equal(state.calls.length, 1);
  s.pauseQueued(id, rid(1), { expectedRevision: 0 });
  state.active = false;
  await s.processQueue();
  assert.equal(state.calls.length, 1);
  assert.throws(() => s.editQueued(id, rid(1), { text: "Stale", expectedRevision: 0 }), e => e.status === 409);
  s.editQueued(id, rid(1), { text: "Corrected", expectedRevision: 1 });
  await s.processQueue();
  assert.equal(state.calls.at(-1).text, "Corrected");
  assert.equal(s.outbox(id).length, 1);
  assert.equal(store.db.prepare("SELECT * FROM outgoing_messages WHERE id=?").get(rid(1)), undefined);
  state.active = false; s.cache.clear();
  await s.processQueue();
  assert.equal(state.calls.at(-1).text, "Second");
  assert.equal(s.outbox(id).length, 0);
});
test("explicit queue intent is stored immediately and never starts an active task", async t => {
  const { service:s, state } = fixture(t);
  const r = await s.send(id, { text: "Next", requestId: rid(1), enqueue: true });
  assert.equal(r.status, "queued");
  assert.equal(state.calls.length, 0);
  await s.processQueue(); assert.equal(state.calls.length, 0);
  state.active = false; s.cache.clear();
  await s.processQueue(); assert.equal(state.calls.length, 1);
  assert.equal(s.outbox(id).length, 0);
});
test("cancelled messages never dispatch; immediate send explicitly uses steer delivery", async t => {
  const { service:s, state } = fixture(t);
  await s.send(id, { text: "Delete me", requestId: rid(1) });
  await s.send(id, { text: "Send now", requestId: rid(2) });
  s.cancelQueued(id, rid(1), { expectedRevision: 0 });
  assert.equal(s.getReceipt(id, rid(1)).status, "cancelled");
  const r = await s.dispatchQueued(id, rid(2), { expectedRevision: 0 });
  assert.equal(r.status, "accepted");
  assert.equal(state.calls.at(-1).delivery, "now");
  assert.equal(s.outbox(id).length, 0);
});
test("a slow queue dispatch does not block adding another waiting message", async t => {
  const { service:s } = fixture(t);
  await s.send(id, { text: "First", requestId: rid(1), enqueue: true });
  let finish;
  s.request = () => new Promise(resolve => { finish = resolve; });
  const submitting = s.dispatchQueued(id, rid(1), { expectedRevision: 0 });
  assert.equal((await s.send(id, { text: "Next", requestId: rid(2), enqueue: true })).status, "queued");
  assert.equal(s.outbox(id).length, 2);
  finish({ ok: true }); await submitting;
  assert.deepEqual(s.outbox(id).map(row => row.text), ["Next"]);
});
test("a slow initial send reserves room to join a queue filled during preflight", async t => {
  const { service:s, store } = fixture(t);
  let finish;
  s.request = () => new Promise(resolve => { finish = resolve; });
  const submitting = s.send(id, { text: "Original", requestId: rid(1) });
  for (let n = 2; n <= 20; n++)
    await s.send(id, { text: `Next ${n}`, requestId: rid(n), enqueue: true });
  const couldQueue = s.withActions(id, { canSend: true }).canQueue;
  const overflow = await s.send(id, { text: "Overflow", requestId: rid(21), enqueue: true }).catch(error => error);
  // Submissions in the same millisecond still follow dispatch insertion order.
  store.db.prepare("UPDATE dispatches SET created_at=1000").run();
  finish({ ok: false, sent: false, code: "thread_active" });
  const result = await submitting.catch(error => error);
  assert.equal(couldQueue, false);
  assert.equal(overflow.status, 409);
  assert.equal(s.getReceipt(id, rid(21)).status, "not_found");
  assert.equal(result.status, "queued");
  assert.equal(s.outbox(id).length, 20);
  assert.equal(s.outbox(id)[0].id, rid(1));
  assert.equal(s.outbox(id)[0].text, "Original");
});
test("a settled direct attempt releases its queue reservation without replaying uncertain input", async t => {
  for (const outcome of [{ ok: true }, { ok: false, sent: false }, { ok: false, sent: null }]) {
    const { service:s } = fixture(t);
    let finish, calls = 0;
    s.request = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    const submitting = s.send(id, { text: "Original", requestId: rid(1) });
    for (let n = 2; n <= 20; n++)
      await s.send(id, { text: `Next ${n}`, requestId: rid(n), enqueue: true });
    finish(outcome);
    const result = await submitting;
    assert.equal(result.status, outcome.ok ? "accepted" : outcome.sent === false ? "rejected" : "unknown");
    assert.equal(s.withActions(id, { canSend: true }).canQueue, true);
    assert.equal((await s.send(id, { text: "Last slot", requestId: rid(21), enqueue: true })).status, "queued");
    assert.equal(s.outbox(id).length, 20);
    assert.equal((await s.send(id, { text: "Original", requestId: rid(1) })).status, result.status);
    assert.equal(calls, 1);
  }
});
test("unknown outcomes block replay and reconcile only with the matching original message", async t => {
  const { service:s, state } = fixture(t);
  await s.send(id, { text: "Uncertain", requestId: rid(1) });
  state.fail = true;
  assert.equal((await s.dispatchQueued(id, rid(1), { expectedRevision: 0 })).status, "unknown");
  const before = state.calls.length;
  await s.processQueue(); await s.processQueue();
  assert.equal(state.calls.length, before);
  assert.throws(() => s.cancelQueued(id, rid(1), { expectedRevision: 0 }), e => e.status === 409);
  state.messages = [{ role: "user", id: "actual", text: "Uncertain", clientMessageId: rid(1), turnId: "turn" }];
  s.cache.clear(); await s.history(id);
  assert.equal(s.getReceipt(id, rid(1)).status, "accepted");
  assert.equal(s.outbox(id).length, 0);
});
test("restart holds interrupted submissions and keeps unsent queue text", async t => {
  const { service:s, store, request } = fixture(t);
  await s.send(id, { text: "Held", requestId: rid(1) });
  store.db.prepare("UPDATE dispatches SET status='pending' WHERE id=?").run(rid(1));
  const restarted = new DesktopService(store, "/fixture", request);
  restarted.startQueue(); restarted.stopQueue();
  assert.equal(restarted.getReceipt(id, rid(1)).status, "unknown");
  assert.equal(restarted.outbox(id)[0].text, "Held");
});
test("edits during readiness checks stop stale text from being submitted", async t => {
  const { service:s, state } = fixture(t);
  await s.send(id, { text: "Old", requestId: rid(1) });
  let resolve;
  s.request = payload => payload.operation === "history" ? new Promise(r => { resolve = r; }) : assert.fail("Stale dispatch");
  const check = s.processQueue();
  s.editQueued(id, rid(1), { text: "New", expectedRevision: 0 });
  resolve({ ok: true, runtime: "idle", canSend: true, queueReady: true, messages: [] });
  await check;
  assert.equal(s.outbox(id)[0].text, "New");
  assert.equal(s.outbox(id)[0].status, "queued");
  assert.equal(state.calls.length, 1);
});

test("authenticated queue HTTP routes enforce edit revisions and expose only this task's items", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pocket-outbox-http-"));
  const app = makeApp({ dataDir: dir, codexHome: dir, readSource: () => ({ threads: [{ id, title: "Fixture", archived: false }], projects: [], sourceInfo: {} }),
    desktopRequest: async p => p.operation === "history" ? { ok: true, runtime: "active", queueReady: false, canSend: true, messages: [] }
      : p.delivery === "now" ? { ok: true } : { ok: false, code: "thread_active", sent: false } });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(async () => { await new Promise(r => app.server.close(r)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const access = JSON.parse(readFileSync(join(dir, "access.json"), "utf8"));
  let csrf;
  const call = (path, method = "GET", data) => fetch(base+path, { method, headers: { Authorization: `Bearer ${access.localToken}`,
    Origin: base, "Content-Type": "application/json", ...(csrf ? { "X-Navigator-Token": csrf } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  csrf = (await (await call("/api/catalog")).json()).csrfToken;
  const queue = `/api/tasks/${id}`;
  assert.equal((await (await call(queue+"/messages", "POST", { text: "Queued", requestId: rid(1) })).json()).status, "queued");
  assert.equal((await (await call(queue+"/history")).json()).outbox.length, 1);
  assert.equal((await call(queue+`/outbox/${rid(1)}/edit`, "POST", { expectedRevision: 0 })).status, 200);
  assert.equal((await call(queue+`/outbox/${rid(1)}`, "PATCH", { expectedRevision: 0, text: "Stale" })).status, 409);
  assert.equal((await call(queue+`/outbox/${rid(1)}`, "PATCH", { expectedRevision: 1, text: "Edited" })).status, 200);
  assert.equal((await call(queue+`/outbox/${rid(1)}/send`, "POST", { expectedRevision: 2, model: "override" })).status, 400);
  assert.equal((await (await call(queue+`/outbox/${rid(1)}/send`, "POST", { expectedRevision: 2 })).json()).status, "accepted");
  assert.equal((await (await call(queue+"/history")).json()).outbox.length, 0);
});

import "./helpers/block-native-open.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { NavigatorStore } from "../server/store.mjs";
import { DesktopService } from "../server/desktop.mjs";
import { messageFingerprint } from "../server/attachments.mjs";
import { LifecycleService } from "../server/lifecycle.mjs";

const id = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const turnId = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const rid = n => `bbbbbbbb-bbbb-7bbb-8bbb-${String(n).padStart(12, "0")}`;
const attachmentId = "dddddddd-dddd-7ddd-8ddd-dddddddddddd";
const source = () => ({ threads: [{ id, title: "Auto-direct fixture", cwd: "/fixture", archived: false }], projects: [], sourceInfo: {} });
const savedHistory = () => ({ source: "rollout", runtime: "unavailable", canSend: false, queueReady: false, messages: [] });

function fixture(t, { legacy = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pocket-auto-direct-"));
  const state = { runtime: "active", turnStatus: "inProgress", available: true, canSend: true, sends: [], stops: [], messages: [] };
  const history = () => ({ ok: true, source: "desktop", resumeState: "resumed", runtime: state.runtime,
    canSend: state.canSend, canStop: state.runtime === "active", activeTurnId: state.runtime === "active" ? turnId : null,
    latestTurnId: turnId, latestTurnStatus: state.turnStatus,
    recentTurns: [{ id: turnId, status: state.turnStatus }],
    queueReady: state.canSend && state.runtime === "idle" && state.turnStatus === "completed", messages: state.messages });
  const request = async payload => {
    if (payload.operation === "history") return state.available ? history() : { ok: false, code: "desktop_unavailable", sent: false };
    if (payload.operation === "stop") { state.stops.push(payload); return { ok: true }; }
    assert.equal(payload.operation, "send", "The fixture must never invoke an unhandled desktop operation");
    state.sends.push(structuredClone(payload));
    if (state.outcome) return state.outcome;
    if (!state.available) return { ok: false, code: "desktop_unavailable", sent: false };
    if (state.runtime === "active" && !["now", "auto-now"].includes(payload.delivery))
      return { ok: false, code: "thread_active", sent: false };
    return { ok: true, turnId };
  };
  const f = { directory, state, request, history, store: new NavigatorStore(directory), service: null };
  f.store.sync(source());
  if (legacy) {
    f.store.db.exec("CREATE TABLE dispatches(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,text_hash TEXT NOT NULL,status TEXT NOT NULL,turn_id TEXT,code TEXT,created_at INTEGER NOT NULL)");
    f.store.db.exec("CREATE TABLE outgoing_messages(id TEXT PRIMARY KEY REFERENCES dispatches(id),thread_id TEXT NOT NULL,text TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)");
    f.store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,'queued',1)")
      .run(rid(1), id, messageFingerprint("Legacy instruction"));
    f.store.db.prepare("INSERT INTO outgoing_messages(id,thread_id,text) VALUES(?,?,?)").run(rid(1), id, "Legacy instruction");
  }
  f.service = new DesktopService(f.store, directory, request, savedHistory);
  f.restart = () => {
    f.service.stopQueue(); f.store.close();
    f.store = new NavigatorStore(directory);
    f.service = new DesktopService(f.store, directory, request, savedHistory);
    // Run the production interrupted-submission recovery without leaving a timer.
    f.service.startQueue(); f.service.stopQueue();
  };
  f.queue = (n, extra = {}) => f.service.send(id, { requestId: rid(n), text: `Instruction ${n}`, enqueue: true, autoDirect: true, ...extra });
  t.after(() => { f.service.stopQueue(); f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  return f;
}

test("old dispatch tables migrate without turning existing queued messages into steering", async t => {
  const f = fixture(t, { legacy: true });
  assert.equal(f.service.outbox(id)[0].autoDirect, false);
  await f.service.processQueue();
  assert.equal(f.state.sends.length, 0);
  f.restart();
  assert.equal(f.service.outbox(id)[0].autoDirect, false);
  f.state.runtime = "idle"; f.state.turnStatus = "completed";
  await f.service.processQueue();
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.sends[0].delivery, "auto");
  assert.equal(f.service.getReceipt(id, rid(1)).status, "accepted");
});

test("omitted and false autoDirect retain the legacy next-turn queue behavior", async t => {
  for (const extra of [{}, { autoDirect: false }]) await t.test(JSON.stringify(extra), async t => {
    const f = fixture(t);
    await f.service.send(id, { requestId: rid(1), text: "Wait for the next turn", enqueue: true, ...extra });
    assert.equal(f.service.outbox(id)[0].autoDirect, false);
    await f.service.processQueue(); assert.equal(f.state.sends.length, 0);
    f.state.runtime = "idle"; f.state.turnStatus = "completed"; f.service.cache.clear();
    await f.service.processQueue();
    assert.equal(f.state.sends[0].delivery, "auto");
  });
});

test("a new direct-enabled message steers once using its original request identity", async t => {
  const f = fixture(t), input = { requestId: rid(1), text: "A current-turn correction", autoDirect: true };
  assert.equal((await f.service.send(id, input)).status, "accepted");
  assert.equal(f.state.sends[0].delivery, "now");
  assert.equal(f.state.sends[0].requestId, rid(1));
  assert.equal((await f.service.send(id, input)).status, "accepted");
  await assert.rejects(f.service.send(id, { ...input, autoDirect: false }), e => e.status === 409);
  assert.equal(f.state.sends.length, 1);
  await assert.rejects(f.service.send(id, { ...input, text: "Different content" }), e => e.status === 409);
});

test("non-boolean autoDirect values fail before reserving a message", async t => {
  const f = fixture(t);
  for (const autoDirect of [null, "true", 1, {}, []]) {
    await assert.rejects(f.service.send(id, { requestId: rid(1), text: "Invalid preference", autoDirect }), e => e.status === 400);
    assert.equal(f.service.getReceipt(id, rid(1)).status, "not_found");
  }
  assert.equal(f.state.sends.length, 0);
});

test("a queued new preference survives service restart and sends while the browser is absent", async t => {
  const f = fixture(t); f.state.available = false;
  await f.queue(1);
  assert.equal(f.service.outbox(id)[0].autoDirect, true);
  await f.service.processQueue(); assert.equal(f.state.sends.length, 0);
  f.restart(); f.state.available = true;
  assert.equal(f.service.outbox(id)[0].autoDirect, true);
  await f.service.processQueue();
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.sends[0].delivery, "auto-now");
  assert.equal(f.state.sends[0].requestId, rid(1));
  await f.service.processQueue(); assert.equal(f.state.sends.length, 1);
});

test("a new auto-direct message cannot overtake an older next-turn message", async t => {
  const f = fixture(t);
  await f.queue(1, { autoDirect: false });
  await f.service.send(id, { requestId: rid(2), text: "New instruction", autoDirect: true });
  assert.deepEqual(f.service.outbox(id).map(item => item.autoDirect), [false, true]);
  await f.service.processQueue(); assert.equal(f.state.sends.length, 0);
  f.state.runtime = "idle"; f.state.turnStatus = "completed"; f.service.cache.clear();
  await f.service.processQueue();
  assert.deepEqual(f.state.sends.map(call => call.requestId), [rid(1)]);
  f.state.runtime = "active"; f.state.turnStatus = "inProgress"; f.service.cache.clear();
  await f.service.processQueue();
  assert.deepEqual(f.state.sends.map(call => call.requestId), [rid(1), rid(2)]);
  assert.equal(f.state.sends[1].delivery, "auto-now");
});

test("editing, rejected, pending and unknown queue heads block later auto-direct messages", async t => {
  for (const status of ["editing", "rejected", "pending", "unknown"]) await t.test(status, async t => {
    const f = fixture(t);
    await f.queue(1); await f.queue(2);
    if (status === "editing") f.service.pauseQueued(id, rid(1), { expectedRevision: 0 });
    else f.store.db.prepare("UPDATE dispatches SET status=? WHERE id=?").run(status, rid(1));
    await f.service.processQueue(); await f.service.processQueue();
    assert.equal(f.state.sends.length, 0);
    assert.deepEqual(f.service.outbox(id).map(item => item.id), [rid(1), rid(2)]);
  });
});

test("saving an edited message keeps its preference and only dispatches the new revision", async t => {
  const f = fixture(t); await f.queue(1);
  f.service.pauseQueued(id, rid(1), { expectedRevision: 0 });
  await f.service.processQueue(); assert.equal(f.state.sends.length, 0);
  f.service.editQueued(id, rid(1), { expectedRevision: 1, text: "Saved correction" });
  assert.equal(f.service.outbox(id)[0].autoDirect, true);
  await f.service.processQueue();
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.state.sends[0].text, "Saved correction");
});

test("an acknowledged stop still pauses auto-direct messages until explicit queue recovery", async t => {
  const f = fixture(t); await f.queue(1);
  await f.service.stop(id, { requestId: rid(90), expectedTurnId: turnId });
  f.state.runtime = "idle"; f.state.turnStatus = "interrupted"; f.service.cache.clear();
  await f.service.history(id);
  assert.equal(f.service.stops.pending(id), false);
  await f.service.processQueue(); assert.equal(f.state.sends.length, 0);
  await f.service.resumeQueue(id, { expectedStopId: rid(90) });
  await f.service.processQueue();
  assert.equal(f.state.sends[0].delivery, "resume");
  assert.equal(f.state.sends[0].resumeAfterTurnId, turnId);
});

test("a stop acknowledged during readiness read cannot be bypassed with automatic now delivery", async t => {
  const f = fixture(t); await f.queue(1);
  let finish;
  f.service.request = payload => payload.operation === "history" ? new Promise(resolve => { finish = resolve; }) : f.request(payload);
  const processing = f.service.processQueue();
  await f.service.stop(id, { requestId: rid(90), expectedTurnId: turnId });
  // Reconcile the stop before the delayed active read returns: pause remains,
  // but stops.pending() no longer provides a coincidental extra safeguard.
  f.service.stops.reconcile(id, { source: "desktop", recentTurns: [{ id: turnId, status: "interrupted" }] });
  assert.equal(f.service.stops.pending(id), false);
  finish(f.history()); await processing;
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.service.outbox(id)[0].status, "queued");
  assert.equal(f.service.stops.pause(id).stopId, rid(90));
});

test("a message rejected during readiness read is not automatically claimed for retry", async t => {
  const f = fixture(t); await f.queue(1);
  let finish;
  f.service.request = payload => payload.operation === "history" ? new Promise(resolve => { finish = resolve; }) : f.request(payload);
  const processing = f.service.processQueue();
  f.store.db.prepare("UPDATE dispatches SET status='rejected',code='thread_changed' WHERE id=?").run(rid(1));
  finish(f.history()); await processing;
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.service.outbox(id)[0].status, "rejected");
});

test("editing during readiness read prevents stale automatic text and revision from dispatching", async t => {
  const f = fixture(t); await f.queue(1);
  let finish;
  f.service.request = payload => payload.operation === "history" ? new Promise(resolve => { finish = resolve; }) : f.request(payload);
  const processing = f.service.processQueue();
  f.service.pauseQueued(id, rid(1), { expectedRevision: 0 });
  f.service.editQueued(id, rid(1), { expectedRevision: 1, text: "New revision" });
  finish(f.history()); await processing;
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.service.outbox(id)[0].revision, 2);
  assert.equal(f.service.outbox(id)[0].text, "New revision");
});

test("canSend alone does not authorize background continuation of failed or interrupted turns", async t => {
  for (const [runtime, turnStatus] of [["idle", "failed"], ["idle", "interrupted"], ["systemError", "failed"]]) await t.test(`${runtime}/${turnStatus}`, async t => {
    const f = fixture(t); await f.queue(1);
    f.state.runtime = runtime; f.state.turnStatus = turnStatus;
    await f.service.processQueue();
    assert.equal(f.state.sends.length, 0);
    assert.equal(f.service.outbox(id)[0].status, "queued");
  });
});

test("temporarily unwritable original owner holds auto-direct input until a fresh writable snapshot", async t => {
  const f = fixture(t); await f.queue(1); f.state.canSend = false;
  await f.service.processQueue(); assert.equal(f.state.sends.length, 0);
  f.state.canSend = true; f.service.cache.clear();
  await f.service.processQueue(); assert.equal(f.state.sends.length, 1);
});

test("a saved-history source cannot authorize automatic steering even if it advertises active and canSend", async t => {
  const f = fixture(t); await f.queue(1);
  f.service.request = payload => payload.operation === "history"
    ? Promise.resolve({ ...f.history(), source: "rollout", canAttemptSend: true }) : f.request(payload);
  await f.service.processQueue();
  assert.equal(f.state.sends.length, 0);
  assert.equal(f.service.outbox(id)[0].status, "queued");
});

test("known-unsent readiness failures remain queued without allowing unknown outcomes to replay", async t => {
  const f = fixture(t); await f.queue(1);
  f.state.outcome = { ok: false, sent: false, code: "thread_not_ready" };
  await f.service.processQueue();
  assert.equal(f.state.sends.length, 1);
  assert.equal(f.service.outbox(id)[0].status, "queued");
  f.state.outcome = { ok: false, sent: null, code: "dispatch_unknown" };
  await f.service.processQueue();
  assert.equal(f.service.outbox(id)[0].status, "unknown");
  await f.service.processQueue();
  assert.equal(f.state.sends.length, 2);
});

test("a lost connection during automatic dispatch stays queued without opening a new owner", async t => {
  const f = fixture(t); await f.queue(1);
  let opened = 0; f.service.openThread = async () => { opened++; };
  f.state.outcome = { ok: false, sent: false, code: "desktop_unavailable" };
  await f.service.processQueue();
  assert.equal(f.service.outbox(id)[0].status, "queued");
  assert.equal(opened, 0);
  assert.equal(f.service.connection(id).status, "idle");
});

test("restart holds a pending automatic dispatch as unknown and reconciles only the exact original ID", async t => {
  const f = fixture(t); await f.queue(1);
  f.store.db.prepare("UPDATE dispatches SET status='pending' WHERE id=?").run(rid(1));
  f.restart();
  assert.equal(f.service.outbox(id)[0].autoDirect, true);
  assert.equal(f.service.getReceipt(id, rid(1)).status, "unknown");
  f.state.messages = [{ id: "different-native-message", role: "user", text: "Instruction 1", clientMessageId: rid(2), turnId }];
  await f.service.history(id); await f.service.processQueue();
  assert.equal(f.service.getReceipt(id, rid(1)).status, "unknown");
  assert.equal(f.state.sends.length, 0);
  f.state.messages = [{ id: "original-native-message", role: "user", text: "Instruction 1", clientMessageId: rid(1), turnId }];
  f.service.cache.clear(); await f.service.history(id);
  assert.equal(f.service.getReceipt(id, rid(1)).status, "accepted");
  assert.equal(f.service.outbox(id).length, 0);
  assert.equal(f.state.sends.length, 0);
});

test("manual direct send keeps the user's explicit ability to send a rejected item across a queue pause", async t => {
  const f = fixture(t); await f.queue(1);
  f.store.db.prepare("UPDATE dispatches SET status='rejected' WHERE id=?").run(rid(1));
  f.store.db.prepare("INSERT INTO queue_pauses(thread_id,stop_id,created_at) VALUES(?,?,?)").run(id, rid(90), Date.now());
  assert.equal((await f.service.dispatchQueued(id, rid(1), { expectedRevision: 0 })).status, "accepted");
  assert.equal(f.state.sends[0].delivery, "now");
  assert.equal(f.service.stops.pause(id).stopId, rid(90));
});

test("attachment-only auto-direct input retains the original binding, hash and request ID after restart", async t => {
  const f = fixture(t), bytes = Buffer.from("Synthetic attachment for the original request");
  const uploaded = await f.service.attachments.upload(id, attachmentId, "notes.txt", "text/plain", Readable.from([bytes]));
  await f.queue(1, { text: "", attachments: [attachmentId] });
  f.restart();
  assert.deepEqual(f.service.outbox(id)[0].attachments.map(item => item.id), [attachmentId]);
  await f.service.processQueue();
  assert.equal(f.state.sends.length, 1);
  const sent = f.state.sends[0];
  assert.equal(sent.requestId, rid(1)); assert.equal(sent.text, ""); assert.equal(sent.delivery, "auto-now");
  assert.equal(sent.attachments[0].id, attachmentId); assert.equal(sent.attachments[0].sha256, uploaded.sha256);
  assert.equal(f.service.getReceipt(id, rid(1)).status, "accepted");
  assert.equal(f.service.outbox(id).length, 0);
});

for (const delivery of ["queued auto-now", "new direct submission"]) {
  test(`a stop during attachment preparation holds ${delivery} before any native send`, { timeout: 5000 }, async t => {
    const f = fixture(t), bytes = Buffer.from("Synthetic attachment held during a stop");
    const uploaded = await f.service.attachments.upload(id, attachmentId, "notes.txt", "text/plain", Readable.from([bytes]));
    const input = { requestId: rid(1), text: "Keep this exact instruction", attachments: [attachmentId], autoDirect: true };
    if (delivery === "queued auto-now") await f.service.send(id, { ...input, enqueue: true });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const preparing = new Promise(resolve => { entered = resolve; });
    const prepare = f.service.attachments.prepare.bind(f.service.attachments);
    f.service.attachments.prepare = async saved => { entered(); await gate; return prepare(saved); };
    const submitting = delivery === "queued auto-now" ? f.service.processQueue() : f.service.send(id, input);
    await preparing;
    assert.equal(f.service.getReceipt(id, rid(1)).status, "pending");
    assert.equal(f.state.sends.length, 0, "Preparation has not yet called the native bridge");
    try {
      assert.equal((await f.service.stop(id, { requestId: rid(90), expectedTurnId: turnId })).status, "accepted");
    } finally { release(); }
    await submitting;
    assert.equal(f.state.stops.length, 1);
    assert.equal(f.state.sends.length, 0, "A stop arriving before bridge dispatch must prevent the send");
    assert.equal(f.service.getReceipt(id, rid(1)).status, "queued");
    assert.equal(f.service.stops.pause(id).stopId, rid(90));
    const [held] = f.service.outbox(id);
    assert.equal(held.id, rid(1)); assert.equal(held.text, input.text); assert.equal(held.autoDirect, true);
    assert.equal(held.attachments[0].id, attachmentId); assert.equal(held.attachments[0].sha256, uploaded.sha256);
    assert.equal((await f.service.send(id, input)).status, "queued", "The original request remains idempotent");
    await f.service.processQueue(); assert.equal(f.state.sends.length, 0);
  });
}

test("quick-create first-query intent survives lifecycle recovery without recreating or duplicating its message", async t => {
  for (const extra of [{ autoDirect: true }, { autoDirect: false }, {}]) await t.test(JSON.stringify(extra), async t => {
    const f = fixture(t), created = "eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee";
    let creates = 0, hasCreated = false, lifecycle;
    const creationSource = () => ({ ...source(), threads: [...source().threads,
      ...(hasCreated ? [{ id: created, title: "Created fixture", cwd: f.directory, archived: false }] : [])] });
    const initialize = () => {
      lifecycle = new LifecycleService(f.store, f.service, f.directory, () => f.store.sync(creationSource()), {
        locations: () => [{ id: "fixture-location", label: "Fixture", cwd: f.directory }],
        create: async payload => {
          creates++; hasCreated = true;
          writeFileSync(payload.receiptPath, JSON.stringify({ requestId: payload.requestId, threadId: created }));
          return { status: "created", threadId: created, verified: true, processStopped: true };
        },
      });
    };
    initialize(); t.after(() => lifecycle.stop());
    const input = { requestId: rid(80), locationId: "fixture-location", initialQuery: "Synthetic first query", ...extra };
    lifecycle.startCreate(input); await lifecycle.running.get(input.requestId);
    const receipt = lifecycle.receipt(lifecycle.row(input.requestId)), messageId = receipt.initialMessage.requestId;
    assert.equal(receipt.status, "succeeded"); assert.equal(receipt.initialMessage.status, "queued");
    assert.notEqual(messageId, input.requestId);
    assert.equal(f.service.outbox(created)[0].autoDirect, extra.autoDirect === true);
    assert.equal(f.state.sends.length, 0, "Creating the conversation must only persist its first query");
    lifecycle.stop(); f.restart(); initialize();
    lifecycle.startCreate(input); await lifecycle.get(input.requestId);
    assert.equal(creates, 1);
    assert.deepEqual(f.service.outbox(created).map(item => item.id), [messageId]);
    assert.equal(f.service.outbox(created)[0].autoDirect, extra.autoDirect === true);
    await f.service.processQueueForThread(created);
    if (extra.autoDirect !== true) {
      assert.equal(f.state.sends.length, 0);
      f.state.runtime = "idle"; f.state.turnStatus = "completed"; f.service.cache.clear();
      await f.service.processQueueForThread(created);
    }
    assert.equal(f.state.sends.length, 1);
    assert.equal(f.state.sends[0].requestId, messageId); assert.equal(f.state.sends[0].threadId, created);
    assert.equal(f.state.sends[0].delivery, extra.autoDirect === true ? "auto-now" : "auto");
    assert.throws(() => lifecycle.startCreate({ ...input, autoDirect: extra.autoDirect !== true }), e => e.status === 409);
    await f.service.processQueueForThread(created); assert.equal(f.state.sends.length, 1);
  });
});

test("quick-create refuses invalid or queryless automatic intent before reserving a lifecycle operation", async t => {
  const f = fixture(t);
  const lifecycle = new LifecycleService(f.store, f.service, f.directory, () => {}, {
    locations: () => [{ id: "fixture-location", label: "Fixture", cwd: f.directory }],
    create: async () => assert.fail("Invalid creation input must not reach the native creator"),
  });
  t.after(() => lifecycle.stop());
  for (const extra of [{ autoDirect: true }, { autoDirect: false }, { autoDirect: "true", initialQuery: "Synthetic query" },
    { autoDirect: null, initialQuery: "Synthetic query" }])
    assert.throws(() => lifecycle.startCreate({ requestId: rid(80), locationId: "fixture-location", ...extra }), e => e.status === 400);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM lifecycle_operations").get().n, 0);
});

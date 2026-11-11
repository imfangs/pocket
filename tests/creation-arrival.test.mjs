import test from "node:test";
import assert from "node:assert/strict";
import { createCreationArrival, creationConfirmationWindowMs } from "../src/creationArrival.ts";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const operation = extra => ({ requestId: id, operation: "create", status: "succeeded", creationStatus: "created",
  createdAt: 1000, threadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  initialMessage: { requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "accepted" }, ...extra });
function fixture(confirmedAt = new Map()) {
  let now = 2000;
  const dismissed = [], persisted = [];
  const arrival = createCreationArrival({ confirmedAt, now: () => now,
    saveConfirmed: values => persisted.push(new Map(values)),
    dismiss: requestId => { assert.equal(arrival.getDraft(requestId), undefined, "input is released before receipt tracking retires"); dismissed.push(requestId); } });
  return { arrival, dismissed, persisted, now: value => { now = value; } };
}

test("a locally observed confirmation has one fixed deadline and releases full input at expiration without a catalog", () => {
  const f = fixture(), input = { initialQuery: "Q".repeat(16000), name: "Temporary title" };
  f.arrival.remember(id, input, { id: "location", cwd: "/synthetic", projectName: "Synthetic" });
  assert.equal(f.arrival.getDraft(id).input, input);
  assert.equal(f.arrival.observe([operation()]), true);
  const deadline = 2000 + creationConfirmationWindowMs;
  assert.equal(f.arrival.nextDeadline([operation()]), deadline);
  f.now(9000); f.arrival.observe([operation()]);
  assert.equal(f.arrival.nextDeadline([operation()]), deadline, "list rereads cannot renew the green cue");
  assert.equal(f.persisted.length, 1);
  assert.equal(JSON.stringify([...f.persisted[0]]).includes(input.initialQuery), false, "only confirmation metadata may persist");
  f.now(deadline); f.arrival.expire([operation()]);
  assert.deepEqual(f.dismissed, [id]);
  assert.equal(f.arrival.getDraft(id), undefined);
  assert.equal(f.arrival.nextDeadline([operation()]), null);
  f.arrival.observe([operation()]); f.arrival.retire(id);
  assert.deepEqual(f.dismissed, [id], "a late duplicate receipt cannot reintroduce input or repeat retirement");
});

test("an expired result restored or resumed without its row retires every temporary input", () => {
  const f = fixture(new Map([[id, 1000]])); f.arrival.remember(id, { initialQuery: "Recoverable text" });
  f.now(1000 + creationConfirmationWindowMs);
  assert.equal(f.arrival.observe([operation()]), false);
  assert.deepEqual(f.dismissed, [id]); assert.equal(f.arrival.getDraft(id), undefined);
  assert.equal(f.arrival.recent(operation()), false);
  assert.deepEqual(f.persisted, []);
});

test("unknown, rejected, queued and editing creation inputs have no confirmation expiry and remain recoverable", () => {
  for (const value of [operation({ status: "unknown" }), operation({ status: "rejected", creationStatus: undefined }),
    operation({ initialMessage: { requestId: "first", status: "queued" } }), operation({ initialMessage: { requestId: "first", status: "editing" } })]) {
    const f = fixture(); f.arrival.remember(id, { initialQuery: "Original pending input" }); f.arrival.observe([value]);
    f.now(1000 + creationConfirmationWindowMs * 20); f.arrival.observe([value]); f.arrival.expire([value]);
    assert.equal(f.arrival.getDraft(id).input.initialQuery, "Original pending input");
    assert.equal(f.arrival.nextDeadline([value]), null); assert.deepEqual(f.dismissed, []);
  }
});

test("a late confirmation after a long locally observed wait begins its window once", () => {
  const f = fixture(); f.arrival.observe([operation({ status: "pending" })]);
  f.now(1000 + creationConfirmationWindowMs * 10);
  assert.equal(f.arrival.observe([operation()]), true);
  assert.equal(f.arrival.nextDeadline([operation()]), 1000 + creationConfirmationWindowMs * 11);
});

test("an old unobserved server confirmation cannot acquire a new window", () => {
  const f = fixture(); f.now(1000 + creationConfirmationWindowMs);
  assert.equal(f.arrival.observe([operation()]), false); assert.deepEqual(f.dismissed, [id]);
  assert.deepEqual(f.persisted, []);
});

test("a cancelled first message and an explicit rejected-input discard share the full cleanup path", () => {
  const f = fixture(); f.arrival.remember(id, { initialQuery: "Cancelled first input" });
  f.arrival.observe([operation({ initialMessage: { requestId: "first", status: "cancelled" } })]);
  assert.deepEqual(f.dismissed, [id]); assert.equal(f.arrival.getDraft(id), undefined);
  const second = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  f.arrival.remember(second, { initialQuery: "Rejected input" }); f.arrival.retire(second);
  assert.deepEqual(f.dismissed, [id, second]); assert.equal(f.arrival.getDraft(second), undefined);
});

test("explicitly stopping unknown creation recovery releases its unreachable input while keeping the possible-created receipt unchanged", () => {
  const f = fixture(), waiting = operation({ status: "unknown", creationStatus: "created",
    initialMessage: { requestId: "first", status: "unknown" } });
  f.arrival.remember(id, { initialQuery: "Unknown creation input" }); f.arrival.observe([waiting]);
  f.now(1000 + creationConfirmationWindowMs * 10); f.arrival.expire([waiting]);
  assert.equal(f.arrival.getDraft(id).input.initialQuery, "Unknown creation input", "time alone cannot discard recovery input");
  const cancelled = { ...waiting, status: "cancelled" }, before = JSON.stringify(cancelled);
  f.arrival.observe([cancelled]);
  assert.equal(f.arrival.getDraft(id), undefined); assert.deepEqual(f.dismissed, [id]);
  assert.equal(JSON.stringify(cancelled), before, "retirement cannot delete or deny a possibly created native conversation");
  f.arrival.observe([waiting, operation()]); f.arrival.remember(id, { initialQuery: "Late duplicate input" });
  assert.equal(f.arrival.getDraft(id), undefined); assert.deepEqual(f.dismissed, [id], "a late receipt cannot replay or restore released input");
});

test("unrelated cancelled lifecycle operations cannot retire creation input", () => {
  const f = fixture(); f.arrival.remember(id, { initialQuery: "Creation input" });
  f.arrival.observe([operation({ operation: "archive", status: "cancelled" }), operation({ operation: "restore", status: "cancelled" })]);
  assert.equal(f.arrival.getDraft(id).input.initialQuery, "Creation input"); assert.deepEqual(f.dismissed, []);
});

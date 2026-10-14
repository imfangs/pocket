import test from "node:test";
import assert from "node:assert/strict";
import { needsUserInput, smartThreadOrder, smartThreadScore } from "../src/smartOrder.ts";

const day = 86400000;
const now = Date.UTC(2026, 9, 14, 8);
const thread = (id, overrides = {}) => ({
  id, title: id, archived: false, missing: false, separator: false,
  pinned: false, pinSource: "codex", pinnedOrder: -1,
  updatedAt: now - day, createdAt: now - 30 * day, ...overrides,
});
const order = (threads, extra = {}) => smartThreadOrder(threads, { now, ...extra }).map(item => item.id);
const score = (item, extra = {}) => smartThreadScore(item, { now, ...extra });

test("an explicit Pocket pin stays ahead of all ordinary attention factors", () => {
  const pin = thread("manual", { pinned: true, pinSource: "pocket", updatedAt: now - 90 * day });
  const waiting = thread("waiting", { pinned: true, updatedAt: now, createdAt: now, needsInput: true });
  assert.deepEqual(order([waiting, pin], {
    runtimeStates: new Map([[waiting.id, "waiting_approval"]]), draftIds: new Set([waiting.id]),
    pocketActivity: new Map([[waiting.id, { createdAt: now, visitedAt: now }]]),
  }), ["manual", "waiting"]);
});

test("new completions and confirmed questions can outrank an inactive Codex pin", () => {
  const oldPin = thread("codex", { pinned: true, updatedAt: now - 60 * day });
  const completed = thread("completed", { needsInput: true, updatedAt: now });
  const waiting = thread("waiting", { updatedAt: now - 60 * day });
  assert.deepEqual(order([oldPin, completed, waiting], {
    runtimeStates: new Map([[waiting.id, "waiting_input"]]),
  }), ["waiting", "completed", "codex"]);
});

test("a Pocket false override has no inherited Codex boost or hard pin priority", () => {
  const ordinary = thread("ordinary");
  const override = thread("override", { pinned: false, pinSource: "pocket", pinnedOrder: -30 });
  const codex = thread("codex", { pinned: true });
  assert.equal(score(override), score(ordinary));
  assert.deepEqual(order([override, ordinary, codex]), ["codex", "ordinary", "override"]);
});

test("both waiting states need input; running supersedes a stale unread completion", () => {
  const unread = thread("one", { needsInput: true });
  assert.equal(needsUserInput(unread, "running"), false);
  assert.equal(needsUserInput(unread, "idle"), true);
  for (const state of [undefined, "unknown"]) {
    assert.equal(needsUserInput(unread, state), true);
    assert.equal(needsUserInput(thread("read"), state), false);
  }
  for (const state of ["waiting_input", "waiting_approval"]) {
    assert.equal(needsUserInput(thread("read"), state), true);
    const runtimeStates = new Map([[unread.id, state]]);
    assert.equal(score(unread, { runtimeStates }), score({ ...unread, needsInput: false }, { runtimeStates }));
  }
  const runtimeStates = new Map([[unread.id, "running"]]);
  assert.equal(score(unread, { runtimeStates }), score({ ...unread, needsInput: false }, { runtimeStates }));
});

test("archived, missing, and separator records never count as waiting for the user", () => {
  for (const flag of ["archived", "missing", "separator"]) {
    for (const status of [undefined, "running", "waiting_input", "waiting_approval", "unknown", "idle"])
      assert.equal(needsUserInput(thread(flag, { [flag]: true, needsInput: true }), status), false);
  }
});

test("old completed unread items yield to recent work instead of staying above it forever", () => {
  const old = thread("old", { updatedAt: now - 45 * day, createdAt: now - 60 * day, needsInput: true });
  const current = thread("current", { updatedAt: now - 60000 });
  assert.deepEqual(order([old, current]), ["current", "old"]);
  const freshUnread = { ...old, updatedAt: now };
  assert.ok(score(freshUnread) > score(current));
  assert.ok(smartThreadScore(freshUnread, { now: now + 7 * day }) < score(freshUnread));
});

test("drafts and confirmed execution help surface resumable work without treating unknown as running", () => {
  const draft = thread("draft"), running = thread("running"), ordinary = thread("ordinary"), unknown = thread("unknown");
  const runtimeStates = new Map([[running.id, "running"], [unknown.id, "unknown"]]);
  const options = { runtimeStates, draftIds: new Set([draft.id]) };
  assert.deepEqual(order([ordinary, unknown, running, draft], options), ["draft", "running", "ordinary", "unknown"]);
  assert.equal(score(unknown, options), score(ordinary, options));
  assert.equal(score({ ...draft, lastOpenedAt: now }, options), score(draft, options));
});

test("new creation is a small boost while a just completed older conversation still leads", () => {
  const empty = thread("new", { createdAt: now, updatedAt: now });
  const completed = thread("completed", { needsInput: true, updatedAt: now - 60000 });
  assert.deepEqual(order([empty, completed]), ["completed", "new"]);
  assert.ok(score(empty) > score({ ...empty, createdAt: now - 30 * day }));
});

test("missing and separator records stay searchable in the output but cannot consume any priority signal", () => {
  const ordinary = thread("ordinary", { updatedAt: 1, createdAt: 1 });
  const unavailable = ["missing", "separator"].map(flag => thread(flag, {
    [flag]: true, pinned: true, pinSource: "pocket", needsInput: true, updatedAt: now, createdAt: now,
  }));
  const options = {
    draftIds: new Set(unavailable.map(item => item.id)),
    runtimeStates: new Map(unavailable.map(item => [item.id, "waiting_approval"])),
    pocketActivity: new Map(unavailable.map(item => [item.id, { createdAt: now, visitedAt: now }])),
  };
  for (const item of unavailable) assert.equal(score(item, options), 0);
  assert.deepEqual(order([...unavailable, ordinary], options), ["ordinary", "missing", "separator"]);
});

test("future thread timestamps are bounded at the supplied clock and invalid timestamps receive no freshness", () => {
  const current = thread("clock", { updatedAt: now, createdAt: now, needsInput: true });
  const future = { ...current, updatedAt: now + 365 * day, createdAt: Number.MAX_VALUE };
  assert.equal(score(future), score(current));
  for (const value of [NaN, Infinity, -Infinity, -1, 0, undefined, null, "yesterday"]) {
    const invalid = thread("invalid", { updatedAt: value, createdAt: value, needsInput: true });
    assert.equal(score(invalid), 0);
    assert.deepEqual(order([invalid, current]), ["clock", "invalid"]);
  }
  for (const invalidNow of [NaN, Infinity, -1])
    assert.ok(Number.isFinite(smartThreadScore(current, { now: invalidNow })));
});

test("all contributions remain bounded even when all supported hints are present", () => {
  const item = thread("max", { pinned: true, needsInput: true, createdAt: Number.MAX_VALUE, updatedAt: Number.MAX_VALUE });
  for (const status of [undefined, "idle", "unknown", "running", "waiting_input", "waiting_approval"]) {
    const value = score(item, { draftIds: new Set([item.id]), runtimeStates: new Map([[item.id, status]]),
      pocketActivity: new Map([[item.id, { createdAt: Number.MAX_VALUE, visitedAt: Number.MAX_VALUE }]]),
    });
    assert.ok(Number.isFinite(value) && value >= 0 && value < 800, `${status}: ${value}`);
  }
});

test("equal scores use timestamps, pin order, then ID consistently regardless of catalog input order", () => {
  const make = (id, overrides = {}) => thread(id, { missing: true, ...overrides });
  const updated = make("updated", { updatedAt: now });
  const created = make("created", { createdAt: now });
  const pinned = make("pinned", { pinned: true, pinnedOrder: -2 });
  const a = make("a"), z = make("z");
  const expected = ["updated", "created", "pinned", "a", "z"];
  const input = [z, pinned, created, a, updated];
  assert.deepEqual(order(input), expected);
  assert.deepEqual(order([...input].reverse()), expected);
});

test("sorting leaves input objects, arrays, runtime state, drafts, and Pocket activity untouched", () => {
  const a = Object.freeze(thread("a")), b = Object.freeze(thread("b", { needsInput: true }));
  const input = Object.freeze([a, b]);
  const runtimeStates = new Map([[a.id, "running"]]), draftIds = new Set([a.id]);
  const activity = Object.freeze({ createdAt: now - day, visitedAt: now });
  const pocketActivity = new Map([[a.id, activity]]), beforeActivity = [...pocketActivity];
  const beforeRuntime = [...runtimeStates], beforeDrafts = [...draftIds];
  const output = smartThreadOrder(input, { now, runtimeStates, draftIds, pocketActivity });
  assert.notEqual(output, input);
  assert.equal(output.find(item => item.id === a.id), a);
  assert.equal(output.find(item => item.id === b.id), b);
  assert.deepEqual(input, [a, b]);
  assert.deepEqual([...runtimeStates], beforeRuntime);
  assert.deepEqual([...draftIds], beforeDrafts);
  assert.deepEqual([...pocketActivity], beforeActivity);
  assert.equal(pocketActivity.get(a.id), activity);
});

test("recent Pocket creation and deliberate visits surface a conversation among otherwise equal work", () => {
  const untouched = thread("untouched"), created = thread("created"), visited = thread("visited");
  const pocketActivity = new Map([[created.id, { createdAt: now }], [visited.id, { visitedAt: now }]]);
  assert.deepEqual(order([untouched, created, visited], { pocketActivity }), ["visited", "created", "untouched"]);
  for (const item of [created, visited]) assert.ok(score(item, { pocketActivity }) > score(item));
});

test("Pocket activity bonuses decay, and a single visit does not displace a fresh completion or confirmed question", () => {
  const visited = thread("visited", { updatedAt: now, createdAt: now });
  const completed = thread("completed", { needsInput: true, updatedAt: now - 60000 });
  const waiting = thread("waiting", { updatedAt: now - 30 * day });
  const pocketActivity = new Map([[visited.id, { createdAt: now, visitedAt: now }]]);
  const runtimeStates = new Map([[waiting.id, "waiting_input"]]);
  assert.deepEqual(order([visited, completed, waiting], { pocketActivity, runtimeStates }), ["waiting", "completed", "visited"]);
  for (const field of ["createdAt", "visitedAt"]) {
    const hint = new Map([[visited.id, { [field]: now }]]);
    const initialBonus = score(visited, { pocketActivity: hint }) - score(visited);
    const laterClock = now + 10 * day;
    const laterBonus = smartThreadScore(visited, { now: laterClock, pocketActivity: hint }) - smartThreadScore(visited, { now: laterClock });
    assert.ok(laterBonus >= 0 && laterBonus < initialBonus / 10);
  }
});

test("a catalog or runtime poll with no recorded Pocket activity cannot invent a creation or visit bonus", () => {
  const item = thread("observed");
  const baseline = score(item);
  for (const pocketActivity of [undefined, new Map(), new Map([[item.id, {}]]), new Map([["different-thread", { createdAt: now, visitedAt: now }]])]) {
    assert.equal(score({ ...item, lastOpenedAt: now }, { pocketActivity, runtimeStates: new Map([[item.id, "idle"]]) }), baseline);
  }
});

test("future and malformed Pocket activity cannot create unbounded freshness or mutate the stored event", () => {
  const item = thread("observed");
  const current = new Map([[item.id, { createdAt: now, visitedAt: now }]]);
  const future = new Map([[item.id, Object.freeze({ createdAt: Number.MAX_VALUE, visitedAt: now + 365 * day })]]);
  assert.equal(score(item, { pocketActivity: future }), score(item, { pocketActivity: current }));
  assert.equal(future.get(item.id).createdAt, Number.MAX_VALUE);
  const bonus = score(item, { pocketActivity: current }) - score(item);
  assert.ok(bonus > 0 && bonus <= 100 + 1e-10);
  for (const value of [NaN, Infinity, -Infinity, -1, 0, undefined, null, "today"]) {
    assert.equal(score(item, { pocketActivity: new Map([[item.id, { createdAt: value, visitedAt: value }]]) }), score(item));
  }
});

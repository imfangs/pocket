import test from "node:test";
import assert from "node:assert/strict";
import { retainReadableConversationPrefix } from "../src/readableConversationContinuity.ts";

const row = (id, turnId = "latest", extra = {}) => Object.freeze({
  id, turnId, role: "assistant", phase: "commentary", text: `${id} text`, ...extra,
});
const view = (messages, hasMore = false) => Object.freeze({ messages: Object.freeze(messages), hasMore });
const preserve = retainReadableConversationPrefix;
const assertFresh = (before, fresh) => {
  const result = preserve(before, fresh);
  assert.equal(result.messages, fresh.messages);
  assert.equal(result.hasMore, fresh.hasMore);
  assert.equal(result.retained, false);
};

test("native prefix survives a short fallback and fresh non-prefix final remains authoritative", () => {
  const prefix = [row("older-user", "older", { role: "user" }), row("older-final", "older", { phase: "final_answer" }), row("opening", "latest", { role: "user" })];
  const shared = row("progress"), nativeFinal = row("final", "latest", { phase: "final_answer", text: "Native summary" });
  const freshFinal = row("final", "latest", { phase: "final_answer", text: "Different complete recorded answer", files: { out: { name: "Result", url: "/api/file" } } });
  const previous = view([...prefix, shared, nativeFinal], true), fresh = view([shared, freshFinal], true);
  const beforeJSON = JSON.stringify(previous), freshJSON = JSON.stringify(fresh), result = preserve(previous, fresh);
  assert.deepEqual(result.messages, [...prefix, shared, freshFinal]);
  for (let i = 0; i < prefix.length; i++) assert.equal(result.messages[i], prefix[i]);
  assert.equal(result.messages.at(-1), freshFinal); assert.equal(result.messages.at(-2), shared);
  assert.equal(result.retained, true); assert.equal(result.hasMore, true);
  assert.equal(JSON.stringify(previous), beforeJSON); assert.equal(JSON.stringify(fresh), freshJSON);
  assert.deepEqual(Object.keys(result).sort(), ["hasMore", "messages", "retained"]);
});

test("an opening fallback user with a different ID replaces the native user without text matching", () => {
  const older = row("older", "older", { phase: "final_answer" }), user = row("native-user", "latest", { role: "user", text: "Same request" });
  const progress = row("progress"), final = row("final", "latest", { phase: "final_answer" });
  const freshUser = row("saved-user", "latest", { role: "user", text: "Different source projection" });
  const fresh = view([freshUser, progress, final]), result = preserve(view([older, user, progress, final]), fresh);
  assert.deepEqual(result.messages, [older, freshUser, progress, final]);
  assert.equal(result.messages[1], freshUser); assert.equal(result.messages.includes(user), false);
});

test("a new turn following the exact shared final remains visible", () => {
  const older = row("older", "older"), final = row("old-final", "old", { phase: "final_answer" });
  const newUser = row("new-user", "new", { role: "user" }), newProgress = row("new-progress", "new");
  const fresh = view([final, newUser, newProgress]), result = preserve(view([older, final]), fresh);
  assert.deepEqual(result.messages, [older, final, newUser, newProgress]);
  assert.equal(result.retained, true);
});

test("no safe shared identity, absent previous or empty fresh projection uses fresh unchanged", () => {
  assertFresh(null, view([row("a")]));
  assertFresh(view([]), view([row("a")]));
  assertFresh(view([row("a")]), view([]));
  assertFresh(view([row("a")]), view([row("b", "latest", { text: "a text" })]));
  const previous = view([row("shared")]);
  for (const extra of [{ role: "user" }, { turnId: "different" }, { turnId: null }, { turnId: undefined }])
    assertFresh(previous, view([row("shared", "latest", extra)]));
});

test("ambiguous duplicate IDs and reordered shared records cannot establish continuity", () => {
  const older = row("older", "older"), a = row("a"), b = row("b");
  assertFresh(view([older, a, b]), view([b, a]));
  assertFresh(view([older, a, a, b]), view([a, b]));
  assertFresh(view([older, a, b]), view([a, a, b]));
  assertFresh(view([older, row(" "), b]), view([b]));
  assertFresh(view([older, a, b]), view([row(""), b]));
});

test("an older or divergent fallback cannot hide a later native turn", () => {
  const older = row("older", "older"), final = row("final", "previous", { phase: "final_answer" });
  const newUser = row("new-user", "new", { role: "user" });
  assertFresh(view([older, final, newUser]), view([final]));
  const end = row("latest-final", "latest", { phase: "final_answer" });
  assertFresh(view([older, final, newUser, end]), view([final, end]));
  assertFresh(view([older, final, row("steering-user", "previous", { role: "user" })]), view([final]));
});

test("new turns before shared tail and unknown turn identities do not splice branches", () => {
  const older = row("older", "older"), final = row("final", "previous", { phase: "final_answer" });
  assertFresh(view([older, final]), view([row("new", "new", { role: "user" }), final]));
  assertFresh(view([older, row("progress", "previous")]), view([row("progress", "previous"), row("new", "new")]));
  assertFresh(view([older, final]), view([final, row("unknown", undefined, { turnId: undefined })]));
});

test("unshared leading commentary and unrelated leading user remain an untouched fresh view", () => {
  const older = row("older", "older"), final = row("final", "latest", { phase: "final_answer" });
  assertFresh(view([older, final]), view([row("new-leading"), final]));
  assertFresh(view([older, final]), view([row("new-leading", "older", { role: "user" }), final]));
});

test("existing complete view and zero available retained prefix do not manufacture retention", () => {
  const a = row("a"), b = row("b", "latest", { phase: "final_answer" });
  assertFresh(view([a, b]), view([a, b]));
  assertFresh(view([row("native-user", "latest", { role: "user" }), b]), view([row("saved-user", "latest", { role: "user" }), b]));
});

test("retained prefix uses at most 80 rows, evicting older prefix only and preserving fresh references", () => {
  const prefix = Array.from({ length: 75 }, (_, index) => row(`older-${index}`, "older"));
  const tail = Array.from({ length: 19 }, (_, index) => row(`tail-${index}`, "latest", { phase: index === 18 ? "final_answer" : "commentary" }));
  const fresh = view(tail), result = preserve(view([...prefix, ...tail]), fresh);
  assert.equal(result.messages.length, 80); assert.equal(result.messages[0], prefix[14]);
  assert.deepEqual(result.messages.slice(-19), fresh.messages);
  assert.equal(result.hasMore, true); assert.equal(result.retained, true);
  for (let i = 0; i < tail.length; i++) assert.equal(result.messages[61 + i], tail[i]);
});

test("character limit evicts whole older prefix rows without truncating any authoritative body", () => {
  const first = row("first", "older", { text: "x".repeat(20000) }), nearby = row("nearby", "older", { text: "y".repeat(20000) });
  const final = row("final", "latest", { phase: "final_answer", text: "z".repeat(135000) });
  const fresh = view([final]), result = preserve(view([first, nearby, final]), fresh);
  assert.deepEqual(result.messages, [nearby, final]); assert.equal(result.messages.at(-1), final);
  assert.equal(result.hasMore, true); assert.equal(result.retained, true);
  assertFresh(view([nearby, final]), view([row("final", "latest", { phase: "final_answer", text: "z".repeat(160001) })]));
});

test("fresh view at row budget is not truncated or altered", () => {
  const prefix = row("prefix", "older"), tail = Array.from({ length: 80 }, (_, index) => row(`row-${index}`));
  assertFresh(view([prefix, ...tail]), view(tail));
});

test("neither retained nor fresh result can carry incidental execution or read authority", () => {
  const final = row("final", "latest", { phase: "final_answer" });
  const fresh = { ...view([final]), canSend: true, canStop: true, runtime: "active", pocketContent: { version: "incidental" } };
  for (const previous of [null, view([row("older", "older"), final])]) {
    const result = preserve(previous, fresh);
    assert.deepEqual(Object.keys(result).sort(), ["hasMore", "messages", "retained"]);
    assert.equal(result.messages.at(-1), final);
  }
});


test("a replacement user cannot trim an interleaved native turn", () => {
  const older = row("older", "older", { phase: "final_answer" });
  const user = row("native-user", "latest", { role: "user" });
  const interleaved = row("interleaved-final", "another", { phase: "final_answer" });
  const progress = row("progress"), final = row("final", "latest", { phase: "final_answer" });
  const fresh = view([row("saved-user", "latest", { role: "user" }), progress, final]);
  assertFresh(view([older, user, interleaved, progress, final]), fresh);
});

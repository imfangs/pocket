import test from "node:test";
import assert from "node:assert/strict";
import { groupProgressMessages } from "../src/progressGroups.ts";

const progress = (id, turnId = "turn", extra = {}) => ({ id, role: "assistant", phase: "commentary", text: `Progress ${id}`, turnId, ...extra });
const final = (id = "final", turnId = "turn", extra = {}) => ({ id, role: "assistant", phase: "final_answer", text: "Final answer", turnId, ...extra });
const user = id => ({ id, role: "user", text: `User ${id}`, turnId: "turn" });
const shape = entries => entries.map(entry => entry.type === "progress" ? entry.messages.map(message => message.id) : entry.message.id);

test("a visible same-turn final folds only its preceding assistant commentary and retains the final reply", () => {
  const first = progress("first"), second = progress("second"), answer = final();
  assert.deepEqual(shape(groupProgressMessages([user("query"), first, second, answer])), ["query", ["first", "second"], "final"]);
  assert.deepEqual(shape(groupProgressMessages([first, final("answer", "turn", { phase: "final" })])), [["first"], "answer"]);
  assert.deepEqual(shape(groupProgressMessages([first, second])), ["first", "second"], "still-running or idle without a final is not completion evidence");
});

test("unknown identity, non-assistant finals, missing phases and other-turn finals never imply completion", () => {
  for (const turnId of [undefined, null, "", "  "]) {
    const messages = [{ ...progress("step"), turnId }, { ...final("answer"), turnId }];
    assert.deepEqual(shape(groupProgressMessages(messages)), ["step", "answer"]);
  }
  const messages = [progress("current"), progress("unphased", "turn", { phase: undefined }),
    progress("user-commentary", "turn", { role: "user" }), final("wrong-role", "turn", { role: "user" }),
    final("other-final", "other")];
  assert.deepEqual(shape(groupProgressMessages(messages)), messages.map(message => message.id));
  assert.deepEqual(shape(groupProgressMessages([
    progress("eligible"), progress("no-phase", "turn", { phase: undefined }),
    progress("other-phase", "turn", { phase: "analysis" }), progress("user-phase", "turn", { role: "user" }), final(),
  ])), [["eligible"], "no-phase", "other-phase", "user-phase", "final"]);
  assert.deepEqual(shape(groupProgressMessages([progress("step", "turn"), final("different-id", " turn ")])), ["step", "different-id"],
    "identity is exact, not inferred by trimming a non-empty ID");
});

test("empty, whitespace and hidden-only final bodies leave process messages open", () => {
  for (const text of ["", " \n\t ", "<oai-mem-citation><citation_entries>private provenance</citation_entries></oai-mem-citation>",
    "::archive-thread{reason=\"done\"}"]) {
    const messages = [progress("step"), final("empty-final", "turn", { text })];
    assert.deepEqual(shape(groupProgressMessages(messages)), ["step", "empty-final"]);
  }
  const example = final("example-final", "turn", { text: "`<oai-mem-citation>example</oai-mem-citation>`" });
  assert.deepEqual(shape(groupProgressMessages([progress("step"), example])), [["step"], "example-final"],
    "a visible code example is actual body content");
});

test("questions and protected messages stay at their exact position and split progress groups", () => {
  const messages = [progress("before"), progress("question", "turn", { isQuestion: true }), progress("middle"),
    progress("protected"), progress("after"), final()];
  const protectedIds = new Set(["protected"]);
  assert.deepEqual(shape(groupProgressMessages(messages, protectedIds)), [["before"], "question", ["middle"], "protected", ["after"], "final"]);
  assert.deepEqual([...protectedIds], ["protected"]);
});

test("user and unclassified messages split groups instead of moving process across content", () => {
  const messages = [progress("a"), user("interruption"), progress("b"),
    { id: "plain", role: "assistant", text: "Unclassified reply", turnId: "turn" }, progress("c"), final()];
  assert.deepEqual(shape(groupProgressMessages(messages)), [["a"], "interruption", ["b"], "plain", ["c"], "final"]);
});

test("interleaved turns keep separate contiguous groups without moving any message", () => {
  const messages = [progress("a-1", "a"), progress("b-1", "b"), progress("a-2", "a"),
    final("final-b", "b"), progress("b-after", "b"), final("final-a", "a")];
  assert.deepEqual(shape(groupProgressMessages(messages)), [["a-1"], ["b-1"], ["a-2"], "final-b", "b-after", "final-a"]);
});

test("commentary after the first visible final is left open even if another final with that turn appears", () => {
  const messages = [progress("before"), final("first-final"), progress("after"), final("second-final"), progress("last")];
  assert.deepEqual(shape(groupProgressMessages(messages)), [["before"], "first-final", "after", "second-final", "last"]);
  assert.deepEqual(shape(groupProgressMessages([final(), progress("after")])), ["final", "after"]);
});

test("groups keep stable IDs across changed message content and unrelated earlier history, without ambiguous concatenation", () => {
  const original = groupProgressMessages([progress("start"), progress("next"), final()])[0];
  const later = groupProgressMessages([user("older-query"), progress("start", "turn", { text: "Updated progress" }), progress("next"), final()])[1];
  assert.equal(original.id, later.id);
  const separate = groupProgressMessages([progress("start"), user("mid"), progress("later"), final()]);
  assert.notEqual(separate[0].id, separate[2].id);
  const a = groupProgressMessages([progress("b:c", "a"), final("fa", "a")])[0];
  const b = groupProgressMessages([progress("c", "a:b"), final("fb", "a:b")])[0];
  assert.notEqual(a.id, b.id);
});

test("flattening entries preserves original order, object identity, rich content and the untouched input", () => {
  const imageMap = Object.freeze({ "/sample/image.png": "/api/fixture-image" });
  const messages = Object.freeze([
    Object.freeze(user("query")), Object.freeze(progress("rich", "turn", { text: "Code\n```js\na()\n```", images: imageMap, truncated: true })),
    Object.freeze(progress("question", "turn", { isQuestion: true })), Object.freeze(progress("last")), Object.freeze(final()),
  ]);
  const before = JSON.stringify(messages);
  const grouped = groupProgressMessages(messages);
  const flattened = grouped.flatMap(entry => entry.type === "progress" ? entry.messages : [entry.message]);
  assert.equal(flattened.length, messages.length);
  flattened.forEach((message, index) => assert.equal(message, messages[index]));
  assert.equal(JSON.stringify(messages), before);
  assert.deepEqual(groupProgressMessages([]), []);
});

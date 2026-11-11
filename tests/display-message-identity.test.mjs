import test from "node:test";
import assert from "node:assert/strict";
import { uniqueDisplayMessages, renderMessageKey } from "../src/displayMessageIdentity.ts";

const message = (id = "shared", extra = {}) => ({
  id, role: "assistant", turnId: "turn", phase: "final_answer", text: "Original display text", ...extra,
});

test("only exact same-ID rows collapse, keeping first references and original order without touching the input", () => {
  const first = Object.freeze(message()), other = Object.freeze(message("other")), conflict = Object.freeze(message("shared", { text: "Changed answer" }));
  const input = Object.freeze([first, other, Object.freeze({ ...first }), conflict, Object.freeze({ ...conflict })]);
  const before = JSON.stringify(input), visible = uniqueDisplayMessages(input);
  assert.deepEqual(visible, [first, other, conflict]);
  assert.equal(visible[0], first); assert.equal(visible[1], other); assert.equal(visible[2], conflict);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(visible, input);
  assert.deepEqual(uniqueDisplayMessages([]), []);
});

test("every scalar display difference retains a conflicting same-ID row", () => {
  const changes = { role: "user", turnId: "other", phase: "commentary", text: "Other text", isQuestion: true,
    truncated: true, origin: "codex_delegation", clientMessageId: "request", turnDurationMs: 12, timestamp: 42 };
  for (const [field, value] of Object.entries(changes)) {
    const first = message(), changed = message("shared", { [field]: value });
    assert.deepEqual(uniqueDisplayMessages([first, changed]), [first, changed], field);
  }
});

test("different, empty and whitespace identities never collapse from matching text", () => {
  const input = [message("a"), message("b"), message(""), message(""), message(" "), message(" "), message("a ")];
  assert.deepEqual(uniqueDisplayMessages(input), input);
});

test("optional null and undefined stay distinct, including nested reference values", () => {
  for (const field of ["turnId", "phase", "isQuestion", "truncated", "origin", "clientMessageId", "turnDurationMs", "timestamp", "images", "files", "attachments"]) {
    const first = message("shared", { [field]: undefined }), second = message("shared", { [field]: null });
    assert.equal(uniqueDisplayMessages([first, second]).length, 2, field);
  }
  const absent = message("shared", { images: {} }), undefinedReference = message("shared", { images: { missing: undefined } });
  assert.equal(uniqueDisplayMessages([absent, undefinedReference]).length, 2);
  assert.equal(uniqueDisplayMessages([message("shared", { images: { missing: undefined } }), message("shared", { images: { missing: null } })]).length, 2);
});

test("equal images, files and ordered attachments may use distinct objects or object property order", () => {
  const first = message("shared", {
    images: { one: "/api/one", two: "/api/two" }, files: { document: { name: "Document", url: "/api/file" } },
    attachments: [{ id: "attachment", name: "Asset", url: "/api/attachment", size: 20 }],
  });
  const same = message("shared", {
    images: { two: "/api/two", one: "/api/one" }, files: { document: { url: "/api/file", name: "Document" } },
    attachments: [{ size: 20, url: "/api/attachment", name: "Asset", id: "attachment" }],
  });
  assert.deepEqual(uniqueDisplayMessages([first, same]), [first]);
  for (const patch of [
    { images: { ...first.images, one: "/api/changed" } },
    { files: { document: { ...first.files.document, name: "Changed" } } },
    { attachments: [{ ...first.attachments[0], url: "/api/changed" }] },
    { attachments: [] },
  ]) assert.equal(uniqueDisplayMessages([first, { ...same, ...patch }]).length, 2);
  const a = { id: "a" }, b = { id: "b" };
  assert.equal(uniqueDisplayMessages([message("shared", { attachments: [a, b] }), message("shared", { attachments: [b, a] })]).length, 2);
});

test("conflicting same-ID rows get distinct keys while unique IDs stay stable across earlier insertions", () => {
  const first = message("a:b"), conflict = message("a:b", { text: "Conflicting content" });
  const visible = uniqueDisplayMessages([first, message("other"), conflict]);
  const occurrences = new Map();
  const keys = visible.map(row => { const occurrence = occurrences.get(row.id) ?? 0; occurrences.set(row.id, occurrence + 1); return renderMessageKey(row, occurrence); });
  assert.equal(new Set(keys).size, visible.length);
  assert.equal(renderMessageKey(first), renderMessageKey(first, 0));
  assert.notEqual(renderMessageKey(first, 1), renderMessageKey(message('a:b",1')));
  assert.equal(renderMessageKey(message("other")), keys[1]);
  assert.equal(first.id, "a:b"); assert.equal(conflict.id, "a:b");
});

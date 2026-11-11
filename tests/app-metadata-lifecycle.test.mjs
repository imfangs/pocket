import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createCreationArrival } from "../src/creationArrival.ts";
import { creationCue } from "../src/creationList.ts";
import { hasPriorityState, pocketPriority, priorityFields } from "../src/priority.ts";
import { updateThreadPriority } from "../src/updateThreadPriority.ts";
import { preserveNewerThreadMetadata } from "../src/threadMetadata.ts";
import { preserveOpenThread } from "../src/model.ts";
import { protectedDraftThreadIds } from "../src/updateDrafts.ts";
import { visibleSubmittedQueries } from "../src/submittedQueries.ts";

// Exercise the actual App callback seams without mounting its unrelated UI.
// The optional fixed revision supports the same old/red versus new/green run;
// it reads Git only and never replaces the working source.
const revision = process.env.POCKET_CR_APP_REV;
if (revision && !/^[a-f0-9]{7,40}$/i.test(revision)) throw new Error("Use a fixed commit SHA for the App baseline");
const source = revision ? execFileSync("git", ["show", `${revision}:src/App.tsx`], { encoding: "utf8", cwd: new URL("..", import.meta.url) })
  : readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let observeCreation, recentCreation, prioritize, closeCreation, applyCatalog;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect") {
    const body = node.arguments[0]?.getText(tree);
    if (body?.includes("creationArrival.observe(taskOperations.creations)") || body?.includes("const confirmed = taskOperations.creations.filter"))
      observeCreation = body;
  }
  if (ts.isVariableDeclaration(node)) {
    if (node.name.getText(tree) === "recentCreationConfirmation") recentCreation = node.initializer.getText(tree);
    if (node.name.getText(tree) === "prioritizeThread") prioritize = node.initializer.getText(tree);
    if (node.name.getText(tree) === "setCatalog") applyCatalog = node.initializer.arguments[0].getText(tree);
  }
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "NewConversationDialog") {
    const attribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(tree) === "onClose");
    closeCreation = attribute?.initializer?.expression?.getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(observeCreation && recentCreation && prioritize && closeCreation && applyCatalog, "real App lifecycle callbacks remain accessible");
const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function priorityApp(initial, request, scopeRef) {
  let catalog = initial, invalidations = 0;
  const setCatalog = runInNewContext(compile(`(${applyCatalog})`), {
    setCatalogState(update) { catalog = update(catalog); },
    conversationDrafts: { current: new Map() }, conversationHistory: { current: new Map() },
    submissions: { getThread: () => [] }, selectedRef: { current: null },
    protectedDraftThreadIds, visibleSubmittedQueries, preserveOpenThread, preserveNewerThreadMetadata,
  });
  const prioritizeThread = runInNewContext(compile(`(${prioritize})`), {
    hasPriorityState, pocketPriority, priorityFields, updateThreadPriority, AbortSignal, api: request,
    catalogScope: scopeRef, catalogReader: { invalidate() { invalidations++; } }, setCatalog,
    refresh: () => Promise.resolve(catalog),
  });
  return { prioritizeThread, catalog: () => catalog, invalidations: () => invalidations };
}

test("App retirement on an aged confirmation releases local Query even when its row is no longer in the catalog", () => {
  const now = 700000, query = "Q".repeat(16000), dismissed = [];
  const operation = { requestId: id, operation: "create", status: "succeeded", creationStatus: "created", threadId: "thread",
    createdAt: 1000, initialMessage: { requestId: "first", status: "accepted" } };
  const taskOperations = { creations: [operation], dismiss(requestId) {
    dismissed.push(requestId); this.creations = this.creations.filter(value => value.requestId !== requestId);
  } };
  const creationArrival = createCreationArrival({ confirmedAt: new Map([[id, 1000]]), now: () => now,
    saveConfirmed() { throw Error("an expired cue cannot acquire a new deadline"); }, dismiss: requestId => taskOperations.dismiss(requestId) });
  creationArrival.remember(id, { initialQuery: query });
  const legacy = { creationDrafts: { current: new Map([[id, { input: { initialQuery: query } }]]) },
    creationQueries: { current: new Map([[id, query]]) }, observedCreationWaits: { current: new Set([id]) },
    creationConfirmedAt: new Map([[id, 1000]]) };
  runInNewContext(compile(`const recentCreationConfirmation = ${recentCreation}; (${observeCreation})();`), {
    ...legacy, creationArrival, taskOperations, creationCue, Date: { now: () => now },
    setCreationConfirmedAt() { throw Error("an expired cue cannot acquire a new deadline"); },
    refreshAfterActivity() { throw Error("an expired result cannot refresh another source"); },
  });
  assert.deepEqual(dismissed, [id]); assert.deepEqual(taskOperations.creations, []);
  const retained = observeCreation.includes("creationArrival.observe") ? creationArrival.getDraft(id) : legacy.creationDrafts.current.get(id);
  assert.equal(retained, undefined, "the successful operation disappearing must also release its complete input");
});

test("App rejects a late priority result from a replaced source before touching the new catalog", async () => {
  const thread = { id, pinned: false, pinnedOrder: 0, pinRevision: 0, codexPinned: false, pocketPriority: false };
  const original = { ...thread, title: "Same ID in new source" };
  const scopeRef = { current: "scope-a" }; let resolve;
  const response = new Promise(done => { resolve = done; });
  const app = priorityApp({ threads: [original] }, () => response, scopeRef);
  const action = app.prioritizeThread(thread); scopeRef.current = "scope-b";
  resolve({ ...thread, pinned: true, pocketPriority: true, pinRevision: 1 });
  await assert.rejects(action, /会话来源已变化/);
  assert.equal(app.invalidations(), 0, "an old write reply cannot supersede the new source read");
  assert.equal(app.catalog().threads[0], original);
});

test("the real App catalog wrapper preserves a newer same-source priority revision after an old write reply", async () => {
  const clicked = { id, pinned: false, pinnedOrder: 0, pinRevision: 5, codexPinned: false, pocketPriority: false };
  const latest = { ...clicked, pinRevision: 7, codexPinned: true };
  const app = priorityApp({ threads: [latest] }, async () => ({ ...clicked, pinned: true, pinRevision: 6, pocketPriority: true }), { current: "scope-a" });
  await app.prioritizeThread(clicked);
  assert.equal(app.catalog().threads[0].pinRevision, 7);
  assert.equal(app.catalog().threads[0].pocketPriority, false);
  assert.equal(app.catalog().threads[0].codexPinned, true);
});

test("closing the new-conversation dialog releases the App prefill and clipboard-result reference", () => {
  let prefill = { text: "Temporary input", clipboardRead: Promise.resolve({ text: "Temporary clipboard input" }) }, open = true;
  runInNewContext(compile(`(${closeCreation})();`), {
    newConversationClosing: false, selectedRef: { current: null }, newDialogOpen: { current: true },
    setNewConversationClosing() {}, setNewConversationOpen(value) { open = value; },
    setNewConversationDraft(value) { prefill = value; },
  });
  assert.equal(open, false); assert.equal(prefill, null);
});

test("App retires retained input after explicit cancellation even though an unknown native creation may exist", () => {
  const dismissed = [], operation = { requestId: id, operation: "create", status: "cancelled", threadId: "possible-thread", createdAt: 1000 };
  const taskOperations = { creations: [operation], dismiss(requestId) { dismissed.push(requestId); } };
  const creationArrival = createCreationArrival({ now: () => 2000, saveConfirmed() {}, dismiss: requestId => taskOperations.dismiss(requestId) });
  creationArrival.remember(id, { initialQuery: "Cancelled recovery input" });
  const legacy = { creationDrafts: { current: new Map([[id, { input: { initialQuery: "Cancelled recovery input" } }]]) },
    creationQueries: { current: new Map([[id, "Cancelled recovery input"]]) }, observedCreationWaits: { current: new Set([id]) }, creationConfirmedAt: new Map() };
  runInNewContext(compile(`const recentCreationConfirmation = ${recentCreation}; (${observeCreation})();`), {
    ...legacy, creationArrival, taskOperations, creationCue, Date: { now: () => 2000 },
    setCreationConfirmedAt() { throw Error("cancellation cannot confirm a creation"); }, refreshAfterActivity() {},
  });
  assert.deepEqual(dismissed, [id]);
  const retained = observeCreation.includes("creationArrival.observe") ? creationArrival.getDraft(id) : legacy.creationDrafts.current.get(id);
  assert.equal(retained, undefined); assert.equal(operation.threadId, "possible-thread");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseHistory, parseHistoryLines, readPersistedHistory } from "../server/history.mjs";
import { NavigatorStore } from "../server/store.mjs";
import { DesktopService } from "../server/desktop.mjs";
const id = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const rid = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const line = (role, text, phase) =>
  JSON.stringify({
    timestamp: "2026-09-28T00:00:00Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      phase,
      content: [{ type: "output_text", text }],
    },
  });
const event = (at, type, fields = {}) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type, ...fields } });
const message = (id, role, texts, kinds, extra = {}) => JSON.stringify({
  timestamp: "2026-09-28T00:00:05Z", type: "response_item", payload: {
    id, type: "message", role, phase: role === "assistant" ? "final_answer" : undefined,
    content: texts.map(text => ({ type: "input_text", text })),
    ...(kinds ? { internal_chat_message_metadata_passthrough: { content_item_kinds: kinds, ...extra } } : {}),
  },
});
test("provenance separates injected instructions from authored user text, including mixed content", () => {
  const data = parseHistoryLines([
    message("injected", "user", ["Repository rules", "Environment"], ["agents_md.instructions", "environments.environment_context"]),
    message("hooks", "user", ["Internal hook guidance"], ["hooks.additional_context"]),
    message("real", "user", ["Please explain AGENTS.md and memory"], ["user.text"]),
    message("mixed", "user", ["Environment", "Real question"], ["environments.environment_context", "user.text"]),
  ].join("\n"));
  assert.deepEqual(data.map(m => m.text), ["Please explain AGENTS.md and memory", "Real question"]);
});
test("legacy envelopes are hidden but explicit user quotations retain their original text", () => {
  const envelope = "# AGENTS.md instructions for /sample\n\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>";
  const data = parseHistoryLines([
    message("old", "user", [envelope]),
    message("quoted", "user", [envelope], ["user.text"]),
    message("discussion", "user", ["Could you improve the AGENTS.md instructions for this project?"]),
  ].join("\n"));
  assert.deepEqual(data.map(m => m.id), ["quoted", "discussion"]);
});
test("compaction response identity removes internal summaries without hiding the preceding real answer", () => {
  const text = [
    event("2026-09-28T00:00:00Z", "task_started", { turn_id: "real" }),
    message("answer", "assistant", ["The real final answer"], ["unknown"], { turn_id: "real" }),
    event("2026-09-28T00:00:10Z", "task_complete", { turn_id: "real", duration_ms: 10000 }),
    event("2026-09-28T00:00:20Z", "task_started", { turn_id: "internal" }),
    message("summary", "assistant", ["Any arbitrary summary wording"], ["unknown"], { turn_id: "internal" }),
    JSON.stringify({ type: "token_usage_record", payload: { response_id: "compaction-response" } }),
    JSON.stringify({ type: "compacted", payload: { compaction_response_id: "compaction-response", message: "Wrapped context" } }),
    event("2026-09-28T00:00:30Z", "task_complete", { turn_id: "internal", duration_ms: 10000 }),
  ].join("\n");
  const data = parseHistory(text);
  assert.deepEqual(data.messages.map(m => m.id), ["answer"]);
  assert.equal(data.turnTiming.turnId, "real");
  assert.equal(data.messages[0].turnDurationMs, 10000);
});
test("compaction envelope matches an untruncated summary and native visible events take precedence", () => {
  const summary = "S".repeat(25000);
  const data = parseHistoryLines([
    message("summary", "assistant", [summary]),
    JSON.stringify({ type: "compacted", payload: { message: "Runtime wrapper\n" + summary } }),
    message("visible", "assistant", ["A real summary requested by the user"]),
    event("2026-09-28T00:00:10Z", "item_completed", { item: { id: "visible", type: "AgentMessage" } }),
    JSON.stringify({ type: "compacted", payload: { message: "A real summary requested by the user" } }),
  ].join("\n"));
  assert.deepEqual(data.map(m => m.id), ["visible"]);
});
test("message provenance recovers native turn timing when the tail omits task_started", () => {
  const data = parseHistory([
    message("answer", "assistant", ["Answer"], ["unknown"], { turn_id: "clipped-turn" }),
    event("2026-09-28T00:00:10Z", "task_complete", { turn_id: "clipped-turn", duration_ms: 61000 }),
  ].join("\n"));
  assert.equal(data.messages[0].turnDurationMs, 61000);
});
test("saved turn durations exclude idle gaps and survive a missing start record", () => {
  const data = parseHistory([
    event("2026-09-28T00:00:00Z", "task_started", { turn_id: "one" }),
    line("assistant", "First", "final"),
    event("2026-09-28T00:02:00Z", "task_complete", { turn_id: "one", duration_ms: 119500 }),
    event("2026-09-28T01:00:00Z", "task_started", { turn_id: "two" }),
    line("assistant", "Second", "final_answer"),
    event("2026-09-28T01:00:20Z", "task_complete", { turn_id: "two", duration_ms: 20000 }),
  ].join("\n"));
  assert.deepEqual(data.messages.map(m => m.turnDurationMs), [119500, 20000]);
  assert.equal(data.turnTiming.durationMs, 20000);
  const clipped = parseHistory(event("2026-09-28T01:00:20Z", "task_complete", { turn_id: "two", duration_ms: 20000 }));
  assert.equal(clipped.turnTiming.durationMs, 20000);
  assert.equal(clipped.turnTiming.startedAt, null);
});
test("saved active timing ends at the last recorded activity, and abort freezes it", () => {
  const start = event("2026-09-28T01:00:00Z", "task_started", { turn_id: "one" });
  const activity = event("2026-09-28T01:00:10Z", "agent_message");
  const active = parseHistory(`${start}\n${activity}`).turnTiming;
  assert.equal(active.observedAt - active.startedAt, 10000);
  assert.equal(active.durationMs, null);
  const stopped = parseHistory(`${start}\n${activity}\n${event("2026-09-28T01:00:12Z", "turn_aborted")}`).turnTiming;
  assert.equal(stopped.status, "interrupted");
  assert.equal(stopped.durationMs, 12000);
  assert.equal(parseHistory(line("assistant", "Old answer", "final")).turnTiming, null);
});
function temporary(t) {
  const p = mkdtempSync(join(tmpdir(), "navigator-history-"));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
function store(t) {
  const s = new NavigatorStore(temporary(t));
  t.after(() => s.close());
  s.sync({
    threads: [{ id, title: "Fixture", archived: false }],
    projects: [],
    sourceInfo: {},
  });
  return s;
}

test("history exposes visible user and assistant text, never instructions, reasoning or tool output", () => {
  const values = [
    line("system", "SYSTEM_SECRET"),
    line("developer", "DEVELOPER_SECRET"),
    line("user", "Question"),
    line("assistant", "HIDDEN_REASONING", "analysis"),
    line("assistant", "Working", "commentary"),
    line("tool", "TOOL_SECRET"),
    line("assistant", "Answer", "final"),
    "{incomplete",
  ].join("\n");
  assert.deepEqual(
    parseHistoryLines(values).map((m) => m.text),
    ["Question", "Working", "Answer"],
  );
});
test("history reads only the matching rollout under permitted source directories", (t) => {
  const home = temporary(t);
  mkdirSync(join(home, "sessions"));
  const path = join(home, "sessions", "fixture.jsonl");
  const db = new DatabaseSync(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT,rollout_path TEXT)");
  db.prepare("INSERT INTO threads VALUES(?,?)").run(id, path);
  writeFileSync(
    path,
    JSON.stringify({ type: "session_meta", payload: { id } }) +
      "\n" +
      line("user", "Question") +
      "\n" +
      line("assistant", "Answer", "final") +
      "\n",
  );
  assert.equal(readPersistedHistory(home, id).messages.at(-1).text, "Answer");
  writeFileSync(
    path,
    JSON.stringify({ type: "session_meta", payload: { id: rid } }) + "\n",
  );
  assert.throws(() => readPersistedHistory(home, id), /身份不匹配/);
  db.prepare("UPDATE threads SET rollout_path=?").run(
    join(home, "private.txt"),
  );
  writeFileSync(join(home, "private.txt"), "secret");
  assert.throws(() => readPersistedHistory(home, id), /不在允许/);
  db.close();
});
test("one request can be dispatched at most once, including after a timeout and store restart", async (t) => {
  const s = store(t);
  let calls = 0;
  const request = async () => {
    calls++;
    throw new Error("timeout after send");
  };
  const service = new DesktopService(s, "/fixture", request);
  assert.equal(
    (await service.send(id, { text: "Test query", requestId: rid })).status,
    "unknown",
  );
  const restarted = new DesktopService(s, "/fixture", request);
  assert.equal(
    (await restarted.send(id, { text: "Test query", requestId: rid })).status,
    "unknown",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    restarted.send(id, { text: "Different", requestId: rid }),
    (e) => e.status === 409,
  );
  await assert.rejects(
    restarted.send(id, { text: "Test", requestId: rid, model: "override" }),
    (e) => e.status === 400,
  );
});
test("desktop read-back reconciles an unknown receipt and archived tasks cannot send", async (t) => {
  const s = store(t);
  const service = new DesktopService(s, "/fixture", async (p) =>
    p.operation === "send"
      ? { ok: false, sent: null, code: "dispatch_unknown" }
      : {
          ok: true,
          canSend: true,
          messages: [
            { id: "m", text: "Test", clientMessageId: rid, turnId: "turn" },
          ],
        },
  );
  await service.send(id, { text: "Test", requestId: rid });
  await service.history(id);
  assert.equal(
    (await service.send(id, { text: "Test", requestId: rid })).status,
    "accepted",
  );
  s.sync({
    threads: [{ id, title: "Fixture", archived: true }],
    projects: [],
    sourceInfo: {},
  });
  await assert.rejects(
    service.send(id, { text: "Another", requestId: rid }),
    (e) => e.status === 409,
  );
});

test("slow history reads share one desktop request and active snapshots expire promptly", async (t) => {
  const s = store(t);
  let now = 1000, calls = 0, finish;
  t.mock.method(Date, "now", () => now);
  const data = { ok: true, runtime: "active", canSend: false, messages: [] };
  const service = new DesktopService(s, "/fixture", () => {
    if (++calls === 1) return new Promise(resolve => { finish = resolve; });
    return Promise.resolve(data);
  });
  const first = service.history(id);
  now += 4000;
  const second = service.history(id);
  assert.equal(calls, 1);
  finish(data); await Promise.all([first, second]);
  now += 500; await service.history(id); assert.equal(calls, 1);
  now += 500; await service.history(id); assert.equal(calls, 2);
});

test("quick history fallback keeps local queue available and a recent retry gets a longer owner budget", async t => {
  const s=store(t), budgets=[];
  let compatible=true;
  const service=new DesktopService(s,'/fixture',async p=>{
    budgets.push(p.ownerLookupTimeoutMs);
    return {ok:false,code:compatible?'desktop_unavailable':'app_version_changed'};
  },()=>({source:'rollout',runtime:'unavailable',canSend:false,messages:[]}));
  const first=await service.history(id);
  assert.equal(first.canSend,false);
  assert.equal(first.canQueue,true);
  assert.equal(first.canAttemptSend,true);
  assert.equal(first.canAttemptCompact,true);
  const receipt=await service.send(id,{text:'Save while reconnecting',requestId:rid,enqueue:true});
  assert.equal(receipt.status,'queued');
  assert.equal(budgets.length,1);
  await service.history(id);
  assert.deepEqual(budgets,[2000,10000]);
  compatible=false;service.cache.clear();
  assert.equal((await service.history(id)).canAttemptSend,false);
  assert.equal((await service.history(id)).canAttemptCompact,false);
  s.sync({threads:[{id,title:'Fixture',archived:true}],projects:[],sourceInfo:{}});
  const archived=await service.history(id);
  assert.equal(archived.canAttemptSend,false);
  assert.equal(archived.canQueue,false);
});

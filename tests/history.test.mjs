import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseHistoryLines, readPersistedHistory } from "../server/history.mjs";
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

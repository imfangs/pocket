import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { desktopRequest } from "../server/desktop.mjs";
const id = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const requestId = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const idle = {
  id,
  hostId: "local",
  resumeState: "resumed",
  threadRuntimeStatus: { type: "idle" },
  requests: [],
  turns: [],
};
async function fakeDesktop(t, states, { ownerDelay = 0, snapshotDelay = 0 } = {}) {
  const home = mkdtempSync("/tmp/navigator-ipc-");
  mkdirSync(join(home, "ipc"), { mode: 0o700 });
  const calls = [];
  let snapshots = 0;
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    const send = (object, delay = 0) => {
      if (delay) {
        const timer = setTimeout(() => send(object), delay);
        socket.once("close", () => clearTimeout(timer));
        return;
      }
      const body = Buffer.from(JSON.stringify(object)),
        header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      socket.write(Buffer.concat([header, body]));
    };
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (
        pending.length >= 4 &&
        pending.length >= 4 + pending.readUInt32LE(0)
      ) {
        const size = pending.readUInt32LE(0),
          m = JSON.parse(pending.subarray(4, 4 + size));
        pending = pending.subarray(4 + size);
        calls.push(m);
        if (m.type === "request") {
          const answer = () => send({
            type: "response",
            requestId: m.requestId,
            resultType: "success",
            handledByClientId: "desktop-fixture",
            result:
              m.method === "initialize"
                ? { clientId: "navigator-fixture" }
                : {},
          });
          if (m.method === "thread-owner-discovery" && ownerDelay) {
            const timer = setTimeout(answer, ownerDelay);
            socket.once("close", () => clearTimeout(timer));
          } else answer();
        }
        if (m.type === "broadcast" && m.params?.following)
          send({
            type: "broadcast",
            method: "thread-stream-state-changed",
            version: 11,
            params: {
              hostId: "local",
              conversationId: id,
              change: {
                type: "snapshot",
                conversationState:
                  states[Math.min(snapshots++, states.length - 1)],
              },
            },
          }, snapshotDelay);
      }
    });
  });
  server.listen(join(home, "ipc/ipc.sock"));
  await once(server, "listening");
  chmodSync(join(home, "ipc/ipc.sock"), 0o600);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  return { home, calls };
}
test("history bounds owner lookup without waiting for the desktop default", async (t) => {
  const f = await fakeDesktop(t, [idle], { ownerDelay: 2500 });
  const started = performance.now();
  const result = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1800 && elapsed < 3500);
  assert.equal(f.calls.some(c => c.method === "thread-follower-start-turn"), false);
});

test("query submission keeps the longer owner lookup budget", async (t) => {
  const f = await fakeDesktop(t, [idle], { ownerDelay: 2100 });
  const result = await desktopRequest({
    operation: "send", threadId: id, codexHome: f.home,
    text: "Fixture query", requestId,
  });
  assert.equal(result.status, "accepted");
  assert.equal(f.calls.filter(c => c.method === "thread-follower-start-turn").length, 1);
});

test("a discovered owner's full snapshot keeps its normal read budget", async (t) => {
  const f = await fakeDesktop(t, [idle], { snapshotDelay: 2500 });
  const result = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.equal(result.ok, true);
  assert.equal(result.source, "desktop");
  assert.equal(result.runtime, "idle");
});
test("desktop bridge sends text to the existing owner with inherited settings only", async (t) => {
  const f = await fakeDesktop(t, [idle]);
  const r = await desktopRequest({
    operation: "send",
    threadId: id,
    codexHome: f.home,
    text: "Fixture query",
    requestId,
  });
  assert.equal(r.status, "accepted");
  const send = f.calls.find((c) => c.method === "thread-follower-start-turn");
  assert.ok(send);
  assert.equal(send.targetClientId, "desktop-fixture");
  assert.equal(send.version, 2);
  assert.deepEqual(send.params.turnStart, {
    request: {
      threadId: id,
      clientUserMessageId: requestId,
      input: [{ type: "text", text: "Fixture query", text_elements: [] }],
    },
    context: { inheritThreadSettings: true },
  });
  assert.equal(
    f.calls.find((c) => c.method === "initialize").params.clientType,
    "codex-navigator",
  );
});
test("desktop bridge defers a task that starts running before submission", async (t) => {
  const f = await fakeDesktop(t, [
    idle,
    { ...idle, threadRuntimeStatus: { type: "active" } },
  ]);
  const r = await desktopRequest({
    operation: "send",
    threadId: id,
    codexHome: f.home,
    text: "Fixture query",
    requestId,
  });
  assert.equal(r.sent, false);
  assert.equal(r.code, "thread_active");
  assert.equal(
    f.calls.filter((c) => c.method === "thread-follower-start-turn").length,
    0,
  );
});
test("desktop history contains only visible messages and reports approvals as not ready", async (t) => {
  const f = await fakeDesktop(t, [
    {
      ...idle,
      requests: [{ type: "approval" }],
      turns: [
        {
          turnId: "t",
          params: { clientUserMessageId: requestId },
          items: [
            {
              type: "userMessage",
              id: "u",
              content: [{ type: "text", text: "Question" }],
            },
            { type: "reasoning", content: ["hidden"] },
            { type: "mcpToolCall", arguments: { secret: "hidden" } },
            { type: "agentMessage", id: "a", text: "Answer", phase: "final" },
          ],
        },
      ],
    },
  ]);
  const r = await desktopRequest({
    operation: "history",
    threadId: id,
    codexHome: f.home,
  });
  assert.equal(r.ok, true);
  assert.equal(r.canSend, false);
  assert.deepEqual(
    r.messages.map((m) => m.text),
    ["Question", "Answer"],
  );
  assert.equal(r.messages[0].clientMessageId, requestId);
});
test("automatic queue delivery rechecks completion after a concurrent interruption", async (t) => {
  const f = await fakeDesktop(t, [idle, { ...idle, turns: [{ turnId: "stopped", status: "interrupted", items: [] }] }]);
  const r = await desktopRequest({ operation: "send", delivery: "auto", threadId: id,
    codexHome: f.home, text: "Wait for completion", requestId });
  assert.equal(r.sent, false);
  assert.equal(r.code, "thread_not_ready");
  assert.equal(f.calls.some(c => c.method === "thread-follower-start-turn"), false);
});

test("desktop history includes accepted user input added during an active turn", async (t) => {
  const f = await fakeDesktop(t, [{
    ...idle,
    threadRuntimeStatus: { type: "active" },
    turns: [{
      turnId: "running-turn",
      params: { clientUserMessageId: "initial-client" },
      items: [
        { type: "userMessage", id: "initial", content: [{ type: "text", text: "Explain the connection" }] },
        { type: "agentMessage", id: "explanation", text: "The Mac connects outward.", phase: "final" },
        { type: "steeringUserMessage", id: "pending-ui-id", status: "accepted",
          serverUserMessageId: "followup", clientUserMessageId: requestId,
          input: [{ type: "text", text: "Publish the site" }],
          restoreMessage: { createdAt: 1234, context: { private: "DO_NOT_EXPOSE" } } },
        { type: "steered", id: "followup" },
        { type: "steeringUserMessage", id: "rejected", status: "rejected",
          input: [{ type: "text", text: "Not accepted" }] },
        { type: "agentMessage", id: "progress", text: "Publishing.", phase: "commentary" },
      ],
    }],
  }]);
  const r = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.deepEqual(r.messages.map(m => [m.role, m.text]), [
    ["user", "Explain the connection"], ["assistant", "The Mac connects outward."],
    ["user", "Publish the site"], ["assistant", "Publishing."],
  ]);
  assert.equal(r.messages[2].id, "followup");
  assert.equal(r.messages[2].clientMessageId, requestId);
  assert.equal(r.messages[2].timestamp, 1234);
  assert.equal(r.canSend, true);
  assert.equal(r.queueReady, false);
  assert.equal(JSON.stringify(r).includes("DO_NOT_EXPOSE"), false);
});

test("send now steers the existing active turn without model or permission overrides", async (t) => {
  const f = await fakeDesktop(t, [{ ...idle, cwd: "/fixture", threadRuntimeStatus: { type: "active" },
    turns: [{ turnId: "running", status: "inProgress", items: [] }] }]);
  const r = await desktopRequest({ operation: "send", delivery: "now", threadId: id,
    codexHome: f.home, text: "A correction", requestId });
  assert.equal(r.status, "accepted");
  assert.equal(r.turnId, "running");
  const call = f.calls.find(c => c.method === "thread-follower-steer-turn");
  assert.equal(call.version, 1);
  assert.equal(call.targetClientId, "desktop-fixture");
  assert.deepEqual(call.params.input, [{ type: "text", text: "A correction", text_elements: [] }]);
  assert.equal(call.params.clientUserMessageId, requestId);
  assert.equal(call.params.restoreMessage.context.prompt, "A correction");
  assert.equal("model" in call.params, false);
  assert.equal("permissions" in call.params, false);
  assert.equal(f.calls.some(c => c.method === "thread-follower-start-turn"), false);
});

test("desktop history does not duplicate steering input materialized as a user message", async (t) => {
  const f = await fakeDesktop(t, [{ ...idle, turns: [{ turnId: "t", items: [
    { type: "steeringUserMessage", id: "ui-id", status: "accepted", serverUserMessageId: "u",
      input: [{ type: "text", text: "Follow up" }] },
    { type: "userMessage", id: "u", content: [{ type: "text", text: "Follow up" }] },
  ] }] }]);
  const r = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.deepEqual(r.messages.map(m => m.text), ["Follow up"]);
});

test("context usage follows the desktop last-request budget, never cumulative billing", async t => {
  const f = await fakeDesktop(t, [{ ...idle, latestTokenUsageInfo: {
    total: { totalTokens: 9000000 }, last: { totalTokens: 25000 }, modelContextWindow: 100000,
  } }]);
  const r = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.deepEqual(r.contextUsage, { usedTokens: 25000, contextWindow: 100000, remainingTokens: 75000, percent: 25 });
  assert.equal(r.canCompact, true);
});
test("missing context metrics remain unknown instead of reporting zero", async t => {
  const f = await fakeDesktop(t, [idle]);
  const r = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.equal(r.contextUsage, null);
});
test("manual compaction uses the original idle owner and only the conversation id", async t => {
  const f = await fakeDesktop(t, [idle]);
  const r = await desktopRequest({ operation: "compact", threadId: id, codexHome: f.home, expectedCompactionId: null });
  assert.equal(r.status, "accepted");
  const call = f.calls.find(c => c.method === "thread-follower-compact-thread");
  assert.equal(call.version, 1); assert.equal(call.targetClientId, "desktop-fixture");
  assert.deepEqual(call.params, { conversationId: id });
  assert.equal(f.calls.some(c => c.method === "thread-follower-start-turn"), false);
});
test("compaction refuses a task that starts running between its two reads", async t => {
  const f = await fakeDesktop(t, [idle, {...idle, threadRuntimeStatus: {type:"active"}}]);
  const r = await desktopRequest({ operation: "compact", threadId: id, codexHome: f.home });
  assert.equal(r.sent, false);
  assert.equal(f.calls.some(c => c.method === "thread-follower-compact-thread"), false);
});
test("in-progress native compaction blocks sends, queue drain and duplicate compaction", async t => {
  const f = await fakeDesktop(t, [{...idle, turns:[{turnId:"compact",status:"inProgress",items:[{type:"contextCompaction",id:"c1",completed:false}]}]}]);
  const r = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.equal(r.compaction.active, true);
  assert.equal(r.canSend, false); assert.equal(r.queueReady, false); assert.equal(r.canCompact, false);
});

const approval = { method:'item/commandExecution/requestApproval',id:0,params:{threadId:id,turnId:'t',itemId:'command-1',command:'git status',cwd:'/fixture',reason:'Read repository state',availableDecisions:['accept',{acceptWithExecpolicyAmendment:{execpolicy_amendment:['git']}},'cancel']} };
test('approval display includes the full command and offers only one-time decisions', async t => {
  const f = await fakeDesktop(t,[{...idle,requests:[approval]}]);
  const h = await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
  assert.deepEqual(h.pendingRequests[0].choices,['accept','cancel']);
  assert.equal(h.pendingRequests[0].command,'git status');
  assert.equal(h.canSend,false);
  const r=await desktopRequest({operation:'respond',threadId:id,codexHome:f.home,requestKey:h.pendingRequests[0].key,decision:'accept'});
  assert.equal(r.status,'accepted');
  const call=f.calls.find(c=>c.method==='thread-follower-command-approval-decision');
  assert.deepEqual(call.params,{conversationId:id,requestId:0,decision:'accept'});assert.equal(call.version,1);
});
test('a reused request id with a changed command cannot receive an old approval',async t=>{
 const f=await fakeDesktop(t,[{...idle,requests:[approval]},{...idle,requests:[{...approval,params:{...approval.params,command:'git push'}}]}]);
 const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 const r=await desktopRequest({operation:'respond',threadId:id,codexHome:f.home,requestKey:h.pendingRequests[0].key,decision:'accept'});
 assert.equal(r.sent,false);assert.equal(r.code,'request_changed');
 assert.equal(f.calls.some(c=>c.method==='thread-follower-command-approval-decision'),false);
});
test('native approval rejects persistent permission changes',async t=>{
 const f=await fakeDesktop(t,[{...idle,requests:[approval]}]);const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 const r=await desktopRequest({operation:'respond',threadId:id,codexHome:f.home,requestKey:h.pendingRequests[0].key,decision:'acceptForSession'});
 assert.equal(r.sent,false);assert.equal(r.code,'invalid_decision');
});

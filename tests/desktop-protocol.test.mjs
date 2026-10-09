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
test("desktop timing uses native duration for completed turns and start time for active turns", async (t) => {
  const turns = [
    { turnId: "old", status: "completed", turnStartedAtMs: 1000, durationMs: 12345, items: [{ type: "agentMessage", id: "a", phase: "final_answer", text: "Done" }] },
    { turnId: "new", status: "inProgress", turnStartedAtMs: 900000, durationMs: 123, items: [] },
  ];
  const f = await fakeDesktop(t, [{ ...idle, threadRuntimeStatus: { type: "active" }, turns }]);
  const data = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.equal(data.messages[0].turnDurationMs, 12345);
  assert.equal(data.turnTiming.startedAt, 900000);
  assert.equal(data.turnTiming.durationMs, null);
  assert.equal(data.turnTiming.turnId, "new");
});

test("missing or invalid desktop timing is never invented from message timestamps", async (t) => {
  const f = await fakeDesktop(t, [{ ...idle, turns: [{ turnId: "old", status: "completed", durationMs: -1, finalAssistantStartedAtMs: 900, items: [] }] }]);
  const data = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.equal(data.turnTiming.durationMs, null);
  assert.equal(data.turnTiming.startedAt, null);
});

test("history bounds owner lookup without waiting for the desktop default", async (t) => {
  const f = await fakeDesktop(t, [idle], { ownerDelay: 2500 });
  const started = performance.now();
  const result = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.equal(result.connectionReason, "owner_lookup_timeout");
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 1800 && elapsed < 3500);
  assert.equal(f.calls.some(c => c.method === "thread-follower-start-turn"), false);
});

test("a follow-up history read tolerates an owner slower than the initial two-second budget", async (t) => {
  const f = await fakeDesktop(t, [idle], { ownerDelay: 2700 });
  const result = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home, ownerLookupTimeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.canSend, true);
  assert.equal(f.calls.find(c => c.method === "thread-owner-discovery").timeoutMs, 5000);
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
test("connection readiness follows native resume state even when sending needs approval", async (t) => {
  const f = await fakeDesktop(t, [{ ...idle, requests: [{ id: "approval", method: "unknown" }] }]);
  const result = await desktopRequest({ operation: "history", threadId: id, codexHome: f.home });
  assert.equal(result.source, "desktop");
  assert.equal(result.resumeState, "resumed");
  assert.equal(result.canSend, false);
  assert.equal(f.calls.some(c => c.method === "thread-follower-start-turn"), false);
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
test("first message in a confirmed empty untitled task requests native title generation", async (t) => {
  for (const turnHistory of [undefined, {
    kind: "canonical",
    history: { entitiesByKey: {}, islands: [] },
  }]) {
    await t.test(turnHistory ? "canonical history" : "legacy history", async (t) => {
      const state = { ...idle, title: null, turnHistory, turnsPagination: { hasLoadedOldest: true } };
      const f = await fakeDesktop(t, [state]);
      const r = await desktopRequest({ operation: "send", threadId: id, codexHome: f.home,
        text: "Build a small timer", requestId });
      assert.equal(r.status, "accepted");
      const sends = f.calls.filter(c => c.method === "thread-follower-start-turn");
      assert.equal(sends.length, 1);
      assert.equal(sends[0].targetClientId, "desktop-fixture");
      assert.deepEqual(sends[0].params.turnStart.context, {
        inheritThreadSettings: true, threadStartKind: "default",
      });
      assert.deepEqual(Object.keys(sends[0].params.turnStart.request).sort(), ["clientUserMessageId", "input", "threadId"]);
      assert.equal(f.calls.some(c => /title|name|generate/.test(c.method ?? "")), false);
    });
  }
});
test("native initial title request is withheld for named, existing, incomplete, and special tasks", async (t) => {
  const empty = { ...idle, title: null, turnsPagination: { hasLoadedOldest: true } };
  const cases = [
    ["manual title", { title: "My chosen title" }],
    ["empty string title", { title: "" }],
    ["existing turn", { turns: [{ turnId: "earlier", status: "completed", items: [] }] }],
    ["canonical existing turn", { turnHistory: { kind: "canonical", history: {
      entitiesByKey: { earlier: { turnId: "earlier", status: "completed", items: [] } },
      islands: [{ entries: [{ value: "earlier" }] }],
    } } }],
    ["history not complete", { turnsPagination: { hasLoadedOldest: false } }],
    ["history completeness unknown", { turnsPagination: undefined }],
    ["automation", { threadSource: "automation" }],
    ["voice chat", { threadStartKind: "realtime_voice" }],
    ["durable task", { mode: "durable" }],
    ["ephemeral", { ephemeral: true }],
    ["side conversation", { sideConversation: true }],
    ["fork", { forkedFromId: "original" }],
  ];
  for (const [name, change] of cases) await t.test(name, async (t) => {
    const f = await fakeDesktop(t, [empty, { ...empty, ...change }]);
    const r = await desktopRequest({ operation: "send", threadId: id, codexHome: f.home,
      text: "Continue the task", requestId });
    assert.equal(r.status, "accepted");
    const send = f.calls.find(c => c.method === "thread-follower-start-turn");
    assert.deepEqual(send.params.turnStart.context, { inheritThreadSettings: true });
  });
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

test('stop sends a conditional user interruption to the existing owner even while awaiting approval',async t=>{
 const active={...idle,threadRuntimeStatus:{type:'active'},requests:[approval],turns:[{turnId:'running',status:'inProgress',items:[]}]};
 const f=await fakeDesktop(t,[active]);const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 assert.equal(h.canStop,true);assert.equal(h.activeTurnId,'running');
 const r=await desktopRequest({operation:'stop',threadId:id,codexHome:f.home,expectedTurnId:'running'});
 assert.equal(r.status,'accepted');const call=f.calls.find(c=>c.method==='thread-follower-interrupt-turn');
 assert.equal(call.version,4);assert.deepEqual(call.params,{conversationId:id,mode:'user-stop',expectedTurnId:'running'});
 assert.equal(f.calls.some(c=>c.method==='thread-follower-update-thread-settings'),false);
});
test('a stale stop cannot interrupt a newer turn',async t=>{
 const a={...idle,threadRuntimeStatus:{type:'active'},turns:[{turnId:'old',status:'inProgress',items:[]}]};
 const b={...a,turns:[{turnId:'new',status:'inProgress',items:[]}]};const f=await fakeDesktop(t,[a,b]);
 const r=await desktopRequest({operation:'stop',threadId:id,codexHome:f.home,expectedTurnId:'old'});
 assert.equal(r.sent,false);assert.equal(r.code,'turn_changed');assert.equal(f.calls.some(c=>c.method==='thread-follower-interrupt-turn'),false);
});
test('resumed queue sends after the exact interrupted turn, but not after another interruption',async t=>{
 const f=await fakeDesktop(t,[{...idle,turns:[{turnId:'stopped',status:'interrupted',items:[]}]}]);
 const r=await desktopRequest({operation:'send',delivery:'resume',resumeAfterTurnId:'stopped',threadId:id,codexHome:f.home,text:'Continue',requestId});
 assert.equal(r.status,'accepted');
 const other=await desktopRequest({operation:'send',delivery:'resume',resumeAfterTurnId:'other',threadId:id,codexHome:f.home,text:'Stale',requestId});
 assert.equal(other.sent,false);assert.equal(other.code,'thread_changed');
 assert.equal(f.calls.filter(c=>c.method==='thread-follower-start-turn').length,1);
});

const asyncQuestion={type:'agentMessage',id:'call-question',phase:'final_answer',delivery:'async',text:'选一个方向',questions:[{title:'选一个方向',options:['方向 A','方向 B']}]};
test('unanswered questions from older turns are not offered or answerable',async t=>{
 const old={turnId:'old',status:'completed',items:[asyncQuestion]};
 const f=await fakeDesktop(t,[{...idle,turns:[old]}]);
 const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 assert.equal(h.asyncQuestions.length,1,'latest completed turn may still need an answer');
 const next=await fakeDesktop(t,[{...idle,turns:[old,{turnId:'new',status:'completed',items:[]}]}]);
 const current=await desktopRequest({operation:'history',threadId:id,codexHome:next.home});
 assert.equal(current.asyncQuestions.length,0,'old unanswered question must disappear');
 const answer=await desktopRequest({operation:'answer',threadId:id,codexHome:next.home,questionKey:h.asyncQuestions[0].key,text:'stale',requestId});
 assert.equal(answer.code,'question_changed');
 assert.equal(next.calls.some(c=>c.method==='thread-follower-start-turn'||c.method==='thread-follower-steer-turn'),false);
});
test('async questions are exposed separately and answers use the original native reply envelope',async t=>{
 const state={...idle,threadRuntimeStatus:{type:'active'},turns:[{turnId:'active',status:'inProgress',items:[asyncQuestion]}]};
 const f=await fakeDesktop(t,[state]);const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 assert.equal(h.asyncQuestions.length,1);assert.equal(h.messages[0].isQuestion,true);
 assert.equal(h.asyncQuestions[0].turnId,'active');
 assert.equal(h.asyncQuestions[0].id,JSON.stringify(['request_user_input_async','call-question',0]));
 const r=await desktopRequest({operation:'answer',delivery:'now',threadId:id,codexHome:f.home,questionKey:h.asyncQuestions[0].key,text:'方向 B',requestId});
 assert.equal(r.status,'accepted');const call=f.calls.find(c=>c.method==='thread-follower-steer-turn');
 const text=call.params.input[0].text;assert.ok(text.startsWith('<send_user_message_question_reply>\n'));
 const answer=JSON.parse(text.slice(text.indexOf('\n')+1,text.lastIndexOf('\n')));
 assert.deepEqual(answer,[{questionItemId:h.asyncQuestions[0].id,question:'选一个方向',answer:'方向 B'}]);
});
test('only the latest canonical turn contributes questions, while old questions stay in history',async t=>{
 const old={turnId:'old',status:'completed',items:[asyncQuestion]};
 const current={turnId:'current',status:'completed',items:[{...asyncQuestion,id:'new-question',text:'新问题'}]};
 const f=await fakeDesktop(t,[{...idle,turns:[old],turnHistory:{kind:'canonical',history:{entitiesByKey:{a:old,b:current},islands:[{entries:[{value:'a'},{value:'b'}]}]}}}]);
 const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 assert.equal(h.asyncQuestions.length,1);assert.equal(h.asyncQuestions[0].sourceMessageId,'new-question');
 assert.equal(h.asyncQuestions[0].turnId,'current');assert.equal(h.messages.length,2);
});
test('answered async questions disappear, and an old question key cannot answer a changed question',async t=>{
 const reply='<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:JSON.stringify(['request_user_input_async','call-question',0]),question:'选一个方向',answer:'方向 A'}])+'\n</send_user_message_question_reply>';
 const f=await fakeDesktop(t,[{...idle,turns:[{turnId:'t',status:'completed',items:[asyncQuestion,{type:'userMessage',id:'reply',clientId:requestId,content:[{type:'text',text:reply}]}]}]}]);
 const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});assert.equal(h.asyncQuestions.length,0);assert.equal(h.messages[1].clientMessageId,requestId);
 const changed=await desktopRequest({operation:'answer',delivery:'now',threadId:id,codexHome:f.home,questionKey:'0'.repeat(64),text:'stale',requestId:'cccccccc-cccc-7ccc-8ccc-cccccccccccc'});
 assert.equal(changed.sent,false);assert.equal(changed.code,'question_changed');
 assert.equal(f.calls.some(c=>c.method==='thread-follower-start-turn'||c.method==='thread-follower-steer-turn'),false);
});

test('file approval displays its exact patch and a changed patch rejects an old response',async t=>{
 const request={id:9,method:'item/fileChange/requestApproval',params:{threadId:id,turnId:'t',itemId:'file'}};
 const state={...idle,requests:[request],turns:[{turnId:'t',items:[{id:'file',type:'fileChange',changes:[{path:'/fixture/a.txt',kind:'update',diff:'-old\n+new'}]}]}]};
 const f=await fakeDesktop(t,[state]);const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 assert.equal(h.pendingRequests[0].kind,'file');assert.ok(h.pendingRequests[0].details.includes('+new'));
 const r=await desktopRequest({operation:'respond',threadId:id,codexHome:f.home,requestKey:h.pendingRequests[0].key,decision:'accept'});
 assert.equal(r.status,'accepted');assert.equal(f.calls.find(c=>c.method==='thread-follower-file-approval-decision').params.requestId,9);
 const changed={...state,turns:[{turnId:'t',items:[{id:'file',type:'fileChange',changes:[{path:'/fixture/a.txt',diff:'+other'}]}]}]};
 const other=await fakeDesktop(t,[changed]);const denied=await desktopRequest({operation:'respond',threadId:id,codexHome:other.home,requestKey:h.pendingRequests[0].key,decision:'accept'});
 assert.equal(denied.code,'request_changed');
});
test('requested permissions are scoped only to the current turn and denial grants nothing',async t=>{
 const request={id:'permissions',method:'item/permissions/requestApproval',params:{threadId:id,turnId:'t',permissions:{network:{enabled:true},fileSystem:{read:['/fixture']}}}};
 const f=await fakeDesktop(t,[{...idle,requests:[request]}]);const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 for(const decision of ['accept','cancel']){
  const r=await desktopRequest({operation:'respond',threadId:id,codexHome:f.home,requestKey:h.pendingRequests[0].key,decision});assert.equal(r.status,'accepted');
 }
 const calls=f.calls.filter(c=>c.method==='thread-follower-permissions-request-approval-response');
 assert.deepEqual(calls[0].params.response,{permissions:request.params.permissions,scope:'turn'});assert.deepEqual(calls[1].params.response,{permissions:{},scope:'turn'});
});
test('blocking question answers go through native response, never a new user turn',async t=>{
 const request={id:'question',method:'item/tool/requestUserInput',params:{threadId:id,turnId:'t',questions:[{id:'direction',question:'Choose',options:[{label:'A',description:'Option A'}]}]}};
 const f=await fakeDesktop(t,[{...idle,requests:[request]}]);const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 const r=await desktopRequest({operation:'respond',threadId:id,codexHome:f.home,requestKey:h.pendingRequests[0].key,answers:{direction:'A'}});assert.equal(r.status,'accepted');
 assert.deepEqual(f.calls.find(c=>c.method==='thread-follower-submit-user-input').params.response,{answers:{direction:{answers:['A']}}});
 const bad=await desktopRequest({operation:'respond',threadId:id,codexHome:f.home,requestKey:h.pendingRequests[0].key,answers:{unexpected:'A'}});assert.equal(bad.sent,false);
 assert.equal(f.calls.some(c=>c.method==='thread-follower-start-turn'),false);
});
test('blocking answers preserve the allowed Chinese and emoji input beyond 70000 UTF-8 bytes',async t=>{
 const request={id:'long-question',method:'item/tool/requestUserInput',params:{threadId:id,turnId:'t',questions:[{id:'first',question:'First?'},{id:'second',question:'Second?'}]}};
 const f=await fakeDesktop(t,[{...idle,requests:[request]}]);
 const h=await desktopRequest({operation:'history',threadId:id,codexHome:f.home});
 for(const second of ['字'.repeat(16000),'😀'.repeat(8000)]){
  const answers={first:'汉'.repeat(16000),second};
  assert.ok(Object.values(answers).every(text=>text.length<=16000));
  assert.ok(JSON.stringify(answers).length<=40000);
  const payload={operation:'respond',threadId:id,codexHome:f.home,requestKey:h.pendingRequests[0].key,answers};
  assert.ok(Buffer.byteLength(JSON.stringify(payload))>70000);
  const r=await desktopRequest(payload);assert.equal(r.status,'accepted');
  const call=f.calls.filter(c=>c.method==='thread-follower-submit-user-input').at(-1);
  assert.deepEqual(call.params.response,{answers:{first:{answers:[answers.first]},second:{answers:[answers.second]}}});
 }
 assert.equal(f.calls.filter(c=>c.method==='thread-follower-submit-user-input').length,2);
 assert.equal(f.calls.some(c=>c.method==='thread-follower-start-turn'),false);
});
test('oversized bridge payloads are explicitly rejected before contacting an owner',async t=>{
 const f=await fakeDesktop(t,[idle]);
 const r=await desktopRequest({operation:'send',threadId:id,codexHome:f.home,requestId,text:'x'.repeat(256*1024)});
 assert.deepEqual(r,{ok:false,code:'payload_too_large',sent:false});
 assert.equal(f.calls.length,0);
});

import "./helpers/block-native-open.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runBridge } from "../server/bridge-process.mjs";

const id = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const requestId = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const turnId = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const idle = { id, hostId: "local", title: "Synthetic conversation", resumeState: "resumed", requests: [],
  cwd: "/fixture", threadRuntimeStatus: { type: "idle" }, turns: [] };
const active = { ...idle, threadRuntimeStatus: { type: "active" }, turns: [{ turnId, status: "inProgress", items: [] }] };
const ended = status => ({ ...idle, turns: [{ turnId, status, items: [] }] });

// Exercise the real Python main(), writable(), duplicate detection and native
// payload builders with a synthetic transport. No real socket, App bundle,
// original conversation, browser or model is read or written.
const program = `import sys,json,importlib.util,copy
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
spec=importlib.util.spec_from_file_location('bridge',sys.argv[1]+'/desktop-bridge.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
fixture=json.loads(sys.argv[2]);calls=[];snapshots=[]
class Fake(bridge.NavigatorIPC):
    def __init__(self,path): pass
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def snapshot(self,thread_id):
        index=min(len(snapshots),len(fixture['states'])-1)
        state=copy.deepcopy(fixture['states'][index]);bridge.validate_state(state)
        owner=fixture.get('owners',['fixture-owner'])[min(index,len(fixture.get('owners',['fixture-owner']))-1)]
        snapshots.append(thread_id)
        return owner,state
    def request(self,method,params,version,owner=None):
        calls.append({'method':method,'params':params,'version':version,'owner':owner})
        if fixture.get('writeError'): raise TimeoutError('synthetic uncertain write')
        return {'result':{}}
bridge.NavigatorIPC=Fake
bridge.desktop_app=lambda path: None
result=bridge.main()
print(json.dumps({**result,'fixtureCalls':calls,'fixtureSnapshots':len(snapshots)}))`;

function dispatch(states, { delivery = "auto-now", owners, writeError = false } = {}) {
  return runBridge({ operation: "send", threadId: id, requestId, text: "Synthetic current-turn correction",
    codexHome: "/synthetic-home-never-opened", delivery }, {
    command: "python3", args: ["-c", program, fileURLToPath(new URL("../bin", import.meta.url)), JSON.stringify({ states, owners, writeError })],
    timeoutMs: 10000,
  });
}

test("auto-now steers the current owner after both snapshots and retains the client message ID", async () => {
  const result = await dispatch([active, active]);
  assert.equal(result.status, "accepted"); assert.equal(result.fixtureSnapshots, 2);
  assert.equal(result.fixtureCalls.length, 1);
  const call = result.fixtureCalls[0];
  assert.equal(call.method, "thread-follower-steer-turn"); assert.equal(call.owner, "fixture-owner"); assert.equal(call.version, 1);
  assert.equal(call.params.clientUserMessageId, requestId);
  assert.equal(call.params.restoreMessage.id, requestId);
  assert.equal(call.params.restoreMessage.cwd, "/fixture");
  assert.deepEqual(call.params.input, [{ type: "text", text: "Synthetic current-turn correction", text_elements: [] }]);
  assert.equal("model" in call.params, false); assert.equal("permissions" in call.params, false);
});

test("auto-now can start after the active turn completes, retaining inherited settings", async () => {
  const result = await dispatch([active, ended("completed")]);
  assert.equal(result.status, "accepted"); assert.equal(result.fixtureSnapshots, 2);
  assert.equal(result.fixtureCalls.length, 1);
  const call = result.fixtureCalls[0];
  assert.equal(call.method, "thread-follower-start-turn");
  assert.equal(call.params.turnStart.request.clientUserMessageId, requestId);
  assert.deepEqual(call.params.turnStart.context, { inheritThreadSettings: true });
});

test("auto-now also supports a freshly resumed empty original conversation", async () => {
  const result = await dispatch([idle, idle]);
  assert.equal(result.status, "accepted");
  assert.deepEqual(result.fixtureCalls.map(call => call.method), ["thread-follower-start-turn"]);
});

test("an active turn becoming failed or interrupted before the second snapshot produces no write", async t => {
  for (const status of ["failed", "interrupted"]) await t.test(status, async () => {
    const result = await dispatch([active, ended(status)]);
    assert.equal(result.ok, false); assert.equal(result.sent, false);
    assert.equal(result.fixtureSnapshots, 2, "The active first snapshot must reach final-state verification");
    assert.equal(result.fixtureCalls.length, 0);
  });
});

test("auto-now does not start a failed, interrupted or system-error conversation", async t => {
  for (const state of [ended("failed"), ended("interrupted"), { ...ended("failed"), threadRuntimeStatus: { type: "systemError" } }])
    await t.test(`${state.threadRuntimeStatus.type}/${state.turns[0].status}`, async () => {
      const result = await dispatch([state]);
      assert.equal(result.ok, false); assert.equal(result.sent, false); assert.equal(result.fixtureCalls.length, 0);
    });
});

test("a failed or interrupted initial snapshot is not silently promoted by a later writable state", async t => {
  for (const [initial, later] of [[ended("failed"), ended("completed")], [ended("interrupted"), active],
    [{ ...ended("failed"), threadRuntimeStatus: { type: "systemError" } }, idle]])
    await t.test(`${initial.threadRuntimeStatus.type}/${initial.turns[0].status}`, async () => {
      const result = await dispatch([initial, later]);
      assert.equal(result.ok, false); assert.equal(result.sent, false); assert.equal(result.fixtureCalls.length, 0);
    });
});

test("new approval, compaction or owner change between snapshots stops automatic steering", async t => {
  const cases = [
    ["approval", { ...active, requests: [{ type: "approval" }] }, {}],
    ["compaction", { ...active, turns: [{ turnId, status: "inProgress", items: [{ type: "contextCompaction", id: "compact", completed: false }] }] }, {}],
    ["owner", active, { owners: ["fixture-owner", "different-owner"] }],
  ];
  for (const [name, second, options] of cases) await t.test(name, async () => {
    const result = await dispatch([active, second], options);
    assert.equal(result.ok, false); assert.equal(result.sent, false);
    assert.equal(result.fixtureSnapshots, 2); assert.equal(result.fixtureCalls.length, 0);
  });
});

test("existing accepted or pending native steering identity resolves without another write", async t => {
  for (const status of ["accepted", "pending"]) await t.test(status, async () => {
    const existing = { ...active, turns: [{ turnId, status: "inProgress", items: [
      { type: "steeringUserMessage", id: "native-steer", clientUserMessageId: requestId, status },
    ] }] };
    const result = await dispatch([existing]);
    assert.equal(result.status, "accepted"); assert.equal(result.turnId, turnId); assert.equal(result.fixtureCalls.length, 0);
  });
});

test("a native write timeout remains unknown, preserving the original message identity", async () => {
  const result = await dispatch([active, active], { writeError: true });
  assert.equal(result.ok, false); assert.equal(result.sent, null); assert.equal(result.code, "dispatch_unknown");
  assert.equal(result.fixtureCalls.length, 1);
  assert.equal(result.fixtureCalls[0].params.clientUserMessageId, requestId);
});

test("ordinary auto delivery still defers an active turn and manual now still permits explicit failed-turn continuation", async () => {
  const waiting = await dispatch([active], { delivery: "auto" });
  assert.equal(waiting.sent, false); assert.equal(waiting.code, "thread_active"); assert.equal(waiting.fixtureCalls.length, 0);
  const manual = await dispatch([ended("failed"), ended("failed")], { delivery: "now" });
  assert.equal(manual.status, "accepted");
  assert.deepEqual(manual.fixtureCalls.map(call => call.method), ["thread-follower-start-turn"]);
});

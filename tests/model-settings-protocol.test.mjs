import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, chmodSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runBridge } from "../server/bridge-process.mjs";

const id = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const otherId = "cccccccc-cccc-7ccc-8ccc-cccccccccccc";
const requestId = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";
const catalog = [{ id: "gpt-6-astra", name: "GPT-6-Astra", supportedEfforts: ["low", "high", "ultra"], defaultEffort: "low" }];
const state = () => ({
  id, hostId: "local", resumeState: "resumed", mode: "default", threadSource: "user",
  modelProvider: "codex", cwd: "/private/example", latestModel: "gpt-6-astra", latestReasoningEffort: null,
  latestCollaborationMode: { mode: "plan", settings: { model: "gpt-6-astra", reasoning_effort: "ultra", developer_instructions: "PRIVATE_SENTINEL" } },
  latestThreadSettings: { model: "gpt-6-astra", effort: "ultra", modelProvider: "codex", approvalPolicy: "never",
    collaborationMode: { mode: "plan", settings: { model: "gpt-6-astra", reasoning_effort: "ultra", developer_instructions: "PRIVATE_SENTINEL" } } },
  currentPermissions: { approvalPolicy: "never" }, threadRuntimeStatus: { type: "idle" }, requests: [], turns: [],
});

async function desktop(t, initial = state(), options = {}) {
  const home = mkdtempSync("/tmp/pocket-model-ipc-");
  mkdirSync(join(home, "ipc"), { mode: 0o700 });
  let current = structuredClone(initial), snapshots = 0;
  const calls = [];
  const server = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    const send = value => {
      const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
      header.writeUInt32LE(body.length); socket.write(Buffer.concat([header, body]));
    };
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32LE(0)) {
        const size = pending.readUInt32LE(0), call = JSON.parse(pending.subarray(4, size + 4));
        pending = pending.subarray(size + 4); calls.push(call);
        if (call.type === "request") {
          let result = {};
          if (call.method === "initialize") result = { clientId: "pocket-fixture" };
          if (call.method === "thread-follower-read-model-settings") result = { settings: {
            model: current.latestModel, reasoningEffort: current.latestReasoningEffort,
          } };
          if (call.method === "thread-follower-update-thread-settings") {
            if (options.writeError) {
              send({ type: "response", method: call.method, requestId: call.requestId,
                resultType: "error", error: "private native exception" }); continue;
            }
            const condition = call.params.condition;
            const applied = options.applied ?? (condition.ifModelEquals === current.latestModel && condition.ifEffortEquals === current.latestReasoningEffort);
            result = { applied };
            if (applied && !options.keepOldEffort) {
              const effort = call.params.threadSettings.effort;
              current.latestReasoningEffort = effort;
              current.latestThreadSettings.effort = effort;
              current.latestThreadSettings.collaborationMode.settings.reasoning_effort = effort;
              current.latestCollaborationMode.settings.reasoning_effort = effort;
            }
            options.afterWrite?.(current);
          }
          send({ type: "response", method: call.method, requestId: call.requestId,
            resultType: "success", handledByClientId: "desktop-fixture", result });
        }
        if (call.type === "broadcast" && call.params?.following) {
          options.beforeSnapshot?.(current, snapshots++);
          send({ type: "broadcast", method: "thread-stream-state-changed", version: 11,
            sourceClientId: "desktop-fixture", targetClientIds: ["pocket-fixture"], params: {
              hostId: "local", conversationId: id, change: { type: "snapshot", conversationState: current },
            } });
        }
      }
    });
  });
  server.listen(join(home, "ipc/ipc.sock")); await once(server, "listening");
  chmodSync(join(home, "ipc/ipc.sock"), 0o600);
  t.after(async () => { await new Promise(done => server.close(done)); rmSync(home, { recursive: true, force: true }); });
  const request = (input = {}, models = catalog) => runBridge({ operation: "model", threadId: id, codexHome: home, ...input }, {
    command: "python3", args: ["-c", `import sys,json,importlib.util
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
s=importlib.util.spec_from_file_location('bridge',sys.argv[1]+'/desktop-bridge.py')
b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
b.model_catalog=lambda model:json.loads(sys.argv[2])
print(json.dumps(b.main()))`, resolve("bin"), JSON.stringify(models)], timeoutMs: 10000,
  });
  return { request, calls, get current() { return current; } };
}

const writeCalls = fixture => fixture.calls.filter(call => call.method === "thread-follower-update-thread-settings");
async function setEffort(fixture, effort = "high", changes = {}) {
  const read = await fixture.request();
  return fixture.request({ operation: "set-model", model: read.current.model, effort, expectedRevision: read.revision, requestId, ...changes });
}

test("model reading uses effective Ultra despite stale raw effort and returns no private settings", async t => {
  const f = await desktop(t), read = await f.request();
  assert.equal(read.ok, true); assert.equal(read.threadId, id); assert.equal(read.current.effort, "ultra");
  assert.equal(read.current.model, "gpt-6-astra"); assert.equal(read.canChange, true); assert.equal(read.canChangeModel, false);
  assert.equal(read.catalogSource, "bundled"); assert.match(read.revision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(read).includes("PRIVATE_SENTINEL"), false);
  assert.equal(JSON.stringify(read).includes("approvalPolicy"), false);
  assert.equal(f.calls.some(call => call.method === "thread-follower-read-model-settings"), true);
  assert.equal(writeCalls(f).length, 0);
});

test("next-turn effort updates the original active owner with raw condition and no model or permission override", async t => {
  const initial = state(); initial.threadRuntimeStatus = { type: "active" };
  const f = await desktop(t, initial), result = await setEffort(f);
  assert.equal(result.ok, true); assert.equal(result.status, "succeeded"); assert.equal(result.verified, true);
  assert.equal(result.current.effort, "high"); assert.equal(result.current.model, "gpt-6-astra");
  const [write] = writeCalls(f); assert.equal(writeCalls(f).length, 1); assert.equal(write.version, 2);
  assert.deepEqual(write.params, { conversationId: id, threadSettings: { effort: "high" },
    condition: { ifModelEquals: "gpt-6-astra", ifEffortEquals: null } });
  assert.equal(f.current.latestCollaborationMode.mode, "plan");
  assert.equal(f.current.latestCollaborationMode.settings.developer_instructions, "PRIVATE_SENTINEL");
  assert.equal(f.calls.some(call => /start-turn|steer-turn|interrupt/.test(call.method || "")), false);
});

test("saving the existing effort is a verified no-op", async t => {
  const f = await desktop(t), result = await setEffort(f, "ultra");
  assert.equal(result.ok, true); assert.equal(result.verified, true); assert.equal(writeCalls(f).length, 0);
});

test("cross-model writes are rejected even if the catalog contains the requested model", async t => {
  const f = await desktop(t), result = await setEffort(f, "high", { model: "gpt-6-luna" });
  assert.equal(result.ok, false); assert.equal(result.code, "model_change_unsupported");
  assert.equal(result.sent, false); assert.equal(writeCalls(f).length, 0);
});

test("unsupported effort and stale revision never dispatch", async t => {
  const f = await desktop(t);
  const effort = await setEffort(f, "medium"); assert.equal(effort.code, "model_effort_unsupported");
  const stale = await setEffort(f, "high", { expectedRevision: "a".repeat(64) }); assert.equal(stale.code, "model_state_changed");
  assert.equal(effort.sent, false); assert.equal(stale.sent, false); assert.equal(writeCalls(f).length, 0);
});

test("the native conditional rejection is a known unapplied result", async t => {
  const f = await desktop(t, state(), { applied: false }), result = await setEffort(f);
  assert.equal(result.ok, false); assert.equal(result.code, "model_state_changed"); assert.equal(result.sent, false);
  assert.equal(writeCalls(f).length, 1);
});

test("unavailable catalog keeps current settings readable without offering invented choices", async t => {
  const f = await desktop(t), read = await f.request({}, []);
  assert.equal(read.ok, true); assert.equal(read.current.effort, "ultra");
  assert.equal(read.canChange, false); assert.equal(read.reason, "model_catalog_unavailable"); assert.deepEqual(read.models, []);
});

for (const [name, patch] of [
  ["archived", { archived: true }], ["subagent", { parentThreadId: otherId }],
  ["not resumed", { resumeState: "needs_resume" }], ["uncertain submission", { unconfirmedTurnSubmissions: [{}] }],
  ["pending approval", { requests: [{ method: "item/commandExecution/requestApproval" }] }],
  ["waiting runtime", { threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] } }],
  ["compaction", { turns: [{ turnId: "turn", status: "inProgress", items: [{ type: "contextCompaction", id: "c", completed: false }] }] }],
]) test(`effort changes are blocked for ${name}`, async t => {
  const f = await desktop(t, { ...state(), ...patch }), read = await f.request();
  assert.equal(read.canChange, false); assert.equal(read.reason, "thread_not_ready");
  const result = await setEffort(f); assert.equal(result.ok, false); assert.equal(result.sent, false);
  assert.equal(writeCalls(f).length, 0);
});

test("a wrong thread snapshot or invalid input identity cannot grant model access", async t => {
  const f = await desktop(t, { ...state(), id: otherId });
  const wrong = await f.request(); assert.equal(wrong.ok, false); assert.equal(wrong.sent, false);
  const count = f.calls.length, invalid = await f.request({ threadId: "not-a-thread" });
  assert.equal(invalid.code, "invalid_model_settings"); assert.equal(f.calls.length, count); assert.equal(writeCalls(f).length, 0);
});

test("a settings change between the displayed version and dispatch is rejected", async t => {
  const f = await desktop(t, state(), { beforeSnapshot(current, index) {
    if (index === 4) { current.latestCollaborationMode.mode = "default"; current.latestThreadSettings.collaborationMode.mode = "default"; }
  } });
  const result = await setEffort(f); assert.equal(result.code, "model_state_changed");
  assert.equal(result.sent, false); assert.equal(writeCalls(f).length, 0);
});

for (const [name, options] of [
  ["native error", { writeError: true }], ["stale readback", { keepOldEffort: true }],
  ["provider changed", { afterWrite(current) { current.modelProvider = "another"; current.latestThreadSettings.modelProvider = "another"; } }],
  ["mode changed", { afterWrite(current) { current.latestCollaborationMode.mode = "default"; } }],
  ["permissions changed", { afterWrite(current) { current.currentPermissions.approvalPolicy = "on-request"; } }],
]) test(`a dispatched write with ${name} stays unknown without replay`, async t => {
  const f = await desktop(t, state(), options), result = await setEffort(f);
  assert.equal(result.ok, false); assert.equal(result.sent, null); assert.equal(writeCalls(f).length, 1);
  assert.equal(JSON.stringify(result).includes("private native exception"), false);
});

test("bundled catalog discovery only lists models in a fresh credential-free home and cleans up", async t => {
  const directory = mkdtempSync("/tmp/pocket-model-catalog-fixture-");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, "catalog.py"), receipt = join(directory, "receipt.json");
  writeFileSync(executable, `#!/usr/bin/env python3
import sys,json,os,pathlib
methods=[]
for line in sys.stdin:
 request=json.loads(line);methods.append(request['method'])
 if request['method']=='initialize':result={'codexHome':os.environ['CODEX_HOME']}
 elif request['method']=='initialized':continue
 elif request['method']=='model/list':result={'data':[{'id':'gpt-6-astra','model':'gpt-6-astra','displayName':'GPT-6-Astra','hidden':False,'supportedReasoningEfforts':[{'reasoningEffort':'low'},{'reasoningEffort':'ultra'}],'defaultReasoningEffort':'low'}],'nextCursor':None}
 else:raise RuntimeError('unexpected operation')
 print(json.dumps({'id':request['id'],'result':result}),flush=True)
pathlib.Path(${JSON.stringify(receipt)}).write_text(json.dumps({'methods':methods,'environmentKeys':sorted(os.environ),'home':os.environ['CODEX_HOME'],'config':pathlib.Path(os.environ['CODEX_HOME'],'config.toml').read_text()}))
`);
  chmodSync(executable, 0o700);
  const result = await runBridge({}, { command: "python3", args: ["-c", `import sys,json,os
sys.dont_write_bytecode=True
sys.path.insert(0,sys.argv[1])
import model_settings as m
m.bundled_cli=lambda app:{'entrypoint':sys.argv[2]}
m.verify_cli=lambda *args:'fixture'
os.environ['OPENAI_API_KEY']='must-not-inherit'
os.environ['CODEX_THREAD_ID']='must-not-inherit'
print(json.dumps(m.read_bundled_model('fixture','gpt-6-astra')))
`, resolve("bin"), executable], timeoutMs: 10000 });
  assert.deepEqual(result, [{ id: "gpt-6-astra", name: "GPT-6-Astra", supportedEfforts: ["low", "ultra"], defaultEffort: "low" }]);
  const observed = JSON.parse(readFileSync(receipt, "utf8"));
  assert.deepEqual(observed.methods, ["initialize", "initialized", "model/list"]);
  assert.equal(observed.environmentKeys.includes("OPENAI_API_KEY"), false);
  assert.equal(observed.environmentKeys.includes("CODEX_THREAD_ID"), false);
  assert.match(observed.config, /http:\/\/127\.0\.0\.1:1\/v1/);
  assert.match(observed.config, /cli_auth_credentials_store = "file"/);
  assert.equal(existsSync(observed.home), false);
});

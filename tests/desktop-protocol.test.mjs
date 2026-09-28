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
async function fakeDesktop(t, states) {
  const home = mkdtempSync("/tmp/navigator-ipc-");
  mkdirSync(join(home, "ipc"), { mode: 0o700 });
  const calls = [];
  let snapshots = 0;
  const server = net.createServer((socket) => {
    let pending = Buffer.alloc(0);
    const send = (object) => {
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
        if (m.type === "request")
          send({
            type: "response",
            requestId: m.requestId,
            resultType: "success",
            handledByClientId: "desktop-fixture",
            result:
              m.method === "initialize"
                ? { clientId: "navigator-fixture" }
                : {},
          });
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
          });
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
test("desktop bridge refuses a task that starts running before submission", async (t) => {
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
  assert.equal(r.code, "thread_changed");
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

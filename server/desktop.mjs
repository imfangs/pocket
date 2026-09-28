import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { AppError } from "./store.mjs";
import { readPersistedHistory } from "./history.mjs";

export function desktopRequest(payload) {
  const config = JSON.parse(
    readFileSync(
      new URL("../config/desktop-bridge.json", import.meta.url),
      "utf8",
    ),
  );
  return new Promise((resolve) => {
    const child = spawn(
      config.python,
      [fileURLToPath(new URL("../bin/desktop-bridge.py", import.meta.url))],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks = [];
    let bytes = 0,
      settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const uncertain = () => ({
      ok: false,
      code:
        payload.operation === "send"
          ? "dispatch_unknown"
          : "desktop_unavailable",
      sent: payload.operation === "send" ? null : false,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(uncertain());
    }, 16000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        child.kill();
        finish(uncertain());
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () =>
      finish({ ok: false, code: "desktop_unavailable", sent: false }),
    );
    child.stdin.on("error", () => {});
    child.on("close", () => {
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(uncertain());
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export class DesktopService {
  constructor(
    store,
    codexHome,
    request = desktopRequest,
    readHistory = readPersistedHistory,
  ) {
    Object.assign(this, { store, codexHome, request, readHistory });
    this.cache = new Map();
    this.sending = new Set();
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS dispatches(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,text_hash TEXT NOT NULL,status TEXT NOT NULL,turn_id TEXT,code TEXT,created_at INTEGER NOT NULL)",
    );
  }
  async history(id) {
    this.store.thread(id);
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < 3000) return cached.promise;
    const promise = this.loadHistory(id);
    this.cache.set(id, { at: Date.now(), promise });
    if (this.cache.size > 10) this.cache.delete(this.cache.keys().next().value);
    try {
      return await promise;
    } catch (e) {
      this.cache.delete(id);
      throw e;
    }
  }
  async loadHistory(id) {
    const result = await this.request({
      operation: "history",
      threadId: id,
      codexHome: this.codexHome,
    });
    let data;
    if (result.ok) data = result;
    else {
      try {
        data = this.readHistory(this.codexHome, id);
      } catch {
        data = {
          source: "unavailable",
          messages: [],
          runtime: "unavailable",
          canSend: false,
          hint: "暂时无法读取历史，请连接 Mac 中的原任务后刷新。",
        };
      }
      if (result.code === "app_version_changed")
        data.hint = "Codex 桌面版本已变化，发送功能需重新验证。";
    }
    if (this.store.thread(id).archived) {
      data.canSend = false;
      data.hint = "已归档任务可查看历史；请先在 Codex 中取消归档再继续。";
    }
    for (const message of data.messages || []) {
      if (message.clientMessageId)
        this.store.db
          .prepare(
            "UPDATE dispatches SET status='accepted',turn_id=?,code=NULL WHERE id=? AND thread_id=?",
          )
          .run(message.turnId || null, message.clientMessageId, id);
    }
    return { ...data, checkedAt: Date.now() };
  }
  receipt(row) {
    return {
      requestId: row.id,
      status: row.status,
      turnId: row.turn_id,
      code: row.code,
    };
  }
  getReceipt(id, requestId) {
    this.store.thread(id);
    const row = this.store.db
      .prepare("SELECT * FROM dispatches WHERE id=? AND thread_id=?")
      .get(requestId, id);
    return row ? this.receipt(row) : { requestId, status: "not_found" };
  }
  async send(id, input) {
    const thread = this.store.thread(id);
    if (thread.missing || thread.archived)
      throw new AppError("请先在 Mac 中恢复这条原任务", 409);
    if (
      !input ||
      Object.keys(input).some((k) => !["text", "requestId"].includes(k)) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 16000 ||
      typeof input.requestId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        input.requestId,
      )
    )
      throw new AppError("消息需为 1–16000 字，且带有效请求编号", 400);
    const text = input.text.trim(),
      hash = createHash("sha256").update(text).digest("hex");
    const old = this.store.db
      .prepare("SELECT * FROM dispatches WHERE id=?")
      .get(input.requestId);
    if (old) {
      if (old.thread_id !== id || old.text_hash !== hash)
        throw new AppError("请求编号已用于另一条消息", 409);
      return this.receipt(old);
    }
    if (this.sending.has(id))
      throw new AppError("这条任务正在提交消息，请稍后再试", 409);
    this.store.db
      .prepare(
        "INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,'pending',?)",
      )
      .run(input.requestId, id, hash, Date.now());
    let result;
    this.sending.add(id);
    try {
      result = await this.request({
        operation: "send",
        threadId: id,
        codexHome: this.codexHome,
        text,
        requestId: input.requestId,
      });
    } catch {
      result = { ok: false, code: "dispatch_unknown", sent: null };
    } finally {
      this.sending.delete(id);
    }
    const status = result.ok
      ? "accepted"
      : result.sent === false
        ? "rejected"
        : "unknown";
    this.store.db
      .prepare("UPDATE dispatches SET status=?,turn_id=?,code=? WHERE id=?")
      .run(status, result.turnId || null, result.code || null, input.requestId);
    this.cache.delete(id);
    return this.receipt(
      this.store.db
        .prepare("SELECT * FROM dispatches WHERE id=?")
        .get(input.requestId),
    );
  }
}

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
    store.db.exec("CREATE TABLE IF NOT EXISTS outgoing_messages(id TEXT PRIMARY KEY REFERENCES dispatches(id),thread_id TEXT NOT NULL,text TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)");
  }
  async history(id) {
    this.store.thread(id);
    const cached = this.cache.get(id);
    if (cached && (cached.pending || Date.now() - cached.at < (cached.runtime === "active" ? 750 : 3000)))
      return { ...await cached.promise, outbox: this.outbox(id) };
    const promise = this.loadHistory(id);
    const entry = { at: Date.now(), promise, pending: true, runtime: null };
    this.cache.set(id, entry);
    if (this.cache.size > 10) this.cache.delete(this.cache.keys().next().value);
    try {
      const data = await promise;
      entry.at = Date.now();
      entry.pending = false;
      entry.runtime = data.runtime;
      return { ...data, outbox: this.outbox(id) };
    } catch (e) {
      if (this.cache.get(id) === entry) this.cache.delete(id);
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
      if (message.clientMessageId)
        this.store.db.prepare("DELETE FROM outgoing_messages WHERE id=? AND thread_id=? AND EXISTS(SELECT 1 FROM dispatches WHERE id=? AND status='accepted')")
          .run(message.clientMessageId, id, message.clientMessageId);
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
  outbox(id) {
    return this.store.db.prepare("SELECT o.id,o.text,o.revision,d.status,d.code,d.created_at AS createdAt FROM outgoing_messages o JOIN dispatches d ON d.id=o.id WHERE o.thread_id=? ORDER BY d.created_at,o.rowid").all(id);
  }
  queue(id, requestId, text) {
    if (this.outbox(id).length >= 20) throw new AppError("这条任务最多保留 20 条待发消息", 409);
    this.transaction(() => {
      this.store.db.prepare("INSERT INTO outgoing_messages(id,thread_id,text) VALUES(?,?,?)").run(requestId, id, text);
      this.store.db.prepare("UPDATE dispatches SET status='queued',code=NULL WHERE id=?").run(requestId);
    });
    this.cache.delete(id);
  }
  transaction(action) {
    this.store.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.store.db.exec("COMMIT"); return result; }
    catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
  }
  queued(id, requestId, revision, allowed = ["queued", "rejected"]) {
    this.store.thread(id);
    const row = this.outbox(id).find(r => r.id === requestId);
    if (!row) throw new AppError("待发消息已发送或移除", 404);
    if (!Number.isInteger(revision) || row.revision !== revision) throw new AppError("待发消息已变化，请刷新后再操作", 409);
    if (!allowed.includes(row.status)) throw new AppError("消息正在提交或结果待确认，请先核对发送状态", 409);
    return row;
  }
  editQueued(id, requestId, input) {
    if (!input || Object.keys(input).some(k => !["text", "expectedRevision"].includes(k)) ||
        typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000)
      throw new AppError("消息需为 1–16000 字", 400);
    const text = input.text.trim();
    this.transaction(() => {
      this.queued(id, requestId, input.expectedRevision, ["queued", "rejected", "editing"]);
      this.store.db.prepare("UPDATE outgoing_messages SET text=?,revision=revision+1 WHERE id=?").run(text, requestId);
      this.store.db.prepare("UPDATE dispatches SET text_hash=?,status='queued',code=NULL WHERE id=?")
        .run(createHash("sha256").update(text).digest("hex"), requestId);
    });
    return { outbox: this.outbox(id) };
  }
  cancelQueued(id, requestId, input) {
    if (!input || Object.keys(input).some(k => k !== "expectedRevision")) throw new AppError("取消参数无效", 400);
    this.transaction(() => {
      this.queued(id, requestId, input.expectedRevision, ["queued", "rejected", "editing"]);
      this.store.db.prepare("DELETE FROM outgoing_messages WHERE id=?").run(requestId);
      this.store.db.prepare("UPDATE dispatches SET status='cancelled',code=NULL WHERE id=?").run(requestId);
    });
    return { outbox: this.outbox(id) };
  }
  pauseQueued(id, requestId, input, resume = false) {
    if (!input || Object.keys(input).some(k => k !== "expectedRevision")) throw new AppError("编辑参数无效", 400);
    this.transaction(() => {
      this.queued(id, requestId, input.expectedRevision, resume ? ["editing"] : ["queued", "rejected"]);
      this.store.db.prepare("UPDATE dispatches SET status=?,code=NULL WHERE id=?").run(resume ? "queued" : "editing", requestId);
      this.store.db.prepare("UPDATE outgoing_messages SET revision=revision+1 WHERE id=?").run(requestId);
    });
    return { outbox: this.outbox(id) };
  }
  async dispatchQueued(id, requestId, input, delivery = "now") {
    const thread = this.store.thread(id);
    if (thread.archived || thread.missing) throw new AppError("请先在 Mac 中恢复原任务", 409);
    if (!input || Object.keys(input).some(k => k !== "expectedRevision")) throw new AppError("发送参数无效", 400);
    const row = this.queued(id, requestId, input.expectedRevision);
    if (this.sending.has(id)) throw new AppError("原任务正在提交另一条消息", 409);
    this.sending.add(id);
    const claim = this.store.db.prepare("UPDATE dispatches SET status='pending',code=NULL WHERE id=? AND status IN('queued','rejected') AND EXISTS(SELECT 1 FROM outgoing_messages WHERE id=? AND revision=?)")
      .run(requestId, requestId, input.expectedRevision);
    if (!claim.changes) { this.sending.delete(id); throw new AppError("待发消息已变化，请刷新", 409); }
    let result;
    try {
      result = await this.request({ operation: "send", threadId: id, codexHome: this.codexHome,
        text: row.text, requestId, delivery });
    } catch { result = { ok: false, code: "dispatch_unknown", sent: null }; }
    finally { this.sending.delete(id); }
    const observed = this.getReceipt(id, requestId);
    const status = observed.status === "accepted" || result.ok ? "accepted"
      : result.code === "thread_active" && result.sent === false ? "queued"
      : result.sent === false ? "rejected" : "unknown";
    this.store.db.prepare("UPDATE dispatches SET status=?,turn_id=COALESCE(?,turn_id),code=? WHERE id=?")
      .run(status, result.turnId || null, result.code || null, requestId);
    if (status === "accepted") this.store.db.prepare("DELETE FROM outgoing_messages WHERE id=?").run(requestId);
    this.cache.delete(id);
    return this.getReceipt(id, requestId);
  }
  async processQueue() {
    const ids = this.store.db.prepare("SELECT DISTINCT thread_id FROM outgoing_messages").all().map(r => r.thread_id);
    for (const id of ids) {
      const thread = this.store.thread(id);
      if (thread.archived || thread.missing || this.sending.has(id)) continue;
      const head = this.outbox(id)[0];
      if (!head || head.status !== "queued") continue;
      const history = await this.history(id);
      if (!history.queueReady) continue;
      try { await this.dispatchQueued(id, head.id, { expectedRevision: head.revision }, "auto"); }
      catch { /* A concurrent edit/cancel is resolved by the next read. */ }
    }
  }
  startQueue() {
    if (this.queueStarted) return;
    this.queueStarted = true;
    this.store.db.exec("UPDATE dispatches SET status='unknown',code='submission_interrupted' WHERE status='pending' AND id IN(SELECT id FROM outgoing_messages)");
    const tick = async () => {
      try { await this.processQueue(); } catch { /* Retry reads; never replay unknown submissions. */ }
      if (this.queueStarted) { this.queueTimer = setTimeout(tick, 2000); this.queueTimer.unref?.(); }
    };
    this.queueTimer = setTimeout(tick, 100); this.queueTimer.unref?.();
  }
  stopQueue() { this.queueStarted = false; clearTimeout(this.queueTimer); }
  async send(id, input) {
    const thread = this.store.thread(id);
    if (thread.missing || thread.archived)
      throw new AppError("请先在 Mac 中恢复这条原任务", 409);
    if (
      !input ||
      Object.keys(input).some((k) => !["text", "requestId", "enqueue"].includes(k)) ||
      (input.enqueue !== undefined && input.enqueue !== true) ||
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
    if (this.sending.has(id) && !input.enqueue && !this.outbox(id).length)
      throw new AppError("这条任务正在提交消息，请稍后再试", 409);
    if (this.outbox(id).length >= 20) throw new AppError("这条任务最多保留 20 条待发消息", 409);
    this.store.db
      .prepare(
        "INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,'pending',?)",
      )
      .run(input.requestId, id, hash, Date.now());
    if (input.enqueue || this.outbox(id).length) {
      this.queue(id, input.requestId, text);
      return this.getReceipt(id, input.requestId);
    }
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
    if (result.code === "thread_active" && result.sent === false) {
      this.queue(id, input.requestId, text);
      return this.getReceipt(id, input.requestId);
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

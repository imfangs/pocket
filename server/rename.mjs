import { readBridgeConfig } from "./bridge-config.mjs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AppError } from "./store.mjs";
import { runBridge } from "./bridge-process.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fingerprint = /^[a-f0-9]{64}$/;
const unresolved = status => status === "pending" || status === "unknown";
const safeCode = code => typeof code === "string" && /^[a-z0-9_]{1,100}$/.test(code) ? code : null;
const messages = {
  archived_thread: "请先恢复会话，再重命名。",
  thread_missing: "暂时找不到会话，请刷新后重试。",
  thread_not_found: "暂时找不到会话，请刷新后重试。",
  lifecycle_pending: "此会话有未完成的管理操作，请先核对。",
  app_version_changed: "桌面版本已变化，重命名需更新兼容支持。",
  cli_version_changed: "桌面版本已变化，重命名需更新兼容支持。",
  source_unavailable: "会话暂不可用，请稍后重试。",
  rename_not_applied: "已确认名称未改变，可以再次保存。",
};
function nativeRequest(payload) {
  const config = readBridgeConfig();
  return runBridge(payload, { command: config.python,
    args: [fileURLToPath(new URL("../bin/rename-thread.py", import.meta.url))], timeoutMs: 50000 });
}
function identity(id, label = "会话") {
  if (typeof id !== "string" || !uuid.test(id)) throw new AppError(`${label}编号无效`, 400);
  return id;
}
function inputOf(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["requestId", "name", "expectedName", "expectedFingerprint"].includes(key)))
    throw new AppError("重命名请求格式无效", 400);
  identity(input.requestId, "请求");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 220 ||
      /[\p{Cc}\p{Zl}\p{Zp}]/u.test(input.name))
    throw new AppError("会话名称需为 1–220 个字符，不能包含换行或控制字符", 400);
  if (typeof input.expectedName !== "string" || input.expectedName.length > 220 ||
      typeof input.expectedFingerprint !== "string" || !fingerprint.test(input.expectedFingerprint))
    throw new AppError("请先重新读取原标题，再保存名称", 400);
  return { name: input.name.trim(), expectedName: input.expectedName, expectedFingerprint: input.expectedFingerprint };
}

// This ledger only owns rename receipts. It never suspends the original owner,
// starts a model turn, or blocks the independent message queue.
export class RenameService {
  constructor(store, codexHome, sync, options = {}) {
    Object.assign(this, { store, codexHome, sync });
    this.request = options.request || nativeRequest;
    this.lifecycleBlocked = options.lifecycleBlocked || (() => false);
    this.running = new Map();
    this.inspections = new Map();
    this.stopped = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS rename_operations(
      id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,input_hash TEXT NOT NULL,payload TEXT NOT NULL,
      status TEXT NOT NULL,code TEXT,current_title TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      process_stopped INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS rename_unresolved_thread ON rename_operations(thread_id)
        WHERE status IN ('pending','unknown');`);
    if (!store.db.prepare("PRAGMA table_info(rename_operations)").all().some(column => column.name === "process_stopped"))
      store.db.exec("ALTER TABLE rename_operations ADD COLUMN process_stopped INTEGER NOT NULL DEFAULT 0");
    store.db.prepare("UPDATE rename_operations SET status='unknown',code='rename_interrupted',updated_at=? WHERE status='pending'").run(Date.now());
  }
  row(threadId, requestId) {
    identity(threadId); identity(requestId, "请求");
    const row = this.store.db.prepare("SELECT * FROM rename_operations WHERE id=?").get(requestId);
    if (!row || row.thread_id !== threadId) throw new AppError("找不到这次重命名操作", 404);
    return row;
  }
  active(threadId) {
    return this.store.db.prepare("SELECT * FROM rename_operations WHERE thread_id=? AND status IN ('pending','unknown')").get(threadId);
  }
  receipt(row) {
    const result = { requestId: row.id, threadId: row.thread_id, status: row.status, name: JSON.parse(row.payload).name };
    if (row.code) result.code = row.code;
    if (row.current_title != null) result.currentTitle = row.current_title;
    if (row.code && messages[row.code]) result.message = messages[row.code];
    if (row.status === "succeeded") {
      const thread = this.store.thread(row.thread_id);
      result.thread = { ...thread, ...this.store.annotation(row.thread_id, thread) };
    }
    return result;
  }
  update(row, status, code = null, title = null, processStopped = null) {
    if (this.stopped) return;
    this.store.db.prepare("UPDATE rename_operations SET status=?,code=?,current_title=?,updated_at=?,process_stopped=COALESCE(?,process_stopped) WHERE id=?")
      .run(status, safeCode(code), typeof title === "string" ? title : row.current_title, Date.now(),
        processStopped === null ? null : Number(processStopped), row.id);
  }
  validSnapshot(result, threadId) {
    return result && result.threadId === threadId && result.verified === true && result.processStopped === true &&
      typeof result.title === "string" && result.title.length <= 220 &&
      typeof result.nameFingerprint === "string" && fingerprint.test(result.nameFingerprint);
  }
  async readCurrent(threadId) {
    if (this.inspections.has(threadId)) return this.inspections.get(threadId);
    const promise = Promise.resolve().then(() => this.request({ operation: "inspect", threadId, codexHome: this.codexHome }))
      .catch(() => ({ status: "unavailable", code: "source_unavailable" }))
      .then(result => {
        if (!this.stopped && this.validSnapshot(result, threadId)) {
          try { this.sync(); } catch { /* Keep the source error and the last catalog intact. */ }
        }
        return result;
      }).finally(() => {
        if (this.inspections.get(threadId) === promise) this.inspections.delete(threadId);
      });
    this.inspections.set(threadId, promise);
    return promise;
  }
  finish(row, result) {
    if (this.stopped) return;
    const { name } = JSON.parse(row.payload);
    if (!this.validSnapshot(result, row.thread_id) || result.title !== name || result.archived !== false) {
      this.update(row, "unknown", "rename_outcome_unknown", result?.title, result?.processStopped === true); return;
    }
    try {
      this.sync();
      const thread = this.store.thread(row.thread_id);
      if (thread.missing || thread.archived || thread.title !== name) {
        this.update(row, "unknown", "rename_source_unconfirmed", result.title, true); return;
      }
      this.update(row, "succeeded", null, thread.title, true);
    } catch {
      this.update(row, "unknown", "rename_source_unconfirmed", result.title, true);
    }
  }
  reconcile(row, result) {
    if (this.stopped || this.running.has(row.id)) return;
    row = this.row(row.thread_id, row.id);
    if (!unresolved(row.status)) return;
    // A matching name cannot clear a failed protection check on other metadata.
    if (row.code === "thread_metadata_changed" || row.process_stopped !== 1) return;
    if (!this.validSnapshot(result, row.thread_id) || result.archived !== false) return;
    const payload = JSON.parse(row.payload);
    if (result.title === payload.name) this.finish(row, result);
    else if (result.title === payload.expectedName && result.nameFingerprint === payload.expectedFingerprint)
      this.update(row, "rejected", "rename_not_applied", result.title);
    else this.update(row, "changed", "name_changed", result.title);
  }
  async inspect(threadId) {
    identity(threadId);
    const thread = this.store.thread(threadId);
    let row = this.active(threadId);
    const prior = row ? JSON.parse(row.payload) : null;
    if (row && this.running.has(row.id)) return { title: thread.title, name: null,
      nameFingerprint: prior.expectedFingerprint, canRename: false, operation: this.receipt(row) };
    if (thread.missing) return { title: thread.title, name: null, nameFingerprint: "", canRename: false,
      code: "thread_missing", ...(row ? { operation: this.receipt(row) } : {}) };
    const result = await this.readCurrent(threadId);
    if (row && !this.stopped) {
      this.reconcile(row, result);
      row = this.row(threadId, row.id);
    }
    const valid = this.validSnapshot(result, threadId);
    const code = valid && result.archived ? "archived_thread" : this.lifecycleBlocked(threadId) ? "lifecycle_pending" : safeCode(result?.code);
    return { title: valid ? result.title : thread.title,
      name: valid && typeof result.name === "string" ? result.name : null,
      nameFingerprint: valid ? result.nameFingerprint : "", canRename: valid && result.canRename === true &&
        result.archived === false && !this.lifecycleBlocked(threadId) && !(row && unresolved(row.status)),
      ...(code ? { code } : {}), ...(row ? { operation: this.receipt(row) } : {}) };
  }
  start(threadId, input) {
    identity(threadId);
    const payload = inputOf(input);
    const hash = createHash("sha256").update(JSON.stringify([threadId, payload])).digest("hex");
    let row, created = false;
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      row = this.store.db.prepare("SELECT * FROM rename_operations WHERE id=?").get(input.requestId);
      if (row) {
        if (row.input_hash !== hash) throw new AppError("请求编号已用于另一项操作", 409);
      } else {
        this.store.thread(threadId);
        if (this.active(threadId)) throw new AppError("此会话有未确认的重命名，请先核对结果", 409);
        const now = Date.now();
        this.store.db.prepare("INSERT INTO rename_operations(id,thread_id,input_hash,payload,status,code,current_title,created_at,updated_at) VALUES(?,?,?,?,'pending',NULL,NULL,?,?)")
          .run(input.requestId, threadId, hash, JSON.stringify(payload), now, now);
        row = this.row(threadId, input.requestId); created = true;
      }
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    if (created) {
      // Do not use an inspection started before this write to decide whether
      // its later uncertain result was applied. Older readers may still finish.
      this.inspections.delete(threadId);
      const promise = Promise.resolve().then(() => this.step(row)).catch(() => {
        this.update(row, "unknown", "rename_outcome_unknown");
      }).finally(() => this.running.delete(row.id));
      this.running.set(row.id, promise);
    }
    return this.receipt(row);
  }
  async step(row) {
    if (this.stopped) return;
    try { this.sync(); } catch { this.update(row, "rejected", "source_unavailable"); return; }
    const source = this.store.thread(row.thread_id);
    const blocked = source.missing ? "thread_missing" : source.archived ? "archived_thread" :
      this.lifecycleBlocked(row.thread_id) ? "lifecycle_pending" : null;
    if (blocked) { this.update(row, "rejected", blocked); return; }
    const result = await this.request({ operation: "rename", threadId: row.thread_id, codexHome: this.codexHome,
      ...JSON.parse(row.payload) });
    if (this.stopped) return;
    if (["renamed", "unchanged"].includes(result?.status) && this.validSnapshot(result, row.thread_id)) {
      this.finish(row, result);
    } else if (result?.status === "changed" && result.threadId === row.thread_id &&
        result.mutationAttempted === false && result.processStopped === true) {
      this.update(row, "changed", result.code || "name_changed", result.title, true);
      try { this.sync(); } catch {}
    } else if ((result?.status === "unavailable" && result.mutationAttempted === false && result.processStopped === true) || result?.sent === false) {
      this.update(row, "rejected", result.code || "rename_unavailable", result.title, result.processStopped === true);
    } else {
      this.update(row, "unknown", result?.code || "rename_outcome_unknown", result?.title, result?.processStopped === true);
    }
  }
  async get(threadId, requestId) {
    let row = this.row(threadId, requestId);
    if (unresolved(row.status) && !this.running.has(row.id)) {
      const result = await this.readCurrent(threadId);
      this.reconcile(row, result);
      row = this.row(threadId, requestId);
    }
    return this.receipt(row);
  }
  stop() { this.stopped = true; }
}

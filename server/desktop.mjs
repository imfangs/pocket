import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./store.mjs";
import { readPersistedHistory } from "./history.mjs";
import { ExecutionStops } from "./execution-stops.mjs";
import { runBridge } from "./bridge-process.mjs";
import { Attachments, messageFingerprint } from "./attachments.mjs";

const compatibilityHints = {
  desktop_protocol_incompatible: "Mac 中的 Codex 接口与 Pocket 不兼容，暂时无法发送或压缩。草稿和待发消息已保留。",
  desktop_protocol_error: "Mac 中的 Codex 接口与 Pocket 不兼容，暂时无法发送或压缩。草稿和待发消息已保留。",
  unsupported_app_identity: "当前桌面应用不是受支持的 Codex，暂时无法连接。草稿和待发消息已保留。",
  // Old persisted receipts may still carry the former version gate's code.
  app_version_changed: "当前桌面连接尚未通过兼容检查，暂时无法发送或压缩。草稿和待发消息已保留。",
};
const compatibilityFailure = result => !result.ok &&
  [result.code, result.connectionReason].find(code => Object.hasOwn(compatibilityHints, code));

export function desktopRequest(payload) {
  const config = JSON.parse(
    readFileSync(
      new URL("../config/desktop-bridge.json", import.meta.url),
      "utf8",
    ),
  );
  return runBridge(payload, {
    command: config.python,
    args: [fileURLToPath(new URL("../bin/desktop-bridge.py", import.meta.url))],
    timeoutMs: payload.operation === "send" ? 45000 : 16000,
  });
}

export class DesktopService {
  constructor(
    store,
    codexHome,
    request = desktopRequest,
    readHistory = readPersistedHistory,
    { openThread, connectionTimeoutMs = 45000, connectionPollMs = 500, attachmentOptions } = {},
  ) {
    Object.assign(this, { store, codexHome, request, readHistory });
    Object.assign(this, { openThread, connectionTimeoutMs, connectionPollMs });
    this.connections = new Map();
    this.cache = new Map();
    this.recentReads = new Map();
    this.sending = new Set();
    this.queueReservations = new Set();
    this.stops = new ExecutionStops(store, payload => this.request({ ...payload, codexHome: this.codexHome }));
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS dispatches(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,text_hash TEXT NOT NULL,status TEXT NOT NULL,turn_id TEXT,code TEXT,created_at INTEGER NOT NULL)",
    );
    store.db.exec("CREATE TABLE IF NOT EXISTS outgoing_messages(id TEXT PRIMARY KEY REFERENCES dispatches(id),thread_id TEXT NOT NULL,text TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)");
    store.db.exec("CREATE TABLE IF NOT EXISTS compactions(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,status TEXT NOT NULL,baseline_id TEXT,code TEXT,created_at INTEGER NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS request_responses(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,request_key TEXT NOT NULL,decision TEXT NOT NULL,status TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS question_answers(id TEXT PRIMARY KEY REFERENCES dispatches(id),thread_id TEXT NOT NULL,question_key TEXT NOT NULL)");
    this.attachments = new Attachments(store, attachmentOptions);
  }
  isLifecycleBlocked(id) { return this.lifecycleBlocked?.(id) === true; }
  requireLifecycleOpen(id) {
    if (this.isLifecycleBlocked(id)) throw new AppError("此会话正在等待归档或核对管理操作，请先取消或完成该操作", 409);
  }
  suspendConnection(id) {
    this.cache.delete(id);
    const entry = this.connections.get(id);
    if (entry?.state.status === "connecting") {
      entry.state.status = "failed";
      entry.state.code = "lifecycle_pending";
      entry.controller.abort();
    }
  }
  connection(id) {
    this.store.thread(id);
    const entry = this.connections.get(id);
    return entry ? { ...entry.state } : { status: "idle" };
  }
  connect(id, { open = true } = {}) {
    this.requireLifecycleOpen(id);
    const thread = this.store.thread(id);
    if (thread.archived || thread.missing) throw new AppError("请先恢复会话", 409);
    if (!this.openThread) throw new AppError("当前环境无法连接桌面会话", 503);
    const previous = this.connections.get(id);
    if (previous?.state.status === "connecting") return { ...previous.state };
    const now = Date.now();
    const entry = { state: { requestId: randomUUID(), status: "connecting", startedAt: now, checkedAt: now },
      controller: new AbortController() };
    this.connections.delete(id);
    this.connections.set(id, entry);
    if (this.connections.size > 100) {
      const oldest = [...this.connections].find(([, value]) => value.state.status !== "connecting");
      if (oldest) this.connections.delete(oldest[0]);
    }
    this.cache.delete(id);
    // The response is immediate. Only this explicit operation may open a desktop
    // thread; ordinary history and queue polling remain read-only.
    void this.recoverConnection(id, entry, open);
    return { ...entry.state };
  }
  async recoverConnection(id, entry, openImmediately) {
    const { signal } = entry.controller;
    const current = () => !signal.aborted && this.connections.get(id) === entry;
    const deadline = entry.state.startedAt + this.connectionTimeoutMs;
    const bounded = async operation => {
      let timer, abort;
      const timeout = new Promise((_, reject) => {
        abort = () => reject(new Error("connection_cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => reject(new Error("connection_timeout")), Math.max(1, deadline - Date.now()));
        timer.unref?.();
      });
      try { return await Promise.race([operation(), timeout]); }
      finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
    };
    let opened = false, lastCode = "connection_timeout";
    try {
      if (openImmediately) { await bounded(() => this.openThread(id)); opened = true; }
      for (let attempt = 0; current() && Date.now() < deadline; attempt++) {
        const result = await bounded(() => this.request({ operation: "history", threadId: id,
          codexHome: this.codexHome, ownerLookupTimeoutMs: 10000 }));
        if (!current()) return;
        entry.state.checkedAt = Date.now();
        if (result.ok && result.source === "desktop" && result.resumeState === "resumed") {
          const data = { ...result, checkedAt: entry.state.checkedAt };
          this.cache.set(id, { at: Date.now(), promise: Promise.resolve(data), pending: false, runtime: data.runtime });
          entry.state.status = "connected";
          return;
        }
        const incompatible = compatibilityFailure(result);
        lastCode = incompatible || result.connectionReason || result.code || "thread_not_resumed";
        if (incompatible) break;
        if (!opened) { await bounded(() => this.openThread(id)); opened = true; }
        await bounded(() => new Promise(resolve => {
          // Keep the full initialization window without rapidly exhausting it.
          // Production reads are separated by 500 ms, 1 s, then at least 2 s.
          const delay = Math.min(2000, this.connectionPollMs * 2 ** Math.min(attempt, 8));
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        }));
      }
      if (current()) Object.assign(entry.state, { status: "failed", code: lastCode, checkedAt: Date.now() });
    } catch (error) {
      if (current()) Object.assign(entry.state, { status: "failed", code: error.message === "connection_timeout" ? lastCode : "desktop_unavailable", checkedAt: Date.now() });
    }
  }
  connectForSubmission(id) {
    if (this.isLifecycleBlocked(id)) return;
    const thread = this.store.thread(id);
    if (thread.archived || thread.missing) return;
    if (!this.openThread || this.sending.has(id) || this.stops.pause(id) || this.stops.pending(id) || this.compactionPending(id)) return;
    const head = this.outbox(id)[0];
    if (head?.status !== "queued") return;
    // Never reopen from an automatic queue tick or replay an uncertain send.
    this.connect(id, { open: false });
  }
  recoverableConnectionFailure(result) {
    return !!this.openThread && result.sent === false &&
      ["desktop_unavailable", "desktop_preflight_timeout"].includes(result.code);
  }
  async history(id) {
    this.store.thread(id);
    if (this.isLifecycleBlocked(id)) {
      let data;
      try { data = this.readHistory(this.codexHome, id); }
      catch { data = { source: "rollout", messages: [], runtime: "unavailable" }; }
      return this.withActions(id, { ...data, canSend: false, canStop: false, canCompact: false,
        hint: "此会话有待完成的归档或管理操作；可以阅读历史，取消后可继续。", checkedAt: Date.now() });
    }
    const cached = this.cache.get(id);
    if (cached && (cached.pending || Date.now() - cached.at < (cached.runtime === "active" ? 750 : 3000)))
      return this.withActions(id, await cached.promise);
    const promise = this.loadHistory(id);
    const entry = { at: Date.now(), promise, pending: true, runtime: null };
    this.cache.set(id, entry);
    if (this.cache.size > 10) this.cache.delete(this.cache.keys().next().value);
    try {
      const data = await promise;
      entry.at = Date.now();
      entry.pending = false;
      entry.runtime = data.runtime;
      return this.withActions(id, data);
    } catch (e) {
      if (this.cache.get(id) === entry) this.cache.delete(id);
      throw e;
    }
  }
  transcript(id) {
    this.store.thread(id);
    const saved = this.readHistory(this.codexHome, id);
    // Display data only. Never promote saved text into live permissions or
    // reconcile pending sends/approvals from this fast path.
    return this.attachments.enrich(id, { source: "rollout", messages: saved.messages || [], hasMore: !!saved.hasMore,
      turnTiming: saved.turnTiming || null, checkedAt: Date.now() });
  }
  async loadHistory(id) {
    const now = Date.now();
    const retrying = now - (this.recentReads.get(id) ?? -Infinity) < 60000;
    this.recentReads.delete(id);
    this.recentReads.set(id, now);
    if (this.recentReads.size > 40) this.recentReads.delete(this.recentReads.keys().next().value);
    const result = await this.request({
      operation: "history",
      threadId: id,
      codexHome: this.codexHome,
      ownerLookupTimeoutMs: retrying ? 10000 : 2000,
    });
    let data;
    if (result.ok) data = { source: "desktop", ...result };
    else {
      try {
        data = this.readHistory(this.codexHome, id);
      } catch {
        data = {
          source: "unavailable",
          messages: [],
          runtime: "unavailable",
          canSend: false,
          hint: "历史暂时无法载入，请稍后刷新。",
        };
      }
      const incompatible = compatibilityFailure(result);
      if (incompatible) {
        data.hint = compatibilityHints[incompatible];
        data.readOnlyReason = incompatible;
        data.canSend = data.canStop = data.canCompact = data.queueReady = false;
      }
      if (result.connectionReason) data.connectionReason = result.connectionReason;
    }
    if (this.store.thread(id).archived) {
      data.canSend = false;
      data.canCompact = false;
      data.canStop = false;
      data.hint = "已归档任务可查看历史；请先在 Codex 中取消归档再继续。";
    }
    this.stops.reconcile(id, data);
    const action = this.compactionRequest(id);
    const compact = data.compaction;
    if (action && ["pending", "accepted", "unknown"].includes(action.status) &&
        data.source === "desktop" && compact?.latestId && compact.latestId !== action.baseline_id && compact.completed) {
      this.store.db.prepare("UPDATE compactions SET status=?,code=NULL WHERE id=?")
        .run(["failed", "interrupted"].includes(compact.turnStatus) ? "failed" : "completed", action.id);
    }
    if (data.source === "desktop" && Array.isArray(data.pendingRequests)) {
      const keys = new Set(data.pendingRequests.map(r => r.key));
      const responses = this.store.db.prepare("SELECT id,request_key FROM request_responses WHERE thread_id=? AND status IN('pending','accepted','unknown')").all(id);
      for (const response of responses) if (!keys.has(response.request_key))
        this.store.db.prepare("UPDATE request_responses SET status='resolved',code=NULL WHERE id=?").run(response.id);
    }
    for (const message of data.source === "desktop" ? data.messages || [] : []) {
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
  compactionRequest(id) {
    return this.store.db.prepare("SELECT * FROM compactions WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id);
  }
  compactionPending(id) {
    return ["pending", "accepted", "unknown"].includes(this.compactionRequest(id)?.status);
  }
  getCompactionReceipt(id, requestId) {
    this.store.thread(id);
    const row = this.store.db.prepare("SELECT * FROM compactions WHERE id=? AND thread_id=?").get(requestId, id);
    return { requestId, status: row?.status || "not_found", code: row?.code || null };
  }
  withActions(id, data) {
    const action = this.compactionRequest(id);
    const blocked = this.compactionPending(id) || this.stops.pending(id);
    const queuePaused = this.stops.pause(id);
    const outbox = this.outbox(id);
    const thread = this.store.thread(id);
    const targetAvailable = !thread.archived && !thread.missing && !this.isLifecycleBlocked(id);
    const entry = this.connections.get(id);
    if (entry?.state.status === "failed" && data.source === "desktop" && data.resumeState === "resumed" && data.checkedAt >= entry.state.checkedAt) {
      Object.assign(entry.state, { status: "connected", checkedAt: data.checkedAt });
      delete entry.state.code;
    }
    const connection = this.connection(id);
    const compatibilityBlocked = Object.hasOwn(compatibilityHints, data.readOnlyReason) ||
      (connection.status === "failed" && Object.hasOwn(compatibilityHints, connection.code));
    const executionAvailable = targetAvailable && !compatibilityBlocked;
    const pendingRequests = (data.pendingRequests || []).map(request => ({ ...request,
      response: this.store.db.prepare("SELECT id AS responseId,status FROM request_responses WHERE thread_id=? AND request_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id, request.key) || null }));
    const asyncQuestions = (data.asyncQuestions || []).map(question => ({ ...question,
      response: this.store.db.prepare("SELECT d.id AS requestId,d.status FROM question_answers q JOIN dispatches d ON d.id=q.id WHERE q.thread_id=? AND q.question_key=? ORDER BY d.created_at DESC LIMIT 1").get(id, question.key) || null }));
    return { ...this.attachments.enrich(id, data), connection, outbox, pendingRequests, canCompact: executionAvailable && !!data.canCompact && !blocked && !this.sending.has(id),
      canAttemptCompact: executionAvailable && !blocked && !this.sending.has(id) &&
        (!!data.canCompact || data.source !== "desktop"),
      asyncQuestions,
      canQueue: targetAvailable && this.queueSize(id, outbox.length) < 20,
      canAttemptSend: executionAvailable && !blocked && !this.sending.has(id) &&
        (!!data.canSend || data.source !== "desktop"),
      canSend: executionAvailable && data.canSend && !blocked, queueReady: executionAvailable && data.queueReady && !blocked && !queuePaused,
      canStop: executionAvailable && !!data.canStop && !this.stops.pending(id), activeTurnId: data.activeTurnId || null,
      queuePaused, stopRequest: this.stops.latest(id),
      compactionRequest: action ? { requestId: action.id, status: action.status, code: action.code } : null };
  }
  async answer(id, questionKey, input) {
    this.requireLifecycleOpen(id);
    const thread = this.store.thread(id);
    if (!input || Object.keys(input).some(k => !["requestId", "text"].includes(k)) ||
        typeof input.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId) ||
        typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000 || !/^[a-f0-9]{64}$/.test(questionKey))
      throw new AppError("回答需为 1–16000 字，并带有效请求编号", 400);
    const text = input.text.trim();
    const hash = createHash("sha256").update(questionKey + "\0" + text).digest("hex");
    const old = this.store.db.prepare("SELECT * FROM dispatches WHERE id=?").get(input.requestId);
    if (old) {
      if (old.thread_id !== id || old.text_hash !== hash) throw new AppError("请求编号已用于另一条回答", 409);
      return this.receipt(old);
    }
    if (thread.archived || thread.missing || this.sending.has(id) || this.stops.pending(id) || this.compactionPending(id))
      throw new AppError("会话暂时无法接收回答，请刷新状态", 409);
    const prior = this.store.db.prepare("SELECT d.id FROM question_answers q JOIN dispatches d ON d.id=q.id WHERE q.thread_id=? AND q.question_key=? AND d.status IN('pending','accepted','unknown')").get(id, questionKey);
    if (prior) throw new AppError("这道问题已有回答，请先核对状态", 409);
    this.transaction(() => {
      this.store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,'pending',?)").run(input.requestId, id, hash, Date.now());
      this.store.db.prepare("INSERT INTO question_answers VALUES(?,?,?)").run(input.requestId, id, questionKey);
    });
    this.sending.add(id);
    let result;
    try { result = await this.request({ operation: "answer", threadId: id, codexHome: this.codexHome, questionKey, text, requestId: input.requestId, delivery: "now" }); }
    catch { result = { ok: false, sent: null, code: "dispatch_unknown" }; }
    finally { this.sending.delete(id); }
    const status = result.ok ? "accepted" : result.sent === false ? "rejected" : "unknown";
    this.store.db.prepare("UPDATE dispatches SET status=?,code=? WHERE id=? AND status='pending'").run(status, result.code || null, input.requestId);
    this.cache.delete(id);
    return this.getReceipt(id, input.requestId);
  }
  async stop(id, input) {
    this.requireLifecycleOpen(id);
    try { return await this.stops.stop(id, input); }
    finally { this.cache.delete(id); }
  }
  async resumeQueue(id, input) {
    this.requireLifecycleOpen(id);
    this.stops.resume(id, input);
    this.cache.delete(id);
    await this.processQueueForThread(id);
    return { outbox: this.outbox(id), queuePaused: this.stops.pause(id) };
  }
  getResponseReceipt(id, responseId) {
    this.store.thread(id);
    const row = this.store.db.prepare("SELECT id AS responseId,status,code FROM request_responses WHERE id=? AND thread_id=?").get(responseId, id);
    return row || { responseId, status: "not_found" };
  }
  async respond(id, requestKey, input) {
    this.requireLifecycleOpen(id);
    const thread = this.store.thread(id);
    const hasAnswers = input?.answers && typeof input.answers === "object" && !Array.isArray(input.answers);
    if (!input || Object.keys(input).some(k => !["responseId", "decision", "answers"].includes(k)) ||
        (hasAnswers ? input.decision !== undefined || !Object.keys(input.answers).length || Object.keys(input.answers).length > 10 ||
          Object.values(input.answers).some(v => typeof v !== "string" || !v.trim() || v.length > 16000) || JSON.stringify(input.answers).length > 40000
          : !["accept", "cancel"].includes(input.decision) || input.answers !== undefined) || typeof input.responseId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.responseId) || !/^[a-f0-9]{64}$/.test(requestKey))
      throw new AppError("审批响应参数无效", 400);
    const recordedDecision = hasAnswers ? 'answers:' + createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(input.answers).sort(([a], [b]) => a.localeCompare(b))))).digest('hex') : input.decision;
    const old = this.store.db.prepare("SELECT * FROM request_responses WHERE id=?").get(input.responseId);
    if (old) {
      if (old.thread_id !== id || old.request_key !== requestKey || old.decision !== recordedDecision) throw new AppError("响应编号已用于其他操作", 409);
      return this.getResponseReceipt(id, input.responseId);
    }
    if (thread.archived || thread.missing) throw new AppError("请先恢复会话", 409);
    const prior = this.store.db.prepare("SELECT id FROM request_responses WHERE thread_id=? AND request_key=? AND status IN('pending','accepted','unknown')").get(id, requestKey);
    if (prior) throw new AppError("这个请求已经响应，请先刷新核对", 409);
    this.store.db.prepare("INSERT INTO request_responses VALUES(?,?,?,?,'pending',NULL,?)")
      .run(input.responseId, id, requestKey, recordedDecision, Date.now());
    let result;
    try { result = await this.request({ operation: "respond", threadId: id, codexHome: this.codexHome, requestKey, decision: input.decision, ...(hasAnswers ? { answers: input.answers } : {}) }); }
    catch { result = { ok: false, sent: null, code: "dispatch_unknown" }; }
    const status = result.ok ? "accepted" : result.sent === false ? "rejected" : "unknown";
    this.store.db.prepare("UPDATE request_responses SET status=?,code=? WHERE id=? AND status='pending'")
      .run(status, result.code || null, input.responseId);
    this.cache.delete(id);
    return this.getResponseReceipt(id, input.responseId);
  }
  async compact(id, input) {
    this.requireLifecycleOpen(id);
    const thread = this.store.thread(id);
    if (!input || Object.keys(input).some(k => k !== "requestId") ||
        typeof input.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId))
      throw new AppError("需要有效的压缩请求编号", 400);
    const old = this.store.db.prepare("SELECT * FROM compactions WHERE id=?").get(input.requestId);
    if (old) {
      if (old.thread_id !== id) throw new AppError("请求编号已用于其他任务", 409);
      return { requestId: old.id, status: old.status, code: old.code };
    }
    if (thread.archived || thread.missing || this.sending.has(id) || this.compactionPending(id) || this.stops.pending(id))
      throw new AppError("请等当前操作完成并确认任务可用后再压缩", 409);
    this.sending.add(id);
    try {
      const state = await this.loadHistory(id);
      if (!state.canCompact || state.source !== "desktop") throw new AppError("请等本轮执行结束、会话连接恢复后再压缩", 409);
      this.store.db.prepare("INSERT INTO compactions VALUES(?,?,'pending',?,NULL,?)")
        .run(input.requestId, id, state.compaction?.latestId || null, Date.now());
      let result;
      try { result = await this.request({ operation: "compact", threadId: id, codexHome: this.codexHome,
        expectedCompactionId: state.compaction?.latestId || null }); }
      catch { result = { ok: false, sent: null, code: "dispatch_unknown" }; }
      const status = result.ok ? "accepted" : result.sent === false ? "rejected" : "unknown";
      // A parallel history read can observe completion before the RPC returns.
      this.store.db.prepare("UPDATE compactions SET status=?,code=? WHERE id=? AND status='pending'")
        .run(status, result.code || null, input.requestId);
      const row = this.store.db.prepare("SELECT * FROM compactions WHERE id=?").get(input.requestId);
      return { requestId: row.id, status: row.status, code: row.code };
    } finally { this.sending.delete(id); this.cache.delete(id); }
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
    return this.store.db.prepare("SELECT o.id,o.text,o.revision,d.status,d.code,d.created_at AS createdAt FROM outgoing_messages o JOIN dispatches d ON d.id=o.id WHERE o.thread_id=? ORDER BY d.created_at,d.rowid").all(id)
      .map(row => ({ ...row, attachments: this.attachments.forDispatch(id, row.id).map(a => this.attachments.public(a)) }));
  }
  queueSize(id, saved = this.outbox(id).length) {
    return saved + (this.queueReservations.has(id) ? 1 : 0);
  }
  queue(id, requestId, text) {
    const saved = this.outbox(id);
    if (!saved.some(row => row.id === requestId) && this.queueSize(id, saved.length) >= 20) throw new AppError("这条任务最多保留 20 条待发消息", 409);
    this.transaction(() => {
      this.store.db.prepare("INSERT INTO outgoing_messages(id,thread_id,text) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text").run(requestId, id, text);
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
        typeof input.text !== "string" || input.text.length > 16000)
      throw new AppError("消息需为 1–16000 字", 400);
    const text = input.text.trim();
    this.transaction(() => {
      this.queued(id, requestId, input.expectedRevision, ["queued", "rejected", "editing"]);
      const attachments = this.attachments.forDispatch(id, requestId);
      if (!text && !attachments.length) throw new AppError("请输入消息或添加附件");
      this.store.db.prepare("UPDATE outgoing_messages SET text=?,revision=revision+1 WHERE id=?").run(text, requestId);
      this.store.db.prepare("UPDATE dispatches SET text_hash=?,status='queued',code=NULL WHERE id=?")
        .run(messageFingerprint(text, attachments), requestId);
      this.attachments.updateText(requestId, text);
    });
    return { outbox: this.outbox(id) };
  }
  cancelQueued(id, requestId, input) {
    if (!input || Object.keys(input).some(k => k !== "expectedRevision")) throw new AppError("取消参数无效", 400);
    this.transaction(() => {
      this.queued(id, requestId, input.expectedRevision, ["queued", "rejected", "editing"]);
      this.store.db.prepare("DELETE FROM outgoing_messages WHERE id=?").run(requestId);
      this.store.db.prepare("UPDATE dispatches SET status='cancelled',code=NULL WHERE id=?").run(requestId);
      this.attachments.release(requestId);
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
  async dispatchQueued(id, requestId, input, delivery = "now", resumeAfterTurnId = null) {
    this.requireLifecycleOpen(id);
    const thread = this.store.thread(id);
    if (thread.archived || thread.missing) throw new AppError("请先恢复会话", 409);
    if (this.compactionPending(id)) throw new AppError("请先核对上下文压缩状态", 409);
    if (this.stops.pending(id) || (delivery !== "now" && this.stops.pause(id))) throw new AppError("待发消息已暂停，请先核对停止状态", 409);
    if (!input || Object.keys(input).some(k => k !== "expectedRevision")) throw new AppError("发送参数无效", 400);
    const row = this.queued(id, requestId, input.expectedRevision);
    if (this.sending.has(id)) throw new AppError("会话正在提交另一条消息", 409);
    this.sending.add(id);
    const claim = this.store.db.prepare("UPDATE dispatches SET status='pending',code=NULL WHERE id=? AND status IN('queued','rejected') AND EXISTS(SELECT 1 FROM outgoing_messages WHERE id=? AND revision=?)")
      .run(requestId, requestId, input.expectedRevision);
    if (!claim.changes) { this.sending.delete(id); throw new AppError("待发消息已变化，请刷新", 409); }
    let result;
    try {
      const saved = this.attachments.forDispatch(id, requestId);
      let attachments = [];
      if (saved.length) {
        try { attachments = await this.attachments.prepare(saved); }
        catch { result = { ok: false, code: "attachment_unavailable", sent: false }; }
      }
      if (!result) result = await this.request({ operation: "send", threadId: id, codexHome: this.codexHome,
        text: row.text, requestId, delivery, ...(attachments.length ? { attachments } : {}), ...(resumeAfterTurnId ? { resumeAfterTurnId } : {}) });
    } catch { result = { ok: false, code: "dispatch_unknown", sent: null }; }
    finally { this.sending.delete(id); }
    const observed = this.getReceipt(id, requestId);
    const reconnect = delivery === "now" && this.recoverableConnectionFailure(result);
    const status = observed.status === "accepted" || result.ok ? "accepted"
      : result.code === "thread_active" && result.sent === false ? "queued"
      : reconnect ? "queued"
      : result.sent === false ? "rejected" : "unknown";
    this.store.db.prepare("UPDATE dispatches SET status=?,turn_id=COALESCE(?,turn_id),code=? WHERE id=?")
      .run(status, result.turnId || null, result.code || null, requestId);
    if (status === "accepted") this.store.db.prepare("DELETE FROM outgoing_messages WHERE id=?").run(requestId);
    if (status === "accepted") this.onAccepted?.(id, this.getReceipt(id, requestId).turnId);
    this.cache.delete(id);
    if (status === "queued" && reconnect) this.connectForSubmission(id);
    return this.getReceipt(id, requestId);
  }
  async processQueue() {
    const ids = this.store.db.prepare("SELECT DISTINCT thread_id FROM outgoing_messages").all().map(r => r.thread_id);
    for (const id of ids) await this.processQueueForThread(id);
  }
  async processQueueForThread(id) {
    if (this.isLifecycleBlocked(id)) return;
    const thread = this.store.thread(id);
    if (thread.archived || thread.missing || this.sending.has(id) || this.stops.pause(id) || this.stops.pending(id)) return;
    const head = this.outbox(id)[0];
    if (!head || head.status !== "queued") return;
    const history = await this.history(id);
    const stopped = this.stops.latest(id);
    const explicitlyResumed = !this.stops.pause(id) && stopped?.status === "stopped" &&
      stopped.targetTurnId === history.latestTurnId && history.runtime === "idle" && history.canSend;
    if (!history.queueReady && !explicitlyResumed) return;
    try { await this.dispatchQueued(id, head.id, { expectedRevision: head.revision }, explicitlyResumed ? "resume" : "auto", explicitlyResumed ? stopped.targetTurnId : null); }
    catch { /* A concurrent edit/cancel is resolved by the next read. */ }
  }
  startQueue() {
    if (this.queueStarted) return;
    this.queueStarted = true;
    this.stops.recover();
    this.store.db.exec("UPDATE dispatches SET status='unknown',code='submission_interrupted' WHERE status='pending'");
    this.store.db.exec("UPDATE compactions SET status='unknown',code='submission_interrupted' WHERE status='pending'");
    this.store.db.exec("UPDATE request_responses SET status='unknown',code='submission_interrupted' WHERE status='pending'");
    const tick = async () => {
      try { await this.processQueue(); } catch { /* Retry reads; never replay unknown submissions. */ }
      if (this.queueStarted) { this.queueTimer = setTimeout(tick, 2000); this.queueTimer.unref?.(); }
    };
    this.queueTimer = setTimeout(tick, 100); this.queueTimer.unref?.();
  }
  stopQueue() {
    this.queueStarted = false; clearTimeout(this.queueTimer);
    for (const entry of this.connections.values()) {
      if (entry.state.status === "connecting") {
        entry.state.status = "failed"; entry.state.code = "connection_cancelled";
        entry.controller.abort();
      }
    }
  }
  async send(id, input) {
    this.requireLifecycleOpen(id);
    const thread = this.store.thread(id);
    if (thread.missing || thread.archived)
      throw new AppError("请先恢复会话", 409);
    if (
      !input ||
      Object.keys(input).some((k) => !["text", "requestId", "enqueue", "attachments"].includes(k)) ||
      (input.enqueue !== undefined && input.enqueue !== true) ||
      typeof input.text !== "string" ||
      (!input.text.trim() && !input.attachments?.length) ||
      input.text.length > 16000 ||
      typeof input.requestId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        input.requestId,
      )
    )
      throw new AppError("消息需为 1–16000 字，且带有效请求编号", 400);
    const text = input.text.trim(),
      uploaded = this.attachments.resolve(id, input.attachments === undefined ? [] : input.attachments, input.requestId),
      hash = messageFingerprint(text, uploaded);
    const old = this.store.db
      .prepare("SELECT * FROM dispatches WHERE id=?")
      .get(input.requestId);
    if (old) {
      if (old.thread_id !== id || old.text_hash !== hash)
        throw new AppError("请求编号已用于另一条消息", 409);
      return this.receipt(old);
    }
    if ((this.sending.has(id) || this.compactionPending(id) || this.stops.pending(id)) && !input.enqueue && !this.outbox(id).length)
      throw new AppError("这条任务正在提交消息，请稍后再试", 409);
    if (this.queueSize(id) >= 20) throw new AppError("这条任务最多保留 20 条待发消息", 409);
    const queueInitially = input.enqueue || this.outbox(id).length > 0;
    this.transaction(() => {
      this.store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,created_at) VALUES(?,?,?,'pending',?)")
        .run(input.requestId, id, hash, Date.now());
      this.attachments.bind(id, input.requestId, text, uploaded);
      if (uploaded.length)
        this.store.db.prepare("INSERT INTO outgoing_messages(id,thread_id,text) VALUES(?,?,?)").run(input.requestId, id, text);
    });
    if (queueInitially) {
      this.queue(id, input.requestId, text);
      this.connectForSubmission(id);
      return this.getReceipt(id, input.requestId);
    }
    let result;
    this.sending.add(id);
    // Keep room for this submission if a slow preflight finds an active turn.
    // Later explicit enqueues must not consume its fallback slot.
    if (!uploaded.length) this.queueReservations.add(id);
    try {
      let attachments = [];
      if (uploaded.length) {
        try { attachments = await this.attachments.prepare(uploaded); }
        catch { result = { ok: false, code: "attachment_unavailable", sent: false }; }
      }
      if (!result) result = await this.request({
        operation: "send",
        threadId: id,
        codexHome: this.codexHome,
        text,
        requestId: input.requestId,
        ...(attachments.length ? { attachments } : {}),
      });
    } catch {
      result = { ok: false, code: "dispatch_unknown", sent: null };
    } finally {
      this.sending.delete(id);
      this.queueReservations.delete(id);
    }
    const observed = this.getReceipt(id, input.requestId);
    if (observed.status !== "accepted" && result.code === "thread_active" && result.sent === false) {
      this.queue(id, input.requestId, text);
      return this.getReceipt(id, input.requestId);
    }
    if (observed.status !== "accepted" && this.recoverableConnectionFailure(result)) {
      this.queue(id, input.requestId, text);
      this.connectForSubmission(id);
      return this.getReceipt(id, input.requestId);
    }
    const status = observed.status === "accepted" || result.ok
      ? "accepted"
      : result.sent === false
        ? "rejected"
        : "unknown";
    this.store.db
      .prepare("UPDATE dispatches SET status=?,turn_id=?,code=? WHERE id=?")
      .run(status, result.turnId || observed.turnId || null, status === "accepted" ? null : result.code || null, input.requestId);
    if (status === "accepted") this.onAccepted?.(id, result.turnId);
    if (status === "accepted") this.store.db.prepare("DELETE FROM outgoing_messages WHERE id=?").run(input.requestId);
    this.cache.delete(id);
    return this.receipt(
      this.store.db
        .prepare("SELECT * FROM dispatches WHERE id=?")
        .get(input.requestId),
    );
  }
}

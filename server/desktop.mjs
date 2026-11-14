import { readBridgeConfig } from "./bridge-config.mjs";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { AppError } from "./store.mjs";
import { readPersistedHistory } from "./history.mjs";
import { POCKET_CONTENT } from "./pocket-content.mjs";
import { ExecutionStops } from "./execution-stops.mjs";
import { runBridge } from "./bridge-process.mjs";
import { ThreadModels } from "./thread-models.mjs";
import { Attachments, messageFingerprint } from "./attachments.mjs";
import { HistoryActionReconciler } from "./history-action-reconciliation.mjs";
import { AttachmentUploadReservations } from "./attachment-uploads.mjs";

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
  const config = readBridgeConfig();
  return runBridge(payload, {
    command: config.python,
    args: [fileURLToPath(new URL("../bin/desktop-bridge.py", import.meta.url))],
    timeoutMs: payload.operation === "send" || payload.operation === "set-model" ? 45000 : 16000,
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
    this.queueChecks = new Map();
    this.queueWakeups = new Set();
    this.queueEpoch = 0;
    this.stops = new ExecutionStops(store, payload => this.request({ ...payload, codexHome: this.codexHome }));
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS dispatches(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,text_hash TEXT NOT NULL,status TEXT NOT NULL,turn_id TEXT,code TEXT,created_at INTEGER NOT NULL)",
    );
    // A new client's delivery choice belongs to that submission. Old receipts
    // and queued messages keep their original wait-for-completion behavior.
    if (!store.db.prepare('PRAGMA table_info(dispatches)').all().some(column => column.name === 'auto_direct'))
      store.db.exec('ALTER TABLE dispatches ADD COLUMN auto_direct INTEGER NOT NULL DEFAULT 0');
    store.db.exec("CREATE TABLE IF NOT EXISTS outgoing_messages(id TEXT PRIMARY KEY REFERENCES dispatches(id),thread_id TEXT NOT NULL,text TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0)");
    store.db.exec("CREATE TABLE IF NOT EXISTS compactions(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,status TEXT NOT NULL,baseline_id TEXT,code TEXT,created_at INTEGER NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS request_responses(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,request_key TEXT NOT NULL,decision TEXT NOT NULL,status TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS question_answers(id TEXT PRIMARY KEY REFERENCES dispatches(id),thread_id TEXT NOT NULL,question_key TEXT NOT NULL)");
    this.attachments = new Attachments(store, attachmentOptions);
    this.uploadReservations = new AttachmentUploadReservations(store, this.attachments, action => this.transaction(action), (threadId, requestId) => {
      this.cache.delete(threadId);
      // Verification may finish while the queue is paused or the browser has
      // gone away. This only seals storage; the ordinary worker owns dispatch.
      void this.uploadReservations.finalize(threadId, requestId).then(() => {
        this.cache.delete(threadId);
        if (this.queueStarted) return this.processQueueForThread(threadId, true);
      }).catch(() => { /* The durable worker repeats verification after restart. */ });
    });
    this.models = new ThreadModels(store, payload => this.request({ ...payload, codexHome: this.codexHome }), {
      busy: id => this.isLifecycleBlocked(id) || this.sending.has(id) || this.queueReservations.has(id) ||
        this.compactionPending(id) || this.stops.pending(id) || this.renamePending?.(id),
      onChanged: id => { this.cache.delete(id); this.onModelChanged?.(id); },
    });
    this.historyActions = new HistoryActionReconciler(store);
  }
  isLifecycleBlocked(id) { return this.lifecycleBlocked?.(id) === true; }
  requireLifecycleOpen(id) {
    if (this.isLifecycleBlocked(id)) throw Object.assign(new AppError("此会话正在等待归档或核对管理操作，请先取消或完成该操作", 409), { dispatchCode: "lifecycle_pending" });
  }
  requireDispatchReady(id, { automatic = false, ownsSending = false } = {}) {
    this.requireLifecycleOpen(id);
    const unavailable = (message, code) => { throw Object.assign(new AppError(message, 409), { dispatchCode: code }); };
    const thread = this.store.thread(id);
    if (thread.archived || thread.missing) unavailable("请先恢复会话", "thread_not_ready");
    if (this.compactionPending(id)) unavailable("请先核对上下文压缩状态", "compaction_pending");
    if (this.models.pending(id)) unavailable("请先在会话信息中核对思考强度", "model_settings_pending");
    if (this.stops.pending(id) || automatic && this.stops.pause(id)) unavailable("待发消息已暂停，请先核对停止状态", "queue_paused");
    if (!ownsSending && this.sending.has(id)) unavailable("会话正在提交另一条消息", "dispatch_busy");
  }
  suspendConnection(id) {
    this.cache.delete(id);
    const entry = this.connections.get(id);
    if (entry?.state.status === "connecting") {
      entry.state.status = entry.reading ? "skipped" : "failed";
      entry.state.code = "lifecycle_pending";
      entry.controller.abort();
    }
  }
  connection(id) {
    this.store.thread(id);
    const entry = this.connections.get(id);
    return entry ? { ...entry.state } : { status: "idle" };
  }
  readingConnectionBlocked(id, data) {
    const thread = this.store.thread(id);
    return thread.archived || thread.missing || thread.sourceExcluded || thread.separator ||
      this.isLifecycleBlocked(id) || this.sending.has(id) || this.queueReservations.has(id) ||
      this.outbox(id).length > 0 || this.stops.pause(id) || this.stops.pending(id) ||
      this.compactionPending(id) || this.models.pending(id) || this.renamePending?.(id) ||
      !!this.store.db.prepare("SELECT 1 FROM dispatches WHERE thread_id=? AND status IN('pending','unknown') LIMIT 1").get(id) ||
      !!this.store.db.prepare("SELECT 1 FROM request_responses WHERE thread_id=? AND status IN('pending','accepted','unknown') LIMIT 1").get(id) ||
      !!data?.pendingRequests?.length || data?.compaction?.active ||
      data?.source === "desktop" && data.resumeState === "resumed" && data.canSend === false;
  }
  connect(id, { open = true, reading = false } = {}) {
    // Passive browsing must not make an old queued or uncertain request runnable.
    // This gate is checked again after every asynchronous read and before open.
    if (reading && this.readingConnectionBlocked(id)) return null;
    this.requireLifecycleOpen(id);
    const thread = this.store.thread(id);
    if (thread.archived || thread.missing) throw new AppError("请先恢复会话", 409);
    if (!this.openThread) throw new AppError("当前环境无法连接桌面会话", 503);
    const previous = this.connections.get(id);
    if (previous?.state.status === "connecting") {
      // A real input/submission takes over the existing operation rather than
      // being rejected by the passive queue guard or starting a duplicate open.
      if (!reading && previous.reading) {
        previous.reading = false;
        // The first passive lookup may still be waiting for an owner. A real
        // input/submission must open now, not after that read times out. Recovery
        // shares this promise; a late open failure cannot change a ready owner.
        void previous.openOnce?.().catch(() => {});
      }
      return { ...previous.state };
    }
    const now = Date.now();
    const entry = { state: { requestId: randomUUID(), status: "connecting", startedAt: now, checkedAt: now },
      controller: new AbortController(), reading };
    this.connections.delete(id);
    this.connections.set(id, entry);
    if (this.connections.size > 100) {
      const oldest = [...this.connections].find(([, value]) => value.state.status !== "connecting");
      if (oldest) this.connections.delete(oldest[0]);
    }
    this.cache.delete(id);
    // Passive visits read first; only this requested recovery may open the
    // desktop. Ordinary history and queue polling remain read-only.
    void this.recoverConnection(id, entry, reading ? false : open);
    return { ...entry.state };
  }
  async recoverConnection(id, entry, openImmediately) {
    const { signal } = entry.controller;
    const current = () => !signal.aborted && this.connections.get(id) === entry;
    const allowed = data => {
      if (!current()) return false;
      if (entry.reading && this.readingConnectionBlocked(id, data)) {
        Object.assign(entry.state, { status: "skipped", code: "reading_blocked", checkedAt: Date.now() });
        return false;
      }
      return true;
    };
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
    let opened = false, openPromise, lastCode = "connection_timeout";
    const openOnce = data => {
      if (!openPromise) {
        // Assign before invoking the opener, so recovery and takeover cannot
        // perform two native opens, including synchronous/reentrant callers.
        openPromise = Promise.resolve().then(async () => {
          if (!allowed(data) || entry.state.status !== "connecting") return false;
          if (Date.now() >= deadline) throw new Error("connection_timeout");
          await bounded(() => this.openThread(id));
          opened = true;
          return true;
        });
      }
      return openPromise;
    };
    entry.openOnce = openOnce;
    try {
      if (!allowed()) return;
      if (openImmediately && !await openOnce()) return;
      for (let attempt = 0; allowed() && Date.now() < deadline; attempt++) {
        const result = await bounded(() => this.request({ operation: "history", threadId: id,
          codexHome: this.codexHome, ownerLookupTimeoutMs: 10000 }));
        if (!allowed(result)) return;
        entry.state.checkedAt = Date.now();
        if (result.ok && result.source === "desktop" && result.resumeState === "resumed") {
          const data = { ...result, checkedAt: entry.state.checkedAt };
          this.cacheHistory(id, { at: Date.now(), promise: Promise.resolve(data), pending: false, runtime: data.runtime });
          entry.state.status = "connected";
          // An explicit connection/submission has made this owner ready. Do not
          // wait behind unrelated slow owners in the background queue scan.
          if (this.queueStarted && !entry.reading) void this.processQueueForThread(id, true).catch(() => {});
          return;
        }
        const incompatible = compatibilityFailure(result);
        lastCode = incompatible || result.connectionReason || result.code || "thread_not_resumed";
        if (incompatible) break;
        if (!opened) {
          if (!allowed(result)) return;
          if (!await openOnce(result)) return;
        }
        await bounded(() => new Promise(resolve => {
          // Keep the full initialization window without rapidly exhausting it.
          // Production reads are separated by 500 ms, 1 s, then at least 2 s.
          const delay = Math.min(2000, this.connectionPollMs * 2 ** Math.min(attempt, 8));
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        }));
      }
      if (current() && entry.state.status === "connecting") Object.assign(entry.state, { status: entry.reading ? "skipped" : "failed", code: lastCode, checkedAt: Date.now() });
    } catch (error) {
      if (current() && entry.state.status === "connecting") Object.assign(entry.state, { status: entry.reading ? "skipped" : "failed", code: error.message === "connection_timeout" ? lastCode : "desktop_unavailable", checkedAt: Date.now() });
    } finally {
      delete entry.openOnce;
    }
  }
  connectForSubmission(id) {
    if (this.isLifecycleBlocked(id)) return;
    const thread = this.store.thread(id);
    if (thread.archived || thread.missing) return;
    if (!this.openThread || this.sending.has(id) || this.stops.pause(id) || this.stops.pending(id) || this.compactionPending(id)) return;
    const head = this.outbox(id)[0];
    if (head?.status !== "queued") return;
    if (this.uploadReservations.blocked(head.id)) return;
    // Never reopen from an automatic queue tick or replay an uncertain send.
    this.connect(id, { open: false });
  }
  recoverableConnectionFailure(result) {
    return !!this.openThread && result.sent === false &&
      ["desktop_unavailable", "desktop_preflight_timeout"].includes(result.code);
  }
  cacheHistory(id, entry) {
    // Connection recovery and ordinary reads share one bounded snapshot cache.
    this.cache.delete(id);
    this.cache.set(id, entry);
    while (this.cache.size > 10) this.cache.delete(this.cache.keys().next().value);
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
    this.cacheHistory(id, entry);
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
      turnFailures: saved.turnFailures || [],
      [POCKET_CONTENT]: saved[POCKET_CONTENT],
      turnTiming: saved.turnTiming || null, checkedAt: Date.now() });
  }
  async loadHistory(id) {
    const actionObservation = this.historyActions.capture(id);
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
    this.historyActions.reconcile(actionObservation, data);
    for (const message of data.source === "desktop" ? data.messages || [] : []) {
      if (message.clientMessageId)
        this.store.db
          .prepare(
            "UPDATE dispatches SET status='accepted',turn_id=?,code=NULL WHERE id=? AND thread_id=? AND NOT EXISTS(SELECT 1 FROM attachment_upload_messages m WHERE m.request_id=dispatches.id AND m.status<>'ready')",
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
    const modelOperation = this.models.active(id);
    const blocked = this.compactionPending(id) || this.stops.pending(id) || !!modelOperation;
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
    return { ...this.attachments.enrich(id, data), ...(modelOperation ? { hint: "思考强度尚待核对，请打开会话信息。" } : {}), connection, outbox, pendingRequests, canCompact: executionAvailable && !!data.canCompact && !blocked && !this.sending.has(id),
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
    if (thread.archived || thread.missing || this.sending.has(id) || this.stops.pending(id) || this.compactionPending(id) || this.models.pending(id))
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
    const hasOption = input?.optionId !== undefined;
    if (!input || Object.keys(input).some(k => !["responseId", "decision", "answers", "optionId"].includes(k)) ||
        (hasAnswers ? input.decision !== undefined || hasOption || !Object.keys(input.answers).length || Object.keys(input.answers).length > 10 ||
          Object.values(input.answers).some(v => typeof v !== "string" || !v.trim() || v.length > 16000) || JSON.stringify(input.answers).length > 40000
          : hasOption ? typeof input.optionId !== "string" || !/^[a-f0-9]{64}$/.test(input.optionId) || input.decision !== undefined || input.answers !== undefined
          : !["accept", "cancel"].includes(input.decision) || input.answers !== undefined) || typeof input.responseId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.responseId) || !/^[a-f0-9]{64}$/.test(requestKey))
      throw new AppError("审批响应参数无效", 400);
    const recordedDecision = hasAnswers ? 'answers:' + createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(input.answers).sort(([a], [b]) => a.localeCompare(b))))).digest('hex')
      : hasOption ? 'option:' + input.optionId : input.decision;
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
    try { result = await this.request({ operation: "respond", threadId: id, codexHome: this.codexHome, requestKey,
      ...(hasOption ? { optionId: input.optionId } : hasAnswers ? { answers: input.answers } : { decision: input.decision }) }); }
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
    if (thread.archived || thread.missing || this.sending.has(id) || this.compactionPending(id) || this.stops.pending(id) || this.models.pending(id))
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
      // Preserve a terminal receipt already independently confirmed; pending
      // RPCs are not completed from an uncorrelated history postcondition.
      this.store.db.prepare("UPDATE compactions SET status=?,code=? WHERE id=? AND status='pending'")
        .run(status, result.code || null, input.requestId);
      const row = this.store.db.prepare("SELECT * FROM compactions WHERE id=?").get(input.requestId);
      return { requestId: row.id, status: row.status, code: row.code };
    } finally { this.sending.delete(id); this.cache.delete(id); }
  }
  receipt(row) {
    const progress = this.uploadReservations.progress(row.thread_id, row.id);
    const queued = progress && this.store.db.prepare("SELECT revision FROM outgoing_messages WHERE id=? AND thread_id=?").get(row.id, row.thread_id);
    return {
      requestId: row.id,
      status: row.status,
      turnId: row.turn_id,
      code: row.code,
      ...(progress || {}),
      ...(queued ? { queueRevision: queued.revision } : {}),
    };
  }
  getReceipt(id, requestId) {
    this.store.thread(id);
    const row = this.store.db
      .prepare("SELECT * FROM dispatches WHERE id=? AND thread_id=?")
      .get(requestId, id);
    return row ? this.receipt(row) : { requestId, status: "not_found" };
  }
  completeDispatch(id, requestId, result, fallbackStatus) {
    // A correlated native-history receipt outranks a late RPC response, including
    // its turn ID and diagnostic. Both direct and queued delivery settle here.
    const observed = this.getReceipt(id, requestId);
    const succeeded = result.ok === true;
    const accepted = observed.status === "accepted" || succeeded;
    const turnId = observed.status === "accepted" ? observed.turnId || (succeeded ? result.turnId : null) || null : result.turnId || observed.turnId || null;
    const status = accepted ? "accepted" : fallbackStatus;
    this.transaction(() => {
      this.store.db.prepare("UPDATE dispatches SET status=?,turn_id=?,code=? WHERE id=? AND thread_id=?")
        .run(status, turnId, accepted ? null : result.code || null, requestId, id);
      if (accepted) this.store.db.prepare("DELETE FROM outgoing_messages WHERE id=? AND thread_id=?").run(requestId, id);
    });
    this.cache.delete(id);
    const receipt = this.getReceipt(id, requestId);
    if (accepted) {
      try { this.onAccepted?.(id, receipt.turnId); }
      catch { /* Notification bookkeeping cannot invalidate a persisted receipt. */ }
    }
    return receipt;
  }
  outbox(id) {
    return this.store.db.prepare("SELECT o.id,o.text,o.revision,d.status,d.code,d.created_at AS createdAt,d.auto_direct AS autoDirect FROM outgoing_messages o JOIN dispatches d ON d.id=o.id WHERE o.thread_id=? ORDER BY d.created_at,d.rowid").all(id)
      .map(row => ({ ...row, autoDirect: row.autoDirect === 1, attachments: this.attachments.forDispatch(id, row.id).map(a => this.attachments.public(a)),
        ...(this.uploadReservations.progress(id, row.id) || {}) }));
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
      if (this.uploadReservations.blocked(requestId)) throw new AppError("附件尚未上传齐，请完成上传或取消此消息", 409);
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
      this.uploadReservations.cancel(requestId);
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
      this.store.db.prepare("UPDATE dispatches SET status=?,code=CASE WHEN EXISTS(SELECT 1 FROM attachment_upload_messages m WHERE m.request_id=dispatches.id AND m.status IN('uploading','failed')) THEN code ELSE NULL END WHERE id=?").run(resume ? "queued" : "editing", requestId);
      this.store.db.prepare("UPDATE outgoing_messages SET revision=revision+1 WHERE id=?").run(requestId);
    });
    return { outbox: this.outbox(id) };
  }
  async dispatchQueued(id, requestId, input, delivery = "now", resumeAfterTurnId = null) {
    const automatic = delivery !== "now";
    const queueEpoch = this.queueEpoch;
    this.requireDispatchReady(id, { automatic });
    if (!input || Object.keys(input).some(k => k !== "expectedRevision")) throw new AppError("发送参数无效", 400);
    this.queued(id, requestId, input.expectedRevision, automatic ? ["queued"] : ["queued", "rejected"]);
    // Missing uploads return immediately from finalize(). The lock covers only
    // actual verification/preflight, not the time a manifest waits for files.
    this.sending.add(id);
    let result, row, claimed = false, deferred = false, nativeStarted = false;
    try {
      if (this.uploadReservations.row(requestId) && !await this.uploadReservations.finalize(id, requestId)) throw new AppError("附件尚未上传齐，请完成上传或取消此消息", 409);
      this.requireDispatchReady(id, { automatic, ownsSending: true });
      if (automatic && queueEpoch !== this.queueEpoch) throw new AppError("待发消息已暂停，请稍后核对", 409);
      row = this.queued(id, requestId, input.expectedRevision, automatic ? ["queued"] : ["queued", "rejected"]);
      if (automatic && this.outbox(id)[0]?.id !== requestId) throw new AppError("待发顺序已变化，请重新核对", 409);
      if (delivery === "auto-now" && !row.autoDirect) throw new AppError("这条消息未开启自动直接发送", 409);
      const claim = this.store.db.prepare(`UPDATE dispatches SET status='pending',code=NULL WHERE id=? AND ${automatic ? "status='queued'" : "status IN('queued','rejected')"} AND EXISTS(SELECT 1 FROM outgoing_messages WHERE id=? AND revision=?)`)
        .run(requestId, requestId, input.expectedRevision);
      if (!claim.changes) throw new AppError("待发消息已变化，请刷新", 409);
      claimed = true;
      const saved = this.attachments.forDispatch(id, requestId);
      let attachments = [];
      if (saved.length) {
        try { attachments = await this.attachments.prepare(saved); }
        catch { result = { ok: false, code: "attachment_unavailable", sent: false }; }
      }
      if (!result && automatic && (queueEpoch !== this.queueEpoch || this.stops.pause(id) || this.stops.pending(id)))
        result = { ok: false, code: "queue_paused", sent: false };
      if (!result) this.requireDispatchReady(id, { automatic, ownsSending: true });
      if (!result) {
        nativeStarted = true;
        result = await this.request({ operation: "send", threadId: id, codexHome: this.codexHome,
          text: row.text, requestId, delivery, ...(attachments.length ? { attachments } : {}), ...(resumeAfterTurnId ? { resumeAfterTurnId } : {}) });
      }
    } catch (error) {
      if (!claimed) throw error;
      deferred = !nativeStarted && !!error.dispatchCode;
      result = { ok: false, code: deferred ? error.dispatchCode : "dispatch_unknown", sent: deferred ? false : null };
    }
    finally { this.sending.delete(id); }
    const recoverableConnection = this.recoverableConnectionFailure(result);
    const reconnect = delivery === "now" && recoverableConnection;
    const waitAgain = automatic && result.sent === false && (result.code === "queue_paused" ||
      row.autoDirect && (recoverableConnection || ["thread_not_ready", "thread_changed"].includes(result.code)));
    const status = deferred || result.code === "thread_active" && result.sent === false ? "queued"
      : reconnect || waitAgain ? "queued"
      : result.sent === false ? "rejected" : "unknown";
    const receipt = this.completeDispatch(id, requestId, result, status);
    if (receipt.status === "queued" && reconnect) this.connectForSubmission(id);
    return receipt;
  }
  async processQueue() {
    const epoch = this.queueEpoch;
    const ids = this.store.db.prepare("SELECT DISTINCT thread_id FROM outgoing_messages").all().map(r => r.thread_id);
    for (const id of ids) {
      if (epoch !== this.queueEpoch) return;
      await this.processQueueForThread(id);
    }
  }
  processQueueForThread(id, wake = false) {
    const current = this.queueChecks.get(id);
    if (current) {
      if (wake) this.queueWakeups.add(id);
      return current;
    }
    const epoch = this.queueEpoch;
    const pending = this.checkQueueForThread(id, epoch).finally(() => {
      if (this.queueChecks.get(id) !== pending) return;
      this.queueChecks.delete(id);
      // A connection may become ready while an older read is still in flight.
      // Coalesce those notifications into one fresh check instead of losing it.
      if (this.queueWakeups.delete(id) && this.queueStarted && epoch === this.queueEpoch)
        return this.processQueueForThread(id);
    });
    this.queueChecks.set(id, pending);
    return pending;
  }
  async checkQueueForThread(id, epoch) {
    if (epoch !== this.queueEpoch) return;
    if (this.isLifecycleBlocked(id)) return;
    const thread = this.store.thread(id);
    if (thread.archived || thread.missing || this.sending.has(id)) return;
    const initial = this.outbox(id)[0];
    if (!initial || !["queued", "editing"].includes(initial.status)) return;
    if (this.uploadReservations.row(initial.id) && !await this.uploadReservations.finalize(id, initial.id)) return;
    if (epoch !== this.queueEpoch || this.stops.pause(id) || this.stops.pending(id)) return;
    if (this.models.pending(id)) {
      await this.models.read(id);
      if (epoch !== this.queueEpoch || this.models.pending(id)) return;
    }
    const head = this.outbox(id)[0];
    if (!head || head.id !== initial.id || head.status !== "queued" || this.uploadReservations.blocked(head.id)) return;
    const history = await this.history(id);
    if (epoch !== this.queueEpoch) return;
    const stopped = this.stops.latest(id);
    const explicitlyResumed = !this.stops.pause(id) && stopped?.status === "stopped" &&
      stopped.targetTurnId === history.latestTurnId && history.runtime === "idle" && history.canSend;
    const autoDirect = head.autoDirect && history.source === "desktop" && history.runtime === "active" && history.canSend;
    if (!history.queueReady && !explicitlyResumed && !autoDirect) return;
    try { await this.dispatchQueued(id, head.id, { expectedRevision: head.revision }, explicitlyResumed ? "resume" : autoDirect ? "auto-now" : "auto", explicitlyResumed ? stopped.targetTurnId : null); }
    catch { /* A concurrent edit/cancel is resolved by the next read. */ }
  }
  startQueue() {
    if (this.queueStarted) return;
    this.queueStarted = true;
    this.stops.recover();
    this.store.db.exec("UPDATE dispatches SET status='unknown',code='submission_interrupted' WHERE status='pending'");
    this.store.db.exec("UPDATE compactions SET status='unknown',code='submission_interrupted' WHERE status='pending'");
    this.store.db.exec("UPDATE request_responses SET status='unknown',code='submission_interrupted' WHERE status='pending'");
    const epoch = this.queueEpoch;
    const tick = async () => {
      if (!this.queueStarted || epoch !== this.queueEpoch) return;
      try { await this.processQueue(); } catch { /* Retry reads; never replay unknown submissions. */ }
      if (this.queueStarted && epoch === this.queueEpoch) { this.queueTimer = setTimeout(tick, 2000); this.queueTimer.unref?.(); }
    };
    this.queueTimer = setTimeout(tick, 100); this.queueTimer.unref?.();
  }
  stopQueue() {
    this.queueEpoch++;
    this.queueWakeups.clear();
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
      Object.keys(input).some((k) => !["text", "requestId", "enqueue", "attachments", "attachmentUploads", "autoDirect"].includes(k)) ||
      (input.attachments !== undefined && input.attachmentUploads !== undefined) ||
      (input.enqueue !== undefined && input.enqueue !== true) ||
      (input.autoDirect !== undefined && typeof input.autoDirect !== "boolean") ||
      typeof input.text !== "string" ||
      (!input.text.trim() && !input.attachments?.length && !input.attachmentUploads?.length) ||
      input.text.length > 16000 ||
      typeof input.requestId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        input.requestId,
      )
    )
      throw new AppError("消息需为 1–16000 字，且带有效请求编号", 400);
    if (input.attachmentUploads !== undefined) return this.reserveAttachmentUploads(id, input);
    if (this.uploadReservations.row(input.requestId)) throw new AppError("请求编号已用于另一条消息", 409);
    const text = input.text.trim(),
      uploaded = this.attachments.resolve(id, input.attachments === undefined ? [] : input.attachments, input.requestId),
      hash = messageFingerprint(text, uploaded);
    const old = this.store.db
      .prepare("SELECT * FROM dispatches WHERE id=?")
      .get(input.requestId);
    if (old) {
      if (old.thread_id !== id || old.text_hash !== hash || old.auto_direct !== Number(input.autoDirect === true))
        throw new AppError("请求编号已用于另一条消息", 409);
      return this.receipt(old);
    }
    if ((this.sending.has(id) || this.compactionPending(id) || this.stops.pending(id) || this.models.pending(id)) && !input.enqueue && !this.outbox(id).length)
      throw new AppError("这条任务正在提交消息，请稍后再试", 409);
    if (this.queueSize(id) >= 20) throw new AppError("这条任务最多保留 20 条待发消息", 409);
    const queueInitially = input.enqueue || this.outbox(id).length > 0 || (input.autoDirect === true && this.stops.pause(id));
    this.transaction(() => {
      this.store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,created_at,auto_direct) VALUES(?,?,?,'pending',?,?)")
        .run(input.requestId, id, hash, Date.now(), Number(input.autoDirect === true));
      this.attachments.bind(id, input.requestId, text, uploaded);
      if (uploaded.length)
        this.store.db.prepare("INSERT INTO outgoing_messages(id,thread_id,text) VALUES(?,?,?)").run(input.requestId, id, text);
    });
    if (queueInitially) {
      this.queue(id, input.requestId, text);
      this.connectForSubmission(id);
      return this.getReceipt(id, input.requestId);
    }
    let result, deferred = false, nativeStarted = false;
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
      if (!result && input.autoDirect === true && (this.stops.pause(id) || this.stops.pending(id)))
        result = { ok: false, code: "queue_paused", sent: false };
      if (!result) this.requireDispatchReady(id, { automatic: input.autoDirect === true, ownsSending: true });
      if (!result) {
        nativeStarted = true;
        result = await this.request({
          operation: "send",
          threadId: id,
          codexHome: this.codexHome,
          text,
          requestId: input.requestId,
          ...(input.autoDirect === true ? { delivery: "now" } : {}),
          ...(attachments.length ? { attachments } : {}),
        });
      }
    } catch (error) {
      deferred = !nativeStarted && !!error.dispatchCode;
      result = { ok: false, code: deferred ? error.dispatchCode : "dispatch_unknown", sent: deferred ? false : null };
    } finally {
      this.sending.delete(id);
      this.queueReservations.delete(id);
    }
    const observed = this.getReceipt(id, input.requestId);
    if (observed.status !== "accepted" && (deferred || result.sent === false &&
        (result.code === "thread_active" || input.autoDirect === true &&
          ["queue_paused", "thread_not_ready", "thread_changed"].includes(result.code)))) {
      this.queue(id, input.requestId, text);
      return this.completeDispatch(id, input.requestId, deferred ? result : { ...result, code: null }, "queued");
    }
    if (observed.status !== "accepted" && this.recoverableConnectionFailure(result)) {
      this.queue(id, input.requestId, text);
      this.connectForSubmission(id);
      return this.completeDispatch(id, input.requestId, { ...result, code: null }, "queued");
    }
    const status = result.sent === false
        ? "rejected"
        : "unknown";
    return this.completeDispatch(id, input.requestId, result, status);
  }
  reserveAttachmentUploads(id, input) {
    const text = input.text.trim(), descriptors = this.uploadReservations.validate(input.attachmentUploads);
    const old = this.store.db.prepare("SELECT * FROM dispatches WHERE id=?").get(input.requestId);
    const intent = this.uploadReservations.intent(text, descriptors, input);
    if (old) {
      const manifest = this.uploadReservations.row(input.requestId);
      if (old.thread_id !== id || !manifest || manifest.intent_hash !== intent)
        throw new AppError("请求编号已用于另一条消息", 409);
      return this.receipt(old);
    }
    if (this.queueSize(id) >= 20) throw new AppError("这条任务最多保留 20 条待发消息", 409);
    this.transaction(() => {
      this.store.db.prepare("INSERT INTO dispatches(id,thread_id,text_hash,status,code,created_at,auto_direct) VALUES(?,?,?,'queued','attachments_uploading',?,?)")
        .run(input.requestId, id, intent, Date.now(), Number(input.autoDirect === true));
      this.store.db.prepare("INSERT INTO outgoing_messages(id,thread_id,text) VALUES(?,?,?)").run(input.requestId, id, text);
      this.uploadReservations.reserve(id, input.requestId, text, descriptors, input);
    });
    this.cache.delete(id);
    const receipt = this.getReceipt(id, input.requestId);
    if (this.queueStarted) void this.processQueueForThread(id, true).catch(() => {});
    return receipt;
  }
}

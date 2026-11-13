// @ts-check
import { AppError } from "./store.mjs";

/** @typedef {import('../shared/submission-contracts.ts').RecordedStopReceipt} RecordedStopReceipt */
/** @typedef {import('../shared/submission-contracts.ts').StopReceipt} StopReceipt */
/** @typedef {Pick<import('./store.mjs').NavigatorStore, 'db' | 'thread'>} StopStore */
/** @typedef {(payload: {operation: 'stop', threadId: string, expectedTurnId: string}) => Promise<{ok: boolean, sent?: boolean | null, code?: string | null}>} StopRequest */

/** @type {Set<import('../shared/submission-contracts.ts').StopStatus | undefined>} */
const unresolved = new Set(["pending", "accepted", "unknown"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @returns {value is import('../shared/submission-contracts.ts').StopInput} */
const validStopInput = value => record(value) && !Object.keys(value).some(k => !["requestId", "expectedTurnId"].includes(k)) &&
  typeof value.requestId === "string" && uuid.test(value.requestId) && typeof value.expectedTurnId === "string" && uuid.test(value.expectedTurnId);
/** @param {unknown} value @returns {value is import('../shared/submission-contracts.ts').ResumeQueueInput} */
const validResumeInput = value => record(value) && !Object.keys(value).some(k => k !== "expectedStopId") &&
  typeof value.expectedStopId === "string" && uuid.test(value.expectedStopId);

export class ExecutionStops {
  /** @param {StopStore} store @param {StopRequest} request */
  constructor(store, request) {
    this.store = store;
    this.request = request;
    store.db.exec("CREATE TABLE IF NOT EXISTS execution_stops(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,target_turn_id TEXT NOT NULL,status TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS queue_pauses(thread_id TEXT PRIMARY KEY,stop_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  }
  /** @param {string} id @returns {RecordedStopReceipt | null} */
  latest(id) {
    // Rows belong to Pocket's own schema and writes, not external bridge JSON.
    return /** @type {RecordedStopReceipt | undefined} */ (this.store.db.prepare("SELECT id AS requestId,target_turn_id AS targetTurnId,status,code FROM execution_stops WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id)) || null;
  }
  /** @param {string} id */
  pending(id) { return unresolved.has(this.latest(id)?.status); }
  /** @param {string} id @returns {{stopId: string} | null} */
  pause(id) { return /** @type {{stopId: string} | undefined} */ (this.store.db.prepare("SELECT stop_id AS stopId FROM queue_pauses WHERE thread_id=?").get(id)) || null; }
  /** @param {string} id @param {string} requestId @returns {StopReceipt} */
  receipt(id, requestId) {
    this.store.thread(id);
    return /** @type {RecordedStopReceipt | undefined} */ (this.store.db.prepare("SELECT id AS requestId,target_turn_id AS targetTurnId,status,code FROM execution_stops WHERE thread_id=? AND id=?").get(id, requestId)) || { requestId, status: "not_found" };
  }
  /** @param {string} id @param {{source?: string, recentTurns?: {id: string, status: string}[]}} data */
  reconcile(id, data) {
    if (data.source !== "desktop" || !Array.isArray(data.recentTurns)) return;
    const rows = this.store.db.prepare("SELECT id,target_turn_id FROM execution_stops WHERE thread_id=? AND status IN('pending','accepted','unknown')").all(id);
    for (const row of rows) {
      const turn = data.recentTurns.find(t => t.id === row.target_turn_id);
      const status = turn?.status === "interrupted" ? "stopped" : ["completed", "failed"].includes(turn?.status ?? "") ? "ended" : null;
      if (status) this.store.db.prepare("UPDATE execution_stops SET status=?,code=NULL WHERE id=?").run(status, row.id);
    }
  }
  recover() { this.store.db.exec("UPDATE execution_stops SET status='unknown',code='submission_interrupted' WHERE status='pending'"); }
  /** @param {string} id @param {unknown} input @returns {Promise<StopReceipt>} */
  async stop(id, input) {
    const thread = this.store.thread(id);
    if (!validStopInput(input))
      throw new AppError("停止请求需带有效的请求编号和当前执行编号", 400);
    const old = this.store.db.prepare("SELECT * FROM execution_stops WHERE id=?").get(input.requestId);
    if (old) {
      if (old.thread_id !== id || old.target_turn_id !== input.expectedTurnId) throw new AppError("停止请求编号已用于其他执行", 409);
      return this.receipt(id, input.requestId);
    }
    if (thread.archived || thread.missing) throw new AppError("请先恢复会话", 409);
    if (this.pending(id)) throw new AppError("已有停止请求，请先核对状态", 409);
    // Pause before the RPC, including timeouts and stale-target outcomes.
    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      this.store.db.prepare("INSERT INTO execution_stops VALUES(?,?,?,'pending',NULL,?)").run(input.requestId, id, input.expectedTurnId, Date.now());
      this.store.db.prepare("INSERT INTO queue_pauses VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET stop_id=excluded.stop_id,created_at=excluded.created_at").run(id, input.requestId, Date.now());
      this.store.db.exec("COMMIT");
    } catch (error) { this.store.db.exec("ROLLBACK"); throw error; }
    let result;
    try { result = await this.request({ operation: "stop", threadId: id, expectedTurnId: input.expectedTurnId }); }
    catch { result = { ok: false, sent: null, code: "dispatch_unknown" }; }
    const status = result.ok ? "accepted" : result.sent === false ? "rejected" : "unknown";
    this.store.db.prepare("UPDATE execution_stops SET status=?,code=? WHERE id=? AND status='pending'")
      .run(status, result.code || null, input.requestId);
    return this.receipt(id, input.requestId);
  }
  /** @param {string} id @param {unknown} input */
  resume(id, input) {
    const thread = this.store.thread(id);
    if (!validResumeInput(input))
      throw new AppError("恢复排队参数无效", 400);
    if (thread.archived || thread.missing || this.pending(id)) throw new AppError("请先核对会话和停止状态", 409);
    const paused = this.pause(id);
    if (!paused) return;
    if (paused.stopId !== input.expectedStopId) throw new AppError("任务又收到了一次停止请求，请刷新后确认", 409);
    this.store.db.prepare("DELETE FROM queue_pauses WHERE thread_id=? AND stop_id=?").run(id, input.expectedStopId);
  }
}

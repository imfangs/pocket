import { AppError } from "./store.mjs";

const unresolved = new Set(["pending", "accepted", "unknown"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class ExecutionStops {
  constructor(store, request) {
    this.store = store;
    this.request = request;
    store.db.exec("CREATE TABLE IF NOT EXISTS execution_stops(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,target_turn_id TEXT NOT NULL,status TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL)");
    store.db.exec("CREATE TABLE IF NOT EXISTS queue_pauses(thread_id TEXT PRIMARY KEY,stop_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  }
  latest(id) {
    return this.store.db.prepare("SELECT id AS requestId,target_turn_id AS targetTurnId,status,code FROM execution_stops WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id) || null;
  }
  pending(id) { return unresolved.has(this.latest(id)?.status); }
  pause(id) { return this.store.db.prepare("SELECT stop_id AS stopId FROM queue_pauses WHERE thread_id=?").get(id) || null; }
  receipt(id, requestId) {
    this.store.thread(id);
    return this.store.db.prepare("SELECT id AS requestId,target_turn_id AS targetTurnId,status,code FROM execution_stops WHERE thread_id=? AND id=?").get(id, requestId) || { requestId, status: "not_found" };
  }
  reconcile(id, data) {
    if (data.source !== "desktop" || !Array.isArray(data.recentTurns)) return;
    const rows = this.store.db.prepare("SELECT id,target_turn_id FROM execution_stops WHERE thread_id=? AND status IN('pending','accepted','unknown')").all(id);
    for (const row of rows) {
      const turn = data.recentTurns.find(t => t.id === row.target_turn_id);
      const status = turn?.status === "interrupted" ? "stopped" : ["completed", "failed"].includes(turn?.status) ? "ended" : null;
      if (status) this.store.db.prepare("UPDATE execution_stops SET status=?,code=NULL WHERE id=?").run(status, row.id);
    }
  }
  recover() { this.store.db.exec("UPDATE execution_stops SET status='unknown',code='submission_interrupted' WHERE status='pending'"); }
  async stop(id, input) {
    const thread = this.store.thread(id);
    if (!input || Object.keys(input).some(k => !["requestId", "expectedTurnId"].includes(k)) ||
        typeof input.requestId !== "string" || !uuid.test(input.requestId) ||
        typeof input.expectedTurnId !== "string" || !uuid.test(input.expectedTurnId))
      throw new AppError("停止请求需带有效的请求编号和当前执行编号", 400);
    const old = this.store.db.prepare("SELECT * FROM execution_stops WHERE id=?").get(input.requestId);
    if (old) {
      if (old.thread_id !== id || old.target_turn_id !== input.expectedTurnId) throw new AppError("停止请求编号已用于其他执行", 409);
      return this.receipt(id, input.requestId);
    }
    if (thread.archived || thread.missing) throw new AppError("请先恢复原任务", 409);
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
  resume(id, input) {
    const thread = this.store.thread(id);
    if (!input || Object.keys(input).some(k => k !== "expectedStopId") || typeof input.expectedStopId !== "string" || !uuid.test(input.expectedStopId))
      throw new AppError("恢复排队参数无效", 400);
    if (thread.archived || thread.missing || this.pending(id)) throw new AppError("请先核对原任务和停止状态", 409);
    const paused = this.pause(id);
    if (!paused) return;
    if (paused.stopId !== input.expectedStopId) throw new AppError("任务又收到了一次停止请求，请刷新后确认", 409);
    this.store.db.prepare("DELETE FROM queue_pauses WHERE thread_id=? AND stop_id=?").run(id, input.expectedStopId);
  }
}

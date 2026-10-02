import { createHash } from "node:crypto";
import { AppError } from "./store.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export class ThreadModels {
  constructor(store, request, busy) {
    Object.assign(this, { store, request, busy });
    store.db.exec("CREATE TABLE IF NOT EXISTS model_changes(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,input_hash TEXT NOT NULL,model TEXT NOT NULL,effort TEXT NOT NULL,provider TEXT,expected_revision TEXT NOT NULL,status TEXT NOT NULL,code TEXT,created_at INTEGER NOT NULL)");
  }
  latest(id) {
    return this.store.db.prepare("SELECT id AS requestId,model,effort,provider,status,code FROM model_changes WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id) || null;
  }
  pending(id) {
    return !!this.store.db.prepare("SELECT 1 FROM model_changes WHERE thread_id=? AND status IN('pending','accepted','unknown') LIMIT 1").get(id);
  }
  receipt(id, requestId) {
    this.store.thread(id);
    return this.store.db.prepare("SELECT id AS requestId,model,effort,provider,status,code FROM model_changes WHERE thread_id=? AND id=?").get(id, requestId) || { requestId, status: "not_found" };
  }
  recover() {
    this.store.db.exec("UPDATE model_changes SET status='unknown',code='submission_interrupted' WHERE status='pending'");
  }
  reconcile(id, state) {
    if (state?.source !== "desktop" || !state.current?.model || !state.current.provider) return;
    // This confirms observed settings, not which client caused the change.
    this.store.db.prepare("UPDATE model_changes SET status='confirmed',code=NULL WHERE thread_id=? AND provider=? AND model=? AND effort=? AND status IN('pending','accepted','unknown')")
      .run(id, state.current.provider, state.current.model, state.current.effort ?? null);
  }
  async read(id) {
    const thread = this.store.thread(id);
    let state;
    try { state = await this.request({ operation: "model", threadId: id }); }
    catch { state = { ok: false, code: "desktop_unavailable" }; }
    if (!state.ok || state.source !== "desktop") return {
      source: "unavailable", current: null, revision: null, models: [], catalogSource: "configured",
      canChange: false, reason: state.code || "desktop_unavailable", request: this.latest(id), checkedAt: Date.now(),
    };
    this.reconcile(id, state);
    const blocked = thread.archived || thread.missing || this.pending(id) || this.busy(id);
    return { source: "desktop", current: state.current, revision: state.revision, models: state.models || [],
      catalogSource: "configured", canChange: !!state.canChange && !blocked,
      reason: blocked ? "model_change_blocked" : state.reason || null, request: this.latest(id), checkedAt: Date.now() };
  }
  async checkReceipt(id, requestId) {
    const receipt = this.receipt(id, requestId);
    if (["pending", "accepted", "unknown"].includes(receipt.status)) await this.read(id);
    return this.receipt(id, requestId);
  }
  async set(id, input) {
    const thread = this.store.thread(id);
    if (!input || Object.keys(input).some(k => !["requestId", "model", "effort", "expectedRevision"].includes(k)) ||
        typeof input.requestId !== "string" || !uuid.test(input.requestId) ||
        typeof input.model !== "string" || !modelId.test(input.model) || !efforts.has(input.effort) ||
        typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision))
      throw new AppError("请选择模型，并带有效请求编号和当前设置版本", 400);
    const hash = createHash("sha256").update(JSON.stringify([id, input.model, input.effort, input.expectedRevision])).digest("hex");
    const old = this.store.db.prepare("SELECT input_hash FROM model_changes WHERE id=?").get(input.requestId);
    if (old) {
      if (old.input_hash !== hash) throw new AppError("请求编号已用于另一项模型设置", 409);
      return this.receipt(id, input.requestId);
    }
    if (thread.archived || thread.missing || this.pending(id) || this.busy(id))
      throw new AppError("请等当前操作完成并核对模型设置", 409);
    // Claim before the first await so Pocket sends/queue dispatch cannot race it.
    this.store.db.prepare("INSERT INTO model_changes VALUES(?,?,?,?,?,NULL,?,'pending',NULL,?)")
      .run(input.requestId, id, hash, input.model, input.effort, input.expectedRevision, Date.now());
    let result, dispatched = false;
    try {
      const state = await this.request({ operation: "model", threadId: id });
      const model = state.models?.find(m => m.id === input.model);
      if (!state.ok || state.source !== "desktop") result = { sent: false, code: state.code || "desktop_unavailable" };
      else if (state.revision !== input.expectedRevision) result = { sent: false, code: "model_state_changed" };
      else if (!state.canChange || this.busy(id) || this.store.thread(id).archived || this.store.thread(id).missing)
        result = { sent: false, code: state.reason || "thread_not_ready" };
      else if (!model?.supportedEfforts.includes(input.effort)) result = { sent: false, code: "model_not_configured" };
      else {
        this.store.db.prepare("UPDATE model_changes SET provider=? WHERE id=?").run(state.current.provider, input.requestId);
        if (state.current.model === input.model && state.current.effort === input.effort) {
          this.reconcile(id, state);
          return this.receipt(id, input.requestId);
        }
        dispatched = true;
        result = await this.request({ operation: "set-model", threadId: id, model: input.model,
          effort: input.effort, expectedRevision: input.expectedRevision });
      }
    } catch { result = { sent: dispatched ? null : false, code: dispatched ? "dispatch_unknown" : "desktop_unavailable" }; }
    this.store.db.prepare("UPDATE model_changes SET status=?,code=? WHERE id=? AND status='pending'")
      .run(result.ok ? "accepted" : result.sent === false ? "rejected" : "unknown", result.code || null, input.requestId);
    if (dispatched) await this.read(id); // Read only, including after an unknown result.
    return this.receipt(id, input.requestId);
  }
}

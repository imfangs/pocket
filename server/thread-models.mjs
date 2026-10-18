import { createHash } from "node:crypto";
import { AppError } from "./store.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const revision = /^[a-f0-9]{64}$/;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const unresolved = row => row && ["pending", "unknown"].includes(row.status);
const safeCode = code => typeof code === "string" && /^[a-z0-9_]{1,100}$/.test(code) ? code : "model_settings_unavailable";
const publicCurrent = current => current ? { model: current.model ?? null, effort: current.effort ?? null } : null;

function identity(id) {
  if (typeof id !== "string" || !uuid.test(id)) throw new AppError("会话或请求编号无效", 400);
}
function parseInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["requestId", "model", "effort", "expectedRevision"].includes(key)) ||
      typeof input.model !== "string" || !modelId.test(input.model) || !efforts.has(input.effort) ||
      typeof input.expectedRevision !== "string" || !revision.test(input.expectedRevision))
    throw new AppError("请重新读取模型设置，再选择思考强度", 400);
  identity(input.requestId);
  return { model: input.model, effort: input.effort, expectedRevision: input.expectedRevision };
}

// Receipts belong to Pocket; settings always belong to the original desktop.
// The old withdrawn model_changes table is deliberately neither read nor replayed.
export class ThreadModels {
  constructor(store, request, { busy = () => false, onChanged = () => {} } = {}) {
    Object.assign(this, { store, request, busy, onChanged });
    this.running = new Map();
    this.reads = new Map();
    this.stopped = false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS model_setting_operations(
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, input_hash TEXT NOT NULL,
      payload TEXT NOT NULL, provider TEXT, status TEXT NOT NULL, code TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS model_setting_unresolved_thread
        ON model_setting_operations(thread_id) WHERE status IN ('pending','unknown');`);
    // provider is persisted before entering the sole native write call. A NULL
    // provider proves the previous process stopped in read-only preflight.
    store.db.prepare(`UPDATE model_setting_operations SET
      status=CASE WHEN provider IS NULL THEN 'rejected' ELSE 'unknown' END,
      code=CASE WHEN provider IS NULL THEN 'settings_not_submitted' ELSE 'settings_interrupted' END,
      updated_at=? WHERE status='pending' OR (status='unknown' AND provider IS NULL)`).run(Date.now());
  }
  active(id) {
    return this.store.db.prepare("SELECT * FROM model_setting_operations WHERE thread_id=? AND status IN ('pending','unknown')").get(id);
  }
  pending(id) { return !!this.active(id); }
  row(id, requestId) {
    identity(id); identity(requestId); this.store.thread(id);
    const row = this.store.db.prepare("SELECT * FROM model_setting_operations WHERE id=?").get(requestId);
    if (!row || row.thread_id !== id) throw new AppError("暂未找到这次设置记录，请稍后核对", 404);
    return row;
  }
  receipt(row) {
    const { model, effort } = JSON.parse(row.payload);
    return { requestId: row.id, threadId: row.thread_id, model, effort, status: row.status,
      ...(row.code ? { code: row.code } : {}), updatedAt: row.updated_at };
  }
  update(row, status, code) {
    if (this.stopped) return;
    this.store.db.prepare("UPDATE model_setting_operations SET status=?,code=?,updated_at=? WHERE id=? AND status IN ('pending','unknown')")
      .run(status, code ? safeCode(code) : null, Date.now(), row.id);
  }
  validState(id, state) {
    return state?.ok === true && state.threadId === id && state.source === "desktop" &&
      typeof state.revision === "string" && revision.test(state.revision) &&
      typeof state.current?.model === "string" && modelId.test(state.current.model) &&
      (state.current.effort === null || efforts.has(state.current.effort)) &&
      typeof state.current.provider === "string" && modelId.test(state.current.provider);
  }
  choices(state) {
    // Only the current model's native catalog entry is usable. A catalog is not
    // evidence that this host's gateway can translate history between models.
    if (!Array.isArray(state.models)) return [];
    const model = state.models.find(model => model?.id === state.current.model);
    if (!model || typeof model.name !== "string" || !model.name.trim() || model.name.length > 120 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(model.name) ||
        !Array.isArray(model.supportedEfforts) || !model.supportedEfforts.length || model.supportedEfforts.length > efforts.size ||
        model.supportedEfforts.some(effort => !efforts.has(effort)) || !model.supportedEfforts.includes(model.defaultEffort)) return [];
    return [{ id: model.id, name: model.name, supportedEfforts: [...new Set(model.supportedEfforts)], defaultEffort: model.defaultEffort }];
  }
  readCurrent(id) {
    if (this.reads.has(id)) return this.reads.get(id);
    const promise = Promise.resolve().then(() => this.request({ operation: "model", threadId: id }))
      .catch(() => ({ ok: false, code: "desktop_unavailable" }))
      .finally(() => { if (this.reads.get(id) === promise) this.reads.delete(id); });
    this.reads.set(id, promise);
    return promise;
  }
  reconcile(row, state) {
    if (this.stopped || !unresolved(row) || this.running.has(row.id) || !this.validState(row.thread_id, state)) return;
    const payload = JSON.parse(row.payload);
    if (row.provider && state.current.provider === row.provider && state.current.model === payload.model && state.current.effort === payload.effort) {
      this.update(row, "succeeded");
      this.onChanged(row.thread_id);
    }
    // An unchanged or different value cannot prove that an uncertain request
    // will never arrive. Keep its identity and never retry a write from a GET.
  }
  fallback(thread, reason, operation) {
    return { threadId: thread.id, source: thread.savedModelSettings ? "saved" : "unavailable",
      current: publicCurrent(thread.savedModelSettings), revision: null, models: [], canChange: false,
      canChangeModel: false, reason, ...(operation ? { operation } : {}), checkedAt: Date.now() };
  }
  async read(id) {
    identity(id);
    let thread = this.store.thread(id), row = this.active(id);
    if (thread.missing || thread.archived || this.busy(id)) return this.fallback(thread,
      thread.missing ? "thread_missing" : thread.archived ? "thread_archived" : "operation_in_progress", row ? this.receipt(row) : undefined);
    const state = await this.readCurrent(id);
    if (this.stopped) return this.fallback(thread, "desktop_unavailable");
    thread = this.store.thread(id);
    if (row) { this.reconcile(row, state); row = this.row(id, row.id); }
    const operation = row ? this.receipt(row) : undefined;
    if (!this.validState(id, state)) return this.fallback(thread, state?.ok ? "model_state_changed" : safeCode(state?.code), operation);
    const models = this.choices(state);
    const blocked = thread.archived || thread.missing || this.busy(id) || this.pending(id);
    return { threadId: id, source: "desktop", current: publicCurrent(state.current), revision: state.revision,
      models, canChange: state.canChange === true && !blocked && models.length === 1, canChangeModel: false,
      reason: blocked ? "operation_in_progress" : models.length ? state.reason ?? null : "model_catalog_unavailable",
      ...(operation ? { operation } : {}), checkedAt: Date.now() };
  }
  start(id, input) {
    identity(id);
    const payload = parseInput(input), thread = this.store.thread(id);
    const hash = createHash("sha256").update(JSON.stringify([id, payload])).digest("hex");
    const existing = this.store.db.prepare("SELECT * FROM model_setting_operations WHERE id=?").get(input.requestId);
    if (existing) {
      if (existing.thread_id !== id || existing.input_hash !== hash) throw new AppError("请求编号已用于另一项设置", 409);
      return this.receipt(existing);
    }
    if (thread.archived || thread.missing || this.pending(id) || this.busy(id))
      throw new AppError("请先处理此会话未完成的操作，再修改思考强度", 409);
    const now = Date.now();
    this.store.db.prepare("INSERT INTO model_setting_operations VALUES(?,?,?,?,NULL,'pending',NULL,?,?)")
      .run(input.requestId, id, hash, JSON.stringify(payload), now, now);
    const row = this.row(id, input.requestId);
    const promise = Promise.resolve().then(() => this.run(row)).finally(() => this.running.delete(row.id));
    this.running.set(row.id, promise);
    return this.receipt(row);
  }
  async run(row) {
    const payload = JSON.parse(row.payload);
    try {
      const state = await this.readCurrent(row.thread_id);
      if (this.stopped) return;
      if (!this.validState(row.thread_id, state)) { this.update(row, "rejected", state?.ok ? "model_state_changed" : safeCode(state?.code)); return; }
      if (payload.expectedRevision !== state.revision) { this.update(row, "changed", "model_state_changed"); return; }
      const thread = this.store.thread(row.thread_id);
      if (thread.archived || thread.missing || this.busy(row.thread_id) || !state.canChange) { this.update(row, "rejected", state.reason || "thread_not_ready"); return; }
      if (payload.model !== state.current.model || !this.choices(state)[0]?.supportedEfforts.includes(payload.effort)) {
        this.update(row, "rejected", "model_not_supported"); return;
      }
      this.store.db.prepare("UPDATE model_setting_operations SET provider=? WHERE id=?").run(state.current.provider, row.id);
      if (payload.effort === state.current.effort) { this.update(row, "succeeded"); return; }
      let result;
      try { result = await this.request({ operation: "set-model", threadId: row.thread_id, requestId: row.id, ...payload }); }
      catch { result = { ok: false, code: "dispatch_unknown", sent: null }; }
      if (this.stopped) return;
      if (result?.ok === true && result.verified === true && this.validState(row.thread_id, result) &&
          result.current.provider === state.current.provider && result.current.model === payload.model && result.current.effort === payload.effort) {
        this.update(row, "succeeded"); this.onChanged(row.thread_id);
      } else if (result?.sent === false) this.update(row, result.code === "model_state_changed" ? "changed" : "rejected", result.code);
      else this.update(row, "unknown", "settings_outcome_unknown");
    } catch {
      if (!this.stopped) {
        const possibleWrite = this.row(row.thread_id, row.id).provider !== null;
        this.update(row, possibleWrite ? "unknown" : "rejected", possibleWrite ? "settings_outcome_unknown" : "settings_not_submitted");
      }
    }
  }
  async get(id, requestId) {
    let row = this.row(id, requestId);
    if (unresolved(row) && !this.running.has(row.id)) {
      const state = await this.readCurrent(id);
      this.reconcile(row, state);
      row = this.row(id, requestId);
    }
    return this.receipt(row);
  }
  stop() { this.stopped = true; }
}

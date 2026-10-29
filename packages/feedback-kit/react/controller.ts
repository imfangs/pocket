import { normalizeFeedbackInput, type FeedbackAnnotation, type FeedbackContext, type FeedbackInput, type FeedbackReceipt } from "../contracts.ts";
import type { FeedbackCapture } from "../browser/capture.ts";
import type { FeedbackDraft, FeedbackDraftLease, FeedbackDraftStore } from "../browser/drafts.ts";

export type FeedbackPanelState = {
  ready: boolean; draft: FeedbackDraft | null; busy: boolean; checking: boolean;
  error: string; storageError: string; notFound: boolean; recoveryUnknown: boolean; restored: boolean;
};
export type FeedbackPanelControllerOptions = {
  appId: string; scope: string; context: FeedbackContext; initialCapture?: FeedbackCapture;
  autoDirect?: boolean; store: FeedbackDraftStore;
  prepare: (draft: FeedbackDraft) => Promise<FeedbackInput>;
  submit: (input: FeedbackInput, signal: AbortSignal) => Promise<FeedbackReceipt>;
  status: (id: string, signal: AbortSignal) => Promise<FeedbackReceipt | null>;
  retry?: (id: string, signal: AbortSignal) => Promise<FeedbackReceipt>;
  timeoutMs?: number;
};
const initialState = (): FeedbackPanelState => ({ ready: false, draft: null, busy: false, checking: false,
  error: "", storageError: "", notFound: false, recoveryUnknown: false, restored: false });
const immutable = <T,>(value: T): T => structuredClone(value);
const receiptStatuses = new Set(["received", "waiting_webhook", "sending", "queued", "delivered", "needs_attention"]);
async function bounded<T>(operation: () => Promise<T>, controller: AbortController, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation(), new Promise<T>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("feedback_timeout")); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** Owns one immutable submission journal. Closing only removes observers;
 * a POST already started may finish and resolve its own stored record. */
export function createFeedbackPanelController(options: FeedbackPanelControllerOptions) {
  let state = initialState(), lease: FeedbackDraftLease | null = null, disposed = false;
  let initFlight: Promise<void> | null = null, submitFlight: Promise<void> | null = null;
  let checkController: AbortController | null = null, saveTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const initial: FeedbackDraft = { id: crypto.randomUUID(), appId: options.appId, context: immutable(options.context),
    note: "", reason: "unspecified", annotations: [], autoDirect: options.autoDirect !== false, touched: false,
    ...(options.initialCapture ? { image: { ...options.initialCapture, id: crypto.randomUUID() } } : {}),
    phase: "editing", revision: 0, updatedAt: Date.now() };
  const publish = (patch: Partial<FeedbackPanelState>) => {
    state = { ...state, ...patch };
    if (!disposed) for (const listener of listeners) listener();
  };
  const save = async (draft: FeedbackDraft) => {
    if (!lease) throw new Error("反馈草稿尚未准备好");
    const saved = await options.store.save(lease, draft);
    if (!saved) throw new Error("这份反馈已完成或登录状态已变化，请重新打开反馈");
  };
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      if (!state.draft || state.draft.phase !== "editing" || state.draft.receipt) return;
      const draft = immutable(state.draft);
      void save(draft).then(() => publish({ storageError: "" }), () => publish({ storageError: "草稿暂未保存，请重试后再发送。" }));
    }, 300);
  };
  const edit = (patch: Partial<Pick<FeedbackDraft, "note" | "reason" | "annotations" | "image">>) => {
    const draft = state.draft;
    if (!draft || state.busy || draft.phase !== "editing" || draft.receipt) return;
    publish({ draft: { ...draft, ...patch, touched: true, revision: draft.revision + 1, updatedAt: Date.now() },
      error: "", notFound: false });
    scheduleSave();
  };
  const acceptReceipt = async (value: FeedbackReceipt) => {
    const draft = state.draft;
    if (!draft || value?.schemaVersion !== 1 || value.id !== draft.id || value.appId !== draft.appId ||
      !receiptStatuses.has(value.status) || !/^[0-9a-f]{64}$/.test(value.digest) ||
      !Number.isFinite(value.updatedAt)) throw new Error("反馈状态暂时无法确认");
    if (draft.receipt && (value.updatedAt < draft.receipt.updatedAt ||
        draft.receipt.status === "delivered" && value.status !== "delivered")) return;
    publish({ draft: { ...draft, receipt: immutable(value) }, error: "", storageError: "", notFound: false, recoveryUnknown: false });
    // The authenticated server now owns the immutable content and all retries.
    // Remove only this journal; late responses cannot delete a newer draft.
    if (lease) await options.store.remove(lease).catch(() => {});
  };
  const check = async () => {
    const draft = state.draft;
    if (disposed || !draft || draft.phase !== "unknown" || checkController || submitFlight) return;
    const controller = new AbortController(); checkController = controller;
    publish({ checking: true, error: "" });
    try {
      const result = await bounded(() => options.status(draft.id, controller.signal), controller, options.timeoutMs ?? 15000);
      if (disposed || controller.signal.aborted || state.draft?.id !== draft.id) return;
      if (result) await acceptReceipt(result);
      else if (draft.receipt) publish({ notFound: false, error: "暂未读取到新状态，原反馈已保存。" });
      else publish({ notFound: true, error: "暂未查到这条反馈，可重试提交原内容。" });
    } catch {
      if (!disposed) publish({ error: "暂时没有确认到反馈状态，内容已保留。" });
    } finally {
      if (checkController === controller) { checkController = null; publish({ checking: false }); }
    }
  };
  const initialize = (): Promise<void> => {
    if (disposed || state.ready) return Promise.resolve();
    if (initFlight) return initFlight;
    initFlight = Promise.resolve().then(async () => {
      try {
        if (disposed) return;
        const session = await options.store.open(options.scope, initial);
        if (disposed) return;
        if (session.draft.appId !== options.appId) throw new Error("反馈草稿所属产品不匹配");
        lease = session.lease;
        publish({ ready: true, draft: session.draft, error: "", storageError: "", restored: session.draft.id !== initial.id });
        if (session.draft.phase === "unknown") void check();
      } catch {
        if (!disposed) publish({ error: "暂时无法恢复反馈草稿，请重试。" });
      } finally { initFlight = null; }
    });
    return initFlight;
  };
  const retryDelivery = async () => {
    const draft = state.draft;
    if (disposed || !draft || draft.receipt?.status !== "needs_attention" || state.recoveryUnknown || checkController || !options.retry) return;
    const controller = new AbortController(); checkController = controller;
    publish({ checking: true, error: "" });
    try {
      const result = await bounded(() => options.retry!(draft.id, controller.signal), controller, options.timeoutMs ?? 20000);
      if (!disposed && !controller.signal.aborted) await acceptReceipt(result);
    } catch {
      if (!disposed) publish({ error: "恢复结果待确认，请先核对状态。", recoveryUnknown: true });
    } finally {
      if (checkController === controller) { checkController = null; publish({ checking: false }); }
    }
  };
  const submit = (retry = false): Promise<void> => {
    if (submitFlight) return submitFlight;
    const draft = state.draft;
    if (disposed || !draft || draft.receipt || draft.phase === "unknown" && (!retry || !state.notFound)) return Promise.resolve();
    clearTimeout(saveTimer); saveTimer = undefined;
    publish({ busy: true, error: "", storageError: "", notFound: false });
    const flight = Promise.resolve().then(async () => {
      let sent = false;
      try {
        const input = normalizeFeedbackInput(draft.preparedInput ?? await options.prepare(immutable(draft)));
        if (input.id !== draft.id || input.appId !== draft.appId) throw new Error("反馈编号不匹配");
        if (disposed) return;
        const pending: FeedbackDraft = { ...draft, phase: "unknown", preparedInput: immutable(input),
          revision: draft.revision + 1, updatedAt: Date.now() };
        // Persist before sending; a closed page can recover the same request.
        await save(pending);
        publish({ draft: pending });
        if (disposed) {
          await save({ ...draft, phase: "editing", preparedInput: undefined, revision: pending.revision + 1, updatedAt: Date.now() });
          return;
        }
        sent = true;
        const controller = new AbortController();
        const result = await bounded(() => options.submit(input, controller.signal), controller, options.timeoutMs ?? 45000);
        await acceptReceipt(result);
      } catch (error) {
        const status = (error as { status?: number })?.status;
        if (sent && draft.phase === "editing" && [400, 401, 403, 404, 405, 413, 415, 422].includes(status ?? 0)) {
          const editable: FeedbackDraft = { ...draft, preparedInput: undefined, phase: "editing",
            revision: (state.draft?.revision ?? draft.revision) + 1, updatedAt: Date.now() };
          await save(editable).catch(() => {});
          publish({ draft: editable, error: error instanceof Error ? error.message : "反馈未提交，请检查后重试。" });
        }
        else if (sent) publish({ error: "发送结果待确认，内容已保留。请先核对状态。" });
        else publish({ error: error instanceof Error ? error.message : "反馈暂未发送，请重试。" });
      } finally {
        publish({ busy: false });
        if (submitFlight === flight) submitFlight = null;
      }
    });
    submitFlight = flight;
    return flight;
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    initialize, submit, check, retryDelivery,
    edit,
    async startNew() {
      if (!lease || state.busy || state.draft?.phase !== "editing" || state.draft.receipt) return;
      clearTimeout(saveTimer); saveTimer = undefined; publish({ busy: true, error: "" });
      try {
        if (!await options.store.remove(lease)) throw new Error("反馈状态已变化，请重新打开");
        if (disposed) return;
        const fresh = { ...initial, id: crypto.randomUUID(), ...(initial.image ? { image: { ...initial.image, id: crypto.randomUUID() } } : {}) };
        const session = await options.store.open(options.scope, fresh);
        lease = session.lease;
        publish({ draft: session.draft, restored: false, notFound: false, storageError: "" });
      } catch (error) { publish({ error: error instanceof Error ? error.message : "暂时无法重新开始" }); }
      finally { publish({ busy: false }); }
    },
    setAnnotations(annotations: FeedbackAnnotation[]) { edit({ annotations: immutable(annotations) }); },
    replaceImage(capture?: FeedbackCapture) { edit({ image: capture ? { ...capture, id: crypto.randomUUID() } : undefined, annotations: [] }); },
    async flush() { clearTimeout(saveTimer); saveTimer = undefined; if (state.draft?.phase === "editing" && !state.draft.receipt) await save(immutable(state.draft)); },
    dispose() {
      disposed = true; clearTimeout(saveTimer); saveTimer = undefined; checkController?.abort(); checkController = null; listeners.clear();
      const draft = state.draft;
      let flush: Promise<unknown> = Promise.resolve();
      if (draft && lease && !draft.receipt) {
        if (draft.phase === "editing" && !draft.touched) flush = options.store.remove(lease).catch(() => {});
        else if (draft.phase === "editing") flush = save(immutable(draft)).catch(() => {});
      }
      // An owned store must remain usable until the last draft write and any
      // already-started POST have resolved. Releasing observers stays immediate.
      return Promise.all([flush, submitFlight?.catch(() => {})]).then(() => {});
    },
  };
}
export type FeedbackPanelController = ReturnType<typeof createFeedbackPanelController>;

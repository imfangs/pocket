import { t, useLocale } from "./i18n";
import { Button } from "./ui/Button";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import type { Thread } from "./types";
import type { OpenThreadResult } from "./threadConnection";
import { useReloadGuard } from "./updateSafety";
import { requireMachine } from "./machineScope";
import { threadInfoCache, type ThreadInfoKey, type ThreadInfoTicket } from "./threadInfoCache";
import {
  effortForModel, effortName, forgetModelRequest, mergeModelOperation, modelCanConnect, modelFailureStatus, modelName,
  modelOperationText, modelPresentation, modelSettingsRequest, modelSourceHint, modelUnresolved,
  readModelRequest, rememberModelRequest, sameModelRequest,
  chooseModelSummary, modelSummaryPresentation, modelOperationSummary,
} from "./threadModels";
import type { ModelOperation, ModelRequestIdentity, ModelSettingsSource, ModelSettingsSummary } from "./threadModels";
import "./thread-model-settings.css";

type Props = {
  thread: Thread;
  disabled?: boolean;
  onConnect: () => Promise<OpenThreadResult>;
  onActivity?: () => void;
  onBusyChange?: (busy: boolean) => void;
};

export default function ThreadModelSettings(props: Props) {
  useLocale();
  // Changing the inspected conversation also replaces all request ownership.
  return <ModelSettingsSession key={`${requireMachine()}:${props.thread.hostId}:${props.thread.id}`} {...props} />;
}

type CachedModelSummary = { summary: ModelSettingsSummary; savedFingerprint: string };
function ModelSettingsSession({ thread, disabled = false, onConnect, onActivity, onBusyChange }: Props) {
  useLocale();
  const cacheKey: ThreadInfoKey = { machine: requireMachine(), hostId: thread.hostId, threadId: thread.id, kind: "models" };
  const savedFingerprint = JSON.stringify([thread.savedModelSettings?.model ?? null, thread.savedModelSettings?.effort ?? null]);
  const [initialSummary] = useState(() => {
    const snapshot = threadInfoCache.get<CachedModelSummary>(cacheKey);
    if (snapshot && snapshot.value.savedFingerprint !== savedFingerprint) { threadInfoCache.remove(cacheKey); return null; }
    return snapshot;
  });
  const [summary, setSummary] = useState(initialSummary?.value.summary ?? null);
  const summaryRef = useRef<CachedModelSummary | null>(initialSummary?.value ?? null);
  const [source, setSource] = useState<ModelSettingsSource | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(!thread.missing && !initialSummary?.fresh);
  const [connecting, setConnecting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [initialRequest] = useState(() => readModelRequest(thread.id));
  const [recovering, setRecovering] = useState(!!initialRequest);
  const [operation, setOperation] = useState<ModelOperation>();
  const requestRef = useRef<ModelRequestIdentity | null>(initialRequest);
  const operationRef = useRef<ModelOperation | undefined>(undefined);
  const sourceRef = useRef<ModelSettingsSource | null>(null);
  const epoch = useRef(0), inFlight = useRef(false), delivered = useRef("");
  const observedSaved = useRef(savedFingerprint), savedRefreshPending = useRef(false), editorActive = useRef(editing);
  editorActive.current = editing;
  const autoChecks = useRef(0), busyCallback = useRef(onBusyChange), activity = useRef(onActivity);
  const editorId = useId(), modelId = useId(), effortId = useId(), statusId = useId();
  busyCallback.current = onBusyChange;
  activity.current = onActivity;
  const unresolved = recovering || modelUnresolved(operation);
  const presentation = source?.source === "desktop" ? modelPresentation(source, thread.savedModelSettings)
    : summary ? modelSummaryPresentation(summary) : modelPresentation(null, thread.savedModelSettings);
  const editable = source?.source === "desktop" && source.canChange && !!source.revision && !disabled && !thread.archived && !thread.missing;
  const changed = editing && !unresolved && !!source?.current && (model !== source.current.model || effort !== source.current.effort);
  const selected = source?.models.find(value => value.id === model);
  const waiting = loading || connecting || checking || submitting;
  const request = source ? modelSettingsRequest(source, model, effort, "preview") : null;
  useReloadGuard(() => submitting ? "正在保存模型设置，请稍后更新。" : unresolved ? "模型设置结果尚未确认，请先核对。" : changed ? "模型设置还有未保存的修改。" : null);

  const accept = (incoming: ModelOperation, cacheTicket?: ThreadInfoTicket): boolean => {
    if (incoming.threadId !== thread.id || (requestRef.current && !sameModelRequest(requestRef.current, incoming))) return false;
    const next = mergeModelOperation(operationRef.current, incoming);
    if (!sameModelRequest(next, incoming)) return false;
    operationRef.current = next;
    setOperation(next);
    if (modelUnresolved(next)) {
      requestRef.current = { threadId: next.threadId, requestId: next.requestId };
      rememberModelRequest(requestRef.current);
      setRecovering(false);
      setEditing(true);
      setModel(next.model);
      setEffort(next.effort);
    } else {
      forgetModelRequest(next);
      requestRef.current = null;
      setRecovering(false);
      if (next.status === "succeeded") {
        const current = next.current || { model: next.model, effort: next.effort };
        const previous = sourceRef.current;
        const nextSummary = modelOperationSummary(next, previous);
        // Persist the confirmed display value before its follow-up source read.
        // A failed refresh must not make reopening fall back to the old model.
        // The ticket predates the mutation/check, so logout cannot be undone.
        if (nextSummary && cacheTicket && threadInfoCache.current(cacheKey, cacheTicket)) {
          summaryRef.current = { summary: nextSummary, savedFingerprint };
          setSummary(nextSummary);
          threadInfoCache.put(cacheKey, { summary: nextSummary, savedFingerprint }, cacheTicket);
        }
        if (previous) {
          const updated = { ...previous, source: "desktop" as const, current, revision: null, canChange: false, operation: undefined };
          sourceRef.current = updated;
          setSource(updated);
        }
        setModel(current.model || "");
        setEffort(current.effort || "");
        setEditing(false);
        if (delivered.current !== next.requestId) { delivered.current = next.requestId; activity.current?.(); }
      }
    }
    return true;
  };

  const fetchSource = async (owner: number, preserveInput = false): Promise<ModelSettingsSource | null> => {
    const ticket = threadInfoCache.ticket(cacheKey);
    const next = await api<ModelSettingsSource>(`/api/tasks/${thread.id}/model-settings`, "GET", undefined, { signal: AbortSignal.timeout(15000) });
    if (owner !== epoch.current || !threadInfoCache.current(cacheKey, ticket)) return null;
    if (next.threadId !== thread.id) throw new Error("会话信息已变化，请重新读取。");
    const previousSummary = summaryRef.current?.savedFingerprint === savedFingerprint ? summaryRef.current.summary : null;
    const choice = chooseModelSummary(next, previousSummary);
    summaryRef.current = choice.summary ? { summary: choice.summary, savedFingerprint } : null;
    setSummary(choice.summary);
    if (choice.refreshCache) {
      if (choice.summary) threadInfoCache.put(cacheKey, { summary: choice.summary, savedFingerprint }, ticket);
      else threadInfoCache.remove(cacheKey);
    }
    sourceRef.current = next;
    setSource(next);
    if (!preserveInput && !requestRef.current) { setModel(next.current?.model || ""); setEffort(next.current?.effort || ""); }
    if (next.operation?.threadId === thread.id && modelUnresolved(next.operation)) {
      const previous = operationRef.current;
      if (!previous || modelUnresolved(previous) || !sameModelRequest(previous, next.operation)) {
        if (!requestRef.current && !modelUnresolved(previous)) operationRef.current = undefined;
        accept(next.operation);
      }
    }
    return next;
  };

  const readSource = async (preserveInput = false) => {
    if (inFlight.current || requestRef.current) return;
    const owner = epoch.current;
    inFlight.current = true;
    setLoading(true); setError("");
    try { await fetchSource(owner, preserveInput); }
    catch (failure) { if (owner === epoch.current) setError((failure as Error).message); }
    finally { if (owner === epoch.current) { inFlight.current = false; setLoading(false); } }
  };

  const check = async () => {
    const identity = requestRef.current;
    if (!identity || inFlight.current) return;
    const owner = epoch.current;
    const cacheTicket = threadInfoCache.ticket(cacheKey);
    inFlight.current = true;
    setChecking(true); setError("");
    try {
      const next = await api<ModelOperation>(`/api/tasks/${thread.id}/model-settings/${identity.requestId}`, "GET", undefined, { signal: AbortSignal.timeout(15000) });
      if (owner !== epoch.current) return;
      if (!sameModelRequest(identity, next) || !accept(next, cacheTicket)) throw new Error("暂未核对到这次设置，请稍后再试。");
      if (!modelUnresolved(next)) await fetchSource(owner, next.status !== "succeeded");
    } catch (failure) {
      if (owner === epoch.current) {
        setError((failure as Error).message);
        const current = operationRef.current;
        if (current && modelUnresolved(current)) accept({ ...current, status: "unknown" });
      }
    } finally {
      if (owner === epoch.current) { inFlight.current = false; setLoading(false); setChecking(false); }
    }
  };

  const beginEdit = async () => {
    if (inFlight.current || disabled || thread.archived || thread.missing || requestRef.current) return;
    setEditing(true); setError("");
    operationRef.current = undefined; setOperation(undefined);
    const owner = epoch.current;
    inFlight.current = true; setLoading(true);
    try {
      let next = await fetchSource(owner);
      if (owner !== epoch.current || requestRef.current) return;
      if (modelCanConnect(next)) {
        setConnecting(true);
        await onConnect();
        if (owner !== epoch.current) return;
        // Opening is the user's edit intent. Browsing the settings never opens
        // a desktop conversation, and delayed owner discovery is bounded.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await new Promise(resolve => setTimeout(resolve, 600 * attempt));
          if (owner !== epoch.current) return;
          next = await fetchSource(owner);
          if (!next || next.source === "desktop" || requestRef.current) break;
        }
      }
    } catch (failure) { if (owner === epoch.current) setError((failure as Error).message); }
    finally {
      if (owner === epoch.current) { inFlight.current = false; setLoading(false); setConnecting(false); }
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current || requestRef.current || !editable || !sourceRef.current) return;
    const requestId = crypto.randomUUID();
    const body = modelSettingsRequest(sourceRef.current, model, effort, requestId);
    if (!body) return;
    const pending: ModelOperation = { requestId, threadId: thread.id, model, effort, status: "pending" };
    if (!rememberModelRequest(pending)) { setError("暂时无法保留操作进度，请重新打开 Pocket 后再试。"); return; }
    threadInfoCache.remove(cacheKey); summaryRef.current = null; setSummary(null);
    const cacheTicket = threadInfoCache.ticket(cacheKey);
    requestRef.current = { threadId: thread.id, requestId };
    operationRef.current = pending; setOperation(pending);
    const owner = epoch.current;
    inFlight.current = true; autoChecks.current = 0;
    setSubmitting(true); setError(""); busyCallback.current?.(true);
    let needsCheck = false;
    try {
      const next = await api<ModelOperation>(`/api/tasks/${thread.id}/model-settings`, "POST", body, { signal: AbortSignal.timeout(20000) });
      if (owner !== epoch.current) return;
      if (!sameModelRequest(pending, next) || !accept(next, cacheTicket)) throw new Error("暂未确认保存结果，请核对。");
      if (!modelUnresolved(next)) await fetchSource(owner, next.status !== "succeeded");
    } catch (failure) {
      if (owner === epoch.current && requestRef.current) {
        setError((failure as Error).message);
        const status = modelFailureStatus(failure);
        accept({ ...pending, status, code: (failure as { code?: string }).code });
        needsCheck = status === "unknown";
      } else if (owner === epoch.current) setError((failure as Error).message);
    } finally {
      if (owner === epoch.current) {
        inFlight.current = false; setSubmitting(false); busyCallback.current?.(false);
        if (needsCheck) void actions.current.check();
      }
    }
  };

  const actions = useRef({ readSource, check });
  actions.current = { readSource, check };
  useEffect(() => {
    epoch.current++;
    if (requestRef.current) { setEditing(true); void actions.current.check(); }
    else if (!thread.missing && !initialSummary?.fresh) void actions.current.readSource();
    else setLoading(false);
    return () => { epoch.current++; inFlight.current = false; busyCallback.current?.(false); };
  }, [thread.id]);
  useEffect(() => threadInfoCache.subscribe(event => {
    if (event.machine && event.machine !== cacheKey.machine) return;
    summaryRef.current = null; setSummary(null);
    // An in-progress model operation keeps its own receipt lifecycle. Outside
    // that flow, a revoked read source must not remain a displayed live value.
    if (!editorActive.current && !requestRef.current) {
      sourceRef.current = null; setSource(null); setLoading(false);
    }
  }), [thread.id, thread.hostId]);
  useEffect(() => {
    if (observedSaved.current !== savedFingerprint) {
      observedSaved.current = savedFingerprint; savedRefreshPending.current = true;
      threadInfoCache.remove(cacheKey); summaryRef.current = null; setSummary(null);
    }
    if (!savedRefreshPending.current || waiting || editing || unresolved || thread.missing) return;
    savedRefreshPending.current = false;
    void actions.current.readSource();
  }, [savedFingerprint, waiting, editing, unresolved, thread.missing]);
  useEffect(() => {
    if (!unresolved || waiting) return;
    const refresh = () => { if (document.visibilityState === "visible" && navigator.onLine) void actions.current.check(); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (operation?.status === "pending" && autoChecks.current < 5) {
      timer = setTimeout(() => { autoChecks.current++; refresh(); }, 1800);
    }
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh); };
  }, [unresolved, waiting, operation]);

  const clearResult = () => { operationRef.current = undefined; setOperation(undefined); setError(""); };
  const status = connecting ? "正在连接…" : checking ? "正在核对设置…" : loading ? "正在读取设置…"
    : unresolved || operation ? modelOperationText(operation) : !editable ? modelSourceHint(source) : "思考强度修改后，对后续消息生效。";
  const displayModels = source?.source === "desktop" ? source.models : summary?.models;
  const modelLabel = !presentation.value || !presentation.value.model && !presentation.value.effort ? t("暂未读取")
    : `${presentation.value.model ? modelName(presentation.value.model, displayModels) : t("模型未提供")}${presentation.value.effort ? ` · ${effortName(presentation.value.effort)}` : ""}`;
  return <section className="thread-model-settings" aria-label={t("模型设置")}>
    <div className="thread-model-summary">
      <span className="thread-model-label">{t("模型")}</span>
      <div className="thread-model-value"><span>{modelLabel}</span>{presentation.saved && <small>{t("已保存")}</small>}</div>
      {!editing && !unresolved && <Button type="button" className="text-button thread-model-edit" variant="ghost" color="gray" size="2" aria-expanded={false} aria-controls={editorId}
        disabled={disabled || loading || thread.archived || thread.missing} onClick={() => void beginEdit()}>{t("修改")}</Button>}
    </div>
    {editing && <form id={editorId} className="thread-model-editor" onSubmit={event => void submit(event)}>
      {source?.canChangeModel !== false && source?.source === "desktop" && source.models.length > 1 ? <label htmlFor={modelId}>
        <span>{t("模型")}</span><select id={modelId} value={model} disabled={!editable || waiting || unresolved} aria-describedby={statusId}
          onChange={event => { const next = event.target.value; setModel(next); setEffort(effortForModel(source.models.find(value => value.id === next), effort)); clearResult(); }}>
          {!source.models.some(value => value.id === model) && <option value={model}>{modelName(model)}</option>}
          {source.models.map(value => <option key={value.id} value={value.id}>{modelName(value.id, source.models)}</option>)}
        </select>
      </label> : null}
      {selected && <label htmlFor={effortId}><span>{t("思考强度")}</span><select id={effortId} value={effort} disabled={!editable || waiting || unresolved} aria-describedby={statusId}
        onChange={event => { setEffort(event.target.value); clearResult(); }}>
        {!selected.supportedEfforts.includes(effort) && <option value={effort}>{effort ? t("{{value0}}（当前）", { value0: effortName(effort) }) : t("请选择")}</option>}
        {selected.supportedEfforts.map(value => <option key={value} value={value}>{effortName(value)}</option>)}
      </select></label>}
      <p className="field-help thread-model-status" id={statusId} role="status">{t(status)}</p>
      {error && <p className="inline-error thread-model-error" role="alert">{t(error)}</p>}
      <div className="thread-model-actions">
        <Button type="button" className="text-button" variant="ghost" color="gray" disabled={submitting} onClick={() => {
          setEditing(false); setError("");
          if (!unresolved) { setModel(source?.current?.model || ""); setEffort(source?.current?.effort || ""); clearResult(); }
        }}>{unresolved ? t("收起") : t("取消")}</Button>
        {unresolved ? <Button type="button" className="secondary" variant="soft" color="gray" disabled={waiting} onClick={() => void check()}>{t("核对结果")}</Button>
          : !editable || operation?.status === "changed" || operation?.status === "rejected" ? <Button type="button" className="secondary" variant="soft" color="gray" disabled={waiting || disabled || thread.archived || thread.missing}
            onClick={() => void beginEdit()}>{t("重新读取")}</Button>
          : <Button type="submit" className="primary" disabled={waiting || !request}>{t("保存")}</Button>}
      </div>
    </form>}
    {!editing && unresolved && <div className="thread-model-recovery"><span role="status">{t(modelOperationText(operation))}</span>
      <Button type="button" className="text-button" variant="ghost" color="gray" disabled={waiting} onClick={() => { setEditing(true); void check(); }}>{t("核对结果")}</Button></div>}
    {!editing && !unresolved && error && <p className="field-help thread-model-status" role="status">{t("暂时无法读取设置。")}</p>}
  </section>;
}

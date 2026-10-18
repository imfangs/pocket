import { machineStorageKey } from "./machineScope.ts";

export type ModelSettings = { model: string | null; effort: string | null };
export type ThreadModel = { id: string; name: string; displayName?: string; supportedEfforts: string[]; defaultEffort: string };
export type ModelOperation = {
  requestId: string;
  threadId: string;
  status: "pending" | "succeeded" | "rejected" | "unknown" | "changed";
  model: string;
  effort: string;
  code?: string;
  current?: ModelSettings | null;
};
export type ModelSettingsSource = {
  threadId: string;
  source: "desktop" | "saved" | "unavailable";
  current: ModelSettings | null;
  revision: string | null;
  models: ThreadModel[];
  canChange: boolean;
  canChangeModel?: boolean;
  reason?: string | null;
  operation?: ModelOperation;
  checkedAt: number;
};
export type ModelRequestIdentity = Pick<ModelOperation, "threadId" | "requestId">;

export function modelName(id: string | null | undefined, models: ThreadModel[] = []): string {
  if (!id) return "模型未提供";
  const entry = models.find(model => model.id === id);
  const name = entry?.displayName?.trim() || entry?.name?.trim() || id;
  // Only known naming syntax is made readable. Custom model IDs stay intact.
  if (/^gpt-\d+(?:\.\d+)?(?:-[a-z]+)*$/i.test(name)) {
    const [, version, suffix = ""] = /^gpt-(\d+(?:\.\d+)?)(.*)$/i.exec(name)!;
    return `GPT-${version}${suffix.replace(/-([a-z]+)/gi, (_, word: string) => ` ${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`)}`;
  }
  return name;
}

export function effortName(value: string): string {
  const names: Record<string, string> = { none: "None", minimal: "Minimal", low: "Light", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
  return names[value] || value;
}

export function modelSettingsLabel(value: ModelSettings | null | undefined, models: ThreadModel[] = []): string {
  if (!value || (!value.model && !value.effort)) return "暂未读取";
  return `${modelName(value.model, models)}${value.effort ? ` · ${effortName(value.effort)}` : ""}`;
}

export function modelPresentation(source: ModelSettingsSource | null, saved?: ModelSettings) {
  const value = source?.current ?? saved ?? null;
  return { value, label: modelSettingsLabel(value, source?.models), saved: !!(value?.model || value?.effort) && (source?.source !== "desktop" || !source.current) };
}

export const modelUnresolved = (operation?: ModelOperation) => !!operation && ["pending", "unknown"].includes(operation.status);
export const sameModelRequest = (a: ModelRequestIdentity, b: ModelRequestIdentity) => a.threadId === b.threadId && a.requestId === b.requestId;

export function mergeModelOperation(current: ModelOperation | undefined, incoming: ModelOperation): ModelOperation {
  if (!current) return incoming;
  if (!sameModelRequest(current, incoming) || !modelUnresolved(current)) return current;
  return incoming;
}

export function effortForModel(model: ThreadModel | undefined, previous: string): string {
  if (!model) return "";
  if (model.supportedEfforts.includes(previous)) return previous;
  return model.supportedEfforts.includes(model.defaultEffort) ? model.defaultEffort : model.supportedEfforts[0] || "";
}

export function modelSettingsRequest(source: ModelSettingsSource, model: string, effort: string, requestId: string) {
  if (source.source !== "desktop" || !source.canChange || !source.revision) return null;
  if (source.canChangeModel === false && source.current?.model !== model) return null;
  const option = source.models.find(value => value.id === model);
  if (!option?.supportedEfforts.includes(effort)) return null;
  if (source.current?.model === model && source.current.effort === effort) return null;
  return { requestId, model, effort, expectedRevision: source.revision };
}

export function modelSourceHint(source: ModelSettingsSource | null): string {
  const reason = source?.reason || "";
  if (["thread_archived", "archived_thread", "archived"].includes(reason)) return "取消归档后可修改。";
  if (["thread_not_found", "thread_missing", "missing"].includes(reason)) return "会话暂不可用，请刷新。";
  if (["lifecycle_pending", "operation_in_progress"].includes(reason)) return "请先完成会话的管理操作。";
  if (["needs_input", "needsinput", "needs_approval", "waiting_for_input"].includes(reason)) return "请先处理待回答的问题。";
  if (reason === "thread_not_ready") return "当前会话暂时不能修改设置。";
  if (reason === "model_state_changed") return "会话设置已变化，请重新读取。";
  if (modelCanConnect(source)) return "连接后可修改。";
  if (["model_catalog_unavailable", "model_options_unavailable"].includes(reason)) return "暂未读取到可用模型，请重新读取。";
  if (/[\u3400-\u9fff]/u.test(reason)) return reason;
  return "暂时无法修改，请重新读取。";
}

export function modelCanConnect(source: ModelSettingsSource | null): boolean {
  return !!source && source.source !== "desktop" && !source.canChange
    && ["owner_unavailable", "desktop_unavailable", "no_client_found", "not_connected"].includes(source.reason || "");
}

export function modelOperationText(operation?: ModelOperation): string {
  if (!operation || operation.status === "unknown") return "结果尚未确认，请核对后再修改。";
  if (operation.status === "pending") return "正在保存设置…";
  if (operation.status === "changed") return "设置已在其他地方变化，请重新读取。";
  if (operation.status === "succeeded") return "已保存，下次发送时生效。";
  if (operation.code === "relay_not_forwarded") return "未连接到 Mac，设置没有提交。";
  return "设置未保存，可重新读取后再试。";
}

export function modelFailureStatus(failure: unknown): "rejected" | "unknown" {
  const error = failure as { status?: number; code?: string } | null;
  // Used for POST only: this route returns 4xx before reserving the operation.
  // A failed receipt GET does not establish that the original write failed.
  return (error?.status && error.status >= 400 && error.status < 500)
    || (error?.status === 503 && error.code === "relay_not_forwarded") ? "rejected" : "unknown";
}

const recoveryKey = "pocket.model-settings-request.v1";
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9_-]{1,160}$/i.test(value);
type RequestStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function readModelRequest(threadId: string, storage?: RequestStorage): ModelRequestIdentity | null {
  if (!validId(threadId)) return null;
  try {
    const value = JSON.parse((storage ?? sessionStorage).getItem(machineStorageKey(`${recoveryKey}.${threadId}`)) || "null");
    return value?.threadId === threadId && validId(value?.requestId) ? { threadId, requestId: value.requestId } : null;
  } catch { return null; }
}
export function rememberModelRequest(identity: ModelRequestIdentity, storage?: RequestStorage): boolean {
  if (!validId(identity.threadId) || !validId(identity.requestId)) return false;
  try {
    (storage ?? sessionStorage).setItem(machineStorageKey(`${recoveryKey}.${identity.threadId}`), JSON.stringify({ threadId: identity.threadId, requestId: identity.requestId }));
    return true;
  } catch { return false; }
}
export function forgetModelRequest(identity: ModelRequestIdentity, storage?: RequestStorage): void {
  try {
    const target = storage ?? sessionStorage;
    const stored = readModelRequest(identity.threadId, target);
    if (stored && sameModelRequest(stored, identity)) target.removeItem(machineStorageKey(`${recoveryKey}.${identity.threadId}`));
  } catch { /* A terminal receipt in memory remains authoritative. */ }
}

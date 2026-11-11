import type { Thread } from "./types";
import { machineStorageKey } from "./machineScope.ts";
import type { ThreadConnection } from "./threadConnection";

export type TaskOperation = {
  requestId: string;
  operation: "create" | "archive" | "restore";
  status: "pending" | "waiting" | "succeeded" | "rejected" | "unknown" | "cancelled" | "changed";
  threadId?: string;
  thread?: Thread;
  connection?: ThreadConnection;
  descendantCount?: number;
  code?: string;
  message?: string;
  createdAt?: number;
  updatedAt?: number;
  creationStatus?: "created";
  initialMessage?: { requestId: string; status: "not_queued" | "queued" | "pending" | "accepted" | "unknown" | "rejected" | "editing" | "cancelled"; code?: string };
};
export type CreateLocation = { id: string; label: string; cwd: string; projectId?: string | null; projectName?: string | null };
type OperationFailure = { status?: number; code?: string; message?: string; name?: string };
export function failedOperation(initial: TaskOperation, failure: OperationFailure): TaskOperation {
  const rejected = !!failure.status && (failure.status < 500 ||
    failure.status === 503 && failure.code === "relay_not_forwarded");
  return { ...initial, status: rejected ? "rejected" : "unknown", code: failure.code,
    message: rejected ? failure.message : undefined };
}
export function operationCheckError(failure: OperationFailure, operation?: TaskOperation["operation"]) {
  // A missing receipt is not proof that a previous POST never reached the Mac.
  if (failure.status === 404) return operation === "create"
    ? "暂未找到操作记录，请稍后核对；停止核对不会删除已创建的会话。"
    : "暂未找到操作记录，结果仍待确认，请稍后核对。";
  if (failure.status === 401) return "登录已过期，重新登录后可继续核对。";
  if (["relay_not_forwarded", "relay_unavailable"].includes(failure.code || ""))
    return "暂时连接不到 Mac，连接恢复后继续核对。";
  if (failure.name === "TimeoutError" || failure.name === "TypeError")
    return "核对中断或超时，请稍后继续核对。";
  return "暂时无法核对操作状态，请稍后再试。";
}
const creationRecoveryKey = "pocket.pending-creation-ids.v1";
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function readCreationRecoveryIds(storage?: Pick<Storage, "getItem">): string[] {
  try {
    const value = JSON.parse((storage ?? sessionStorage).getItem(machineStorageKey(creationRecoveryKey)) || "[]");
    return Array.isArray(value) ? [...new Set(value.filter(validId))].slice(-100) : [];
  } catch { return []; }
}
export function saveCreationRecoveryIds(ids: string[], storage?: Pick<Storage, "setItem">) {
  try { (storage ?? sessionStorage).setItem(machineStorageKey(creationRecoveryKey), JSON.stringify([...new Set(ids.filter(validId))].slice(-100))); }
  catch { /* An unavailable session store must not change the operation itself. */ }
}
export function creationRecoveryIds(operations: Iterable<TaskOperation>, watched: ReadonlySet<string>) {
  return [...operations].filter(operation => operation.operation === "create" && watched.has(operation.requestId) &&
    ["pending", "waiting", "unknown", "succeeded"].includes(operation.status)).map(operation => operation.requestId);
}
export const activeOperation = (operation?: TaskOperation) => !!operation && ["pending", "waiting", "unknown"].includes(operation.status);
export const pollOperation = (operation: TaskOperation) => ["pending", "waiting"].includes(operation.status);
export function mergeOperation(current: TaskOperation | undefined, incoming: TaskOperation): TaskOperation {
  if (!current) return incoming;
  if (current.requestId !== incoming.requestId || current.operation !== incoming.operation) return current;
  if (current.threadId && incoming.threadId && current.threadId !== incoming.threadId) return current;
  if (current.updatedAt !== undefined && incoming.updatedAt !== undefined && incoming.updatedAt < current.updatedAt) return current;
  if (current.initialMessage && incoming.initialMessage) {
    if (current.initialMessage.requestId !== incoming.initialMessage.requestId) return current;
    // Lifecycle timestamps do not advance with the independent dispatch ledger.
    // A late list therefore cannot undo an exact first-message terminal receipt.
    if (["accepted", "cancelled"].includes(current.initialMessage.status))
      incoming = { ...incoming, initialMessage: current.initialMessage };
  }
  if (["succeeded", "cancelled", "changed", "rejected"].includes(current.status)) {
    if (current.status === "succeeded" && incoming.status === "succeeded" && incoming.initialMessage &&
      (!current.initialMessage || current.initialMessage.requestId === incoming.initialMessage.requestId))
      return { ...current, initialMessage: incoming.initialMessage };
    return current;
  }
  return { ...current, ...incoming };
}
export function operationText(operation: TaskOperation) {
  const action = operation.operation === "create" ? "新建" : operation.operation === "restore" ? "取消归档" : "归档";
  if (operation.operation === "create" && operation.creationStatus === "created" && operation.initialMessage && operation.status !== "cancelled") {
    const status = operation.initialMessage.status;
    if (status === "accepted") return "会话已创建，首条消息已发送。";
    if (status === "queued") return "会话已创建，首条消息待发送。";
    if (status === "pending") return "会话已创建，首条消息正在提交。";
    if (status === "editing") return "会话已创建，首条消息正在编辑。";
    if (status === "cancelled") return "会话已创建，首条消息已取消。";
    if (status === "rejected") return "会话已创建，首条消息发送未完成，请打开处理。";
    if (status === "unknown") return "会话已创建，首条消息结果待确认，请打开核对。";
    return "会话已创建，首条消息尚未入队，请核对。";
  }
  if (operation.status === "waiting") return `Codex 仍占用会话，释放后继续${action}。`;
  if (operation.status === "pending") return `正在${action}会话…`;
  if (operation.status === "unknown") return `${action}结果待确认，请核对。`;
  if (operation.status === "succeeded") return `会话已${operation.operation === "create" ? "创建" : action}。`;
  if (operation.status === "cancelled") return operation.operation === "create"
    ? "已停止核对；可能已创建的会话会保留。" : "已取消等待。";
  if (operation.status === "changed") return "会话状态已变化，本次操作已停止，请确认后再操作。";
  if (operation.code === "relay_not_forwarded") return operation.operation === "create"
    ? "请求还未送达 Mac，连接恢复后可再次创建。"
    : "请求还未送达 Mac，连接恢复后可重试。";
  if (operation.code === "outbox_not_empty") return "还有待发消息，请先处理再归档。";
  if (operation.code === "restore_scope_conflict") return "这个会话有关联子会话，请在 Codex 中取消归档。";
  if (operation.code === "restore_scope_unconfirmed") return "暂时无法确认恢复范围，请在 Codex 中取消归档。";
  if (operation.code === "active_or_unknown_thread") return "会话尚未确认结束，请先核对状态。";
  if (["thread_active", "thread_running", "active_turn"].includes(operation.code || "")) return "会话正在运行，请先停止或等本轮结束再归档。";
  if (["dispatch_unknown", "pending_dispatch", "unresolved_dispatch", "unresolved_send"].includes(operation.code || "")) return "发送结果尚未确认，请先核对。";
  return operation.message || `未能${action}会话，请刷新状态后重试。`;
}
export function operationCancelLabel(operation: TaskOperation) {
  if (operation.operation === "create") return operation.status === "unknown" ? "停止核对" : null;
  if (operation.status === "unknown") return "停止后续尝试";
  return operation.status === "waiting" ? operation.operation === "restore" ? "取消等待" : "取消等待归档" : null;
}

type CreationNoticeOptions = {
  requestId: string;
  target: HTMLElement;
  onDismiss: () => void;
  browser?: Window;
  visibility?: Document;
  Observer?: typeof IntersectionObserver;
  now?: () => number;
};

// A successful create retains its recovery action until the user has had eight
// visible, interactive seconds to use it. Polling updates never renew that time.
export function observeCreationNotice(options: CreationNoticeOptions) {
  const browser = options.browser ?? window, visibility = options.visibility ?? document;
  const Observer = options.Observer ?? globalThis.IntersectionObserver;
  if (!Observer) return { update: (_operation: TaskOperation, _enabled: boolean) => {}, stop: () => {} };
  const now = options.now ?? (() => performance.now()), target = options.target;
  let stopped = false, enabled = false, visible = false, pageShown = true;
  let pageFocused = visibility.hasFocus?.() !== false;
  let focused = target.contains(visibility.activeElement);
  let hovered = !!browser.matchMedia?.("(hover: hover)").matches && target.matches(":hover");
  let remaining = 8000, startedAt: number | undefined, timer: number | undefined;
  const pause = () => {
    if (startedAt !== undefined) remaining = Math.max(0, remaining - Math.max(0, now() - startedAt));
    startedAt = undefined;
    browser.clearTimeout(timer); timer = undefined;
  };
  const unobstructed = () => {
    if (target.closest("[inert], [hidden], [aria-hidden='true']")) return false;
    if (visibility.querySelector("dialog[open], [data-reading-overlay]")) return false;
    const backdrop = visibility.querySelector(".sidebar-backdrop.shown")?.getBoundingClientRect();
    return !backdrop || backdrop.width === 0 || backdrop.height === 0;
  };
  const ready = () => !stopped && enabled && visible && pageShown && pageFocused && !hovered && !focused &&
    visibility.visibilityState === "visible" && unobstructed();
  const schedule = () => {
    if (!ready()) { pause(); return; }
    if (startedAt !== undefined) return;
    if (remaining <= 0) { stop(); options.onDismiss(); return; }
    startedAt = now();
    timer = browser.setTimeout(() => { pause(); schedule(); }, remaining);
  };
  const pointerEnter = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    hovered = true; schedule();
  };
  const pointerLeave = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    hovered = false; schedule();
  };
  const focusIn = () => { focused = true; schedule(); };
  const focusOut = (event: FocusEvent) => { focused = target.contains(event.relatedTarget as Node | null); schedule(); };
  const refreshInteraction = () => {
    focused = target.contains(visibility.activeElement);
    hovered = !!browser.matchMedia?.("(hover: hover)").matches && target.matches(":hover");
  };
  const visibilityChange = () => {
    if (visibility.visibilityState === "visible") { pageFocused = visibility.hasFocus?.() !== false; refreshInteraction(); }
    schedule();
  };
  const pageHide = () => { pageShown = false; schedule(); };
  const pageShow = () => { pageShown = true; pageFocused = visibility.hasFocus?.() !== false; refreshInteraction(); schedule(); };
  const pageBlur = () => { pageFocused = false; schedule(); };
  const pageFocus = () => { pageFocused = true; refreshInteraction(); schedule(); };
  const observer = new Observer(entries => {
    for (const entry of entries) if (entry.target === target) visible = entry.isIntersecting && entry.intersectionRatio >= 1;
    schedule();
  }, { threshold: 1 });
  function stop() {
    if (stopped) return;
    stopped = true; pause(); observer.disconnect();
    visibility.removeEventListener("visibilitychange", visibilityChange);
    browser.removeEventListener("pagehide", pageHide);
    browser.removeEventListener("pageshow", pageShow);
    browser.removeEventListener("blur", pageBlur);
    browser.removeEventListener("focus", pageFocus);
    browser.removeEventListener("pocket-reading-visibility-change", schedule);
    target.removeEventListener("pointerenter", pointerEnter);
    target.removeEventListener("pointerleave", pointerLeave);
    target.removeEventListener("pointercancel", pointerLeave);
    target.removeEventListener("focusin", focusIn);
    target.removeEventListener("focusout", focusOut);
  }
  visibility.addEventListener("visibilitychange", visibilityChange);
  browser.addEventListener("pagehide", pageHide);
  browser.addEventListener("pageshow", pageShow);
  browser.addEventListener("blur", pageBlur);
  browser.addEventListener("focus", pageFocus);
  browser.addEventListener("pocket-reading-visibility-change", schedule);
  target.addEventListener("pointerenter", pointerEnter);
  target.addEventListener("pointerleave", pointerLeave);
  target.addEventListener("pointercancel", pointerLeave);
  target.addEventListener("focusin", focusIn);
  target.addEventListener("focusout", focusOut);
  observer.observe(target);
  return {
    update(operation: TaskOperation, canDismiss: boolean) {
      enabled = canDismiss && operation.requestId === options.requestId && operation.operation === "create" && operation.status === "succeeded";
      schedule();
    },
    stop,
  };
}

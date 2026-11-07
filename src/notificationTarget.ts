import { machineStorageKey, isMachineId, type MachineId } from "./machineScope.ts";

const taskPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validTask = (value: unknown): value is string => typeof value === "string" && taskPattern.test(value);
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
export type NotificationEntryEvent = CustomEvent<string> & { targetRejected?: boolean };
function routeTask(search: string) {
  const values = new URLSearchParams(search).getAll("task");
  return values.length === 1 && validTask(values[0]) ? values[0] : null;
}
const keys = (machine?: MachineId | null) => ({ task: machineStorageKey("pocket.pending-task", machine), entry: machineStorageKey("pocket.pending-task-entry", machine) });

export function notificationRouteUrl(href: string, machine: MachineId, target: string | null) {
  if (!isMachineId(machine) || target !== null && !validTask(target)) throw new Error("会话链接无效。");
  const url = new URL(href);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("会话链接无效。");
  url.search = ""; url.hash = "";
  url.searchParams.set("machine", machine);
  if (target) url.searchParams.set("task", target);
  return url.href;
}

/** Keep only the target and the existing task route, never arbitrary URL parameters. */
export function storeNotificationTarget(storage: Storage, search: string, target: string, machine?: MachineId | null) {
  if (!validTask(target)) throw new Error("会话链接无效。");
  const key = keys(machine);
  storage.setItem(key.task, target);
  storage.setItem(key.entry, JSON.stringify({ version: 1, target, routeTask: routeTask(search) }));
}
export function clearNotificationTarget(storage: Storage, machine?: MachineId | null) {
  const key = keys(machine); storage.removeItem(key.task); storage.removeItem(key.entry);
}
export function readInitialNotificationTarget(storage: Storage, search: string, machine?: MachineId | null) {
  const explicit = routeTask(search), key = keys(machine);
  let pending: string | null = null, matchesReceipt = false;
  try {
    const value = storage.getItem(key.task); pending = validTask(value) ? value : null;
    const marker = storage.getItem(key.entry);
    if (marker && marker.length <= 160) {
      const entry = JSON.parse(marker);
      matchesReceipt = !!pending && entry && typeof entry === "object" && !Array.isArray(entry) &&
        Object.keys(entry).length === 3 && entry.version === 1 && entry.target === pending &&
        (entry.routeTask === null || validTask(entry.routeTask)) && entry.routeTask === explicit;
    }
  } catch { /* The explicit URL remains usable without storage. */ }
  return matchesReceipt ? pending : explicit ?? pending;
}

import { getReloadBlocker } from "./updateSafety.ts";

export const machines = [{ id: "ged", label: "格得 Mac" }, { id: "wandou", label: "豌豆 Mac" }] as const;
export type MachineId = typeof machines[number]["id"];
export const lastMachineKey = "pocket.machine.v1";
export const publicPocketOrigin = "https://x.fangs.cc";
export const isMachineId = (value: unknown): value is MachineId => value === "ged" || value === "wandou";
const taskIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function resolveMachine(search: string, lastMachine?: string | null): MachineId | null {
  const params = new URLSearchParams(search), explicit = params.getAll("machine");
  if (explicit.length) return explicit.length === 1 && isMachineId(explicit[0]) ? explicit[0] : null;
  if (params.has("task")) return "ged";
  return isMachineId(lastMachine) ? lastMachine : "ged";
}
let resolved = false, selected: MachineId | null = null;
export function currentMachineId(): MachineId | null {
  if (typeof window === "undefined") return "ged";
  if (!resolved) {
    let remembered: string | null = null;
    try { remembered = window.localStorage.getItem(lastMachineKey); } catch { /* URL selection still works without storage. */ }
    selected = resolveMachine(window.location.search, remembered); resolved = true;
    // Keep this implicit selection explicit before an update adds a task ID,
    // and let the service worker identify the machine of the existing window.
    const params = new URLSearchParams(window.location.search);
    if (selected === "wandou" && !params.has("machine") && !params.has("task")) {
      const url = new URL(window.location.href); url.searchParams.set("machine", selected);
      window.history.replaceState(window.history.state, "", url.href);
    }
  }
  return selected;
}
export function currentMachine() { return machines.find(machine => machine.id === currentMachineId()) ?? null; }
export function requireMachine(machine: MachineId | null = currentMachineId()): MachineId {
  if (!isMachineId(machine)) throw new Error("请选择电脑后继续。");
  return machine;
}
export function machineStorageKey(key: string, machine: MachineId | null = currentMachineId()) {
  const id = requireMachine(machine);
  return id === "ged" ? key : `pocket.machine.${id}.${key}`;
}
export function machineApiPath(path: string, machine: MachineId | null = currentMachineId()) {
  const id = requireMachine(machine), pathname = path.split("?", 1)[0];
  if (!/^\/api\/(?!machines(?:\/|$))[^#]*$/.test(path)) throw new Error("无效的电脑请求路径。");
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { throw new Error("无效的电脑请求路径。"); }
  if (decoded.includes("\\") || decoded.includes("//") || decoded.split("/").some(segment => segment === "." || segment === "..")) throw new Error("无效的电脑请求路径。");
  return id === "ged" ? path : `/api/machines/${id}${path.slice(4)}`;
}
export function checkMachineResponse(response: Pick<Response, "headers">, machine: MachineId) {
  const received = response.headers?.get("X-Pocket-Machine") ?? null;
  if (machine === "wandou" ? received !== machine : received !== null && received !== machine)
    throw new Error("电脑响应来源不匹配，请重新连接。");
}
export function machineTaskUrl(threadId: string, machine: MachineId | null = currentMachineId()) {
  const id = requireMachine(machine);
  if (!taskIdPattern.test(threadId)) throw new Error("会话链接无效。");
  return id === "ged" ? `/?task=${threadId}` : `/?machine=${id}&task=${threadId}`;
}
export function machineNavigationUrl(href: string, machine: MachineId, threadId?: string) {
  if (!isMachineId(machine)) throw new Error("请选择电脑后继续。");
  if (threadId !== undefined && !taskIdPattern.test(threadId)) throw new Error("会话链接无效。");
  const original = new URL(href);
  const url = needsPublicMachine(machine, original.hostname) ? new URL("/", publicPocketOrigin) : original;
  url.search = ""; url.hash = ""; url.searchParams.set("machine", machine);
  if (threadId) url.searchParams.set("task", threadId);
  return url.href;
}
export function machineSwitchBlocker(reason: string | null) { return reason?.replaceAll("更新", "切换电脑") ?? null; }
export function needsPublicMachine(machine: MachineId | null = currentMachineId(), hostname = typeof window === "undefined" ? "" : window.location.hostname) {
  return machine === "wandou" && ["threads.local", "localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}
// Same-origin navigation releases old in-memory owners only after draft and
// pending-write guards agree; it never claims these drafts were persisted.
export function changeMachine(machine: MachineId, threadId?: string): string | null {
  if (!isMachineId(machine)) return "请选择电脑后继续。";
  if (machine === currentMachineId() && !threadId && !needsPublicMachine(machine)) return null;
  const blocker = machineSwitchBlocker(getReloadBlocker());
  if (blocker) return blocker;
  const url = machineNavigationUrl(window.location.href, machine, threadId);
  try { window.localStorage.setItem(lastMachineKey, machine); } catch { /* Target URL still pins the selection. */ }
  window.location.assign(url);
  return null;
}
export function bindMachineUnloadGuard(browser = window) {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!getReloadBlocker()) return;
    event.preventDefault(); event.returnValue = "";
  };
  browser.addEventListener("beforeunload", beforeUnload);
  return () => browser.removeEventListener("beforeunload", beforeUnload);
}

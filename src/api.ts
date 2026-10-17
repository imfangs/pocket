import { holdReload, isReloadBlockingRequest } from "./updateSafety.ts";
import { checkMachineResponse, currentMachineId, machineApiPath, requireMachine, type MachineId } from "./machineScope.ts";

export function createApiClient(scope: () => MachineId | null = currentMachineId, request: typeof fetch = (...args) => fetch(...args),
  expire: (machine: MachineId) => void = machine => window.dispatchEvent(new CustomEvent("navigator-auth-expired", { detail: { machine } }))) {
  const tokens = new Map<MachineId, string>();
  return {
    setToken(value: string, machine: MachineId | null = scope()) { tokens.set(requireMachine(machine), value); },
    async api<T>(path: string, method = "GET", body?: unknown, options: { signal?: AbortSignal; raw?: boolean; contentType?: string } = {}): Promise<T> {
      const machine = requireMachine(scope()), url = machineApiPath(path, machine);
      let token = tokens.get(machine) ?? "";
      const release = isReloadBlockingRequest(path, method) ? holdReload() : () => {};
      try {
        const send = () => request(url, { method, signal: options.signal, cache: "no-store",
            headers: { "Content-Type": options.contentType || "application/json", ...(method === "GET" ? {} : { "X-Navigator-Token": token }) },
            ...(body === undefined ? {} : { body: options.raw ? body as BodyInit : JSON.stringify(body) }) });
        let response = await send();
        checkMachineResponse(response, machine);
        let data = await response.json();
        if (response.status === 403 && data.error === "请求已过期，请刷新页面") {
          const fresh = await request(machineApiPath("/api/catalog", machine), { cache: "no-store", signal: options.signal });
          checkMachineResponse(fresh, machine);
          if (fresh.ok) {
            const catalog = await fresh.json();
            if (catalog.csrfToken) {
              token = catalog.csrfToken; tokens.set(machine, token); response = await send();
              checkMachineResponse(response, machine); data = await response.json();
            }
          } else if (fresh.status === 401) expire(machine);
        }
        if (response.status === 401) expire(machine);
        if (!response.ok) throw Object.assign(new Error(data.error || "请求失败"), { status: response.status, ...(typeof data.code === "string" ? { code: data.code } : {}) });
        return data;
      } finally { release(); }
    },
  };
}
const client = createApiClient();
export const api = client.api;
export const setToken = client.setToken;

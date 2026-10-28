import { holdReload, isReloadBlockingRequest } from "./updateSafety.ts";
import { checkMachineResponse, currentMachineId, machineApiPath, requireMachine, type MachineId } from "./machineScope.ts";
import { hydrateReadResponse, isReadVersion, readResponseKind, READ_VERSION_HEADER } from "../shared/read-response.mjs";
import { createReadResponseCache } from "./readResponseCache.ts";

export function createApiClient(scope: () => MachineId | null = currentMachineId, request: typeof fetch = (...args) => fetch(...args),
  expire: (machine: MachineId) => void = machine => window.dispatchEvent(new CustomEvent("navigator-auth-expired", { detail: { machine } }))) {
  const tokens = new Map<MachineId, string>();
  const reads = createReadResponseCache();
  let readEpoch = 0;
  const clearReadResponses = (machine?: MachineId) => { readEpoch++; reads.clear(machine); };
  return {
    clearReadResponses,
    setToken(value: string, machine: MachineId | null = scope()) { tokens.set(requireMachine(machine), value); },
    async api<T>(path: string, method = "GET", body?: unknown, options: { signal?: AbortSignal; raw?: boolean; contentType?: string } = {}): Promise<T> {
      const machine = requireMachine(scope()), url = machineApiPath(path, machine);
      let token = tokens.get(machine) ?? "";
      const kind = readResponseKind(path, method), key = `${machine}:${method}:${path}`, epoch = readEpoch;
      let cached = kind ? reads.get(key) : undefined;
      const release = isReloadBlockingRequest(path, method) ? holdReload() : () => {};
      try {
        const send = () => request(url, { method, signal: options.signal, cache: "no-store",
            headers: { "Content-Type": options.contentType || "application/json", ...(method === "GET" ? {} : { "X-Navigator-Token": token }),
              ...(cached ? { [method === "GET" ? "If-None-Match" : READ_VERSION_HEADER]: cached.version } : {}) },
            ...(body === undefined ? {} : { body: options.raw ? body as BodyInit : JSON.stringify(body) }) });
        let response = await send();
        checkMachineResponse(response, machine);
        if (kind && (response.status === 304 || response.status === 204)) {
          const version = response.headers?.get("ETag");
          const hydrated = cached && version === cached.version && epoch === readEpoch
            ? hydrateReadResponse(kind, cached.data, response.headers) : null;
          if (hydrated !== null) {
            reads.put(key, cached!.version, hydrated);
            return hydrated as T;
          }
          // A missing/evicted body or incompatible response requires one full
          // read. These routes are reads, including the explicit sync action.
          cached = undefined;
          response = await send(); checkMachineResponse(response, machine);
          if (response.status === 304 || response.status === 204) throw new Error("读取版本尚未同步，请重试。");
        }
        let data = await response.json();
        if (response.status === 403 && data.error === "请求已过期，请刷新页面") {
          const fresh = await request(machineApiPath("/api/catalog", machine), { cache: "no-store", signal: options.signal });
          checkMachineResponse(fresh, machine);
          if (fresh.ok) {
            const catalog = await fresh.json();
            if (catalog.csrfToken) {
              token = catalog.csrfToken; tokens.set(machine, token); cached = undefined; response = await send();
              checkMachineResponse(response, machine); data = await response.json();
            }
          } else if (fresh.status === 401) { clearReadResponses(machine); expire(machine); }
        }
        if (response.status === 401) { clearReadResponses(machine); expire(machine); }
        if (!response.ok) throw Object.assign(new Error(data.error || "请求失败"), { status: response.status, ...(typeof data.code === "string" ? { code: data.code } : {}) });
        if (path === "/api/auth/logout" || path === "/api/auth/login") clearReadResponses(machine);
        const version = kind ? response.headers?.get("ETag") : undefined;
        if (kind && epoch === readEpoch && isReadVersion(version)) reads.put(key, version!, data);
        return data;
      } finally { release(); }
    },
  };
}
const client = createApiClient();
export const api = client.api;
export const setToken = client.setToken;
export const clearReadResponses = client.clearReadResponses;

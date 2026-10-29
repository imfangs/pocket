import { holdReload, isReloadBlockingRequest } from "./updateSafety.ts";
import { checkMachineResponse, currentMachineId, machineApiPath, requireMachine, type MachineId } from "./machineScope.ts";
import { hydrateReadResponse, isReadVersion, readResponseKind, READ_VERSION_HEADER } from "../shared/read-response.mjs";
import { createReadResponseCache } from "./readResponseCache.ts";
import { requestActivity, type RequestActivity } from "./requestActivity.ts";

export function createApiClient(scope: () => MachineId | null = currentMachineId, request: typeof fetch = (...args) => fetch(...args),
  expire: (machine: MachineId) => void = machine => window.dispatchEvent(new CustomEvent("navigator-auth-expired", { detail: { machine } })),
  activity: Pick<RequestActivity, "begin" | "clearMachine"> = requestActivity) {
  const tokens = new Map<MachineId, string>();
  const authenticationEpochs = new Map<MachineId, number>();
  const reads = createReadResponseCache();
  let readEpoch = 0;
  const clearReadResponses = (machine?: MachineId) => { readEpoch++; reads.clear(machine); };
  const authenticationEpoch = (machine: MachineId) => authenticationEpochs.get(machine) ?? 0;
  const invalidateAuthentication = (machine: MachineId) => {
    authenticationEpochs.set(machine, authenticationEpoch(machine) + 1);
    tokens.delete(machine);
    clearReadResponses(machine);
    try { activity.clearMachine(machine); } catch { /* An observer must not change authentication. */ }
  };
  return {
    clearReadResponses,
    invalidateAuthentication,
    setToken(value: string, machine: MachineId | null = scope()) { tokens.set(requireMachine(machine), value); },
    async api<T>(path: string, method = "GET", body?: unknown, options: { signal?: AbortSignal; raw?: boolean; contentType?: string } = {}): Promise<T> {
      const machine = requireMachine(scope()), url = machineApiPath(path, machine);
      const changesAuthentication = method === "POST" && (path === "/api/auth/logout" || path === "/api/auth/login");
      // Cookies can change as soon as headers arrive, before response.json().
      // Supersede preceding requests before dispatch, even if this action fails.
      if (changesAuthentication) invalidateAuthentication(machine);
      let token = tokens.get(machine) ?? "";
      const kind = readResponseKind(path, method), key = `${machine}:${method}:${path}`, epoch = readEpoch;
      const authEpoch = authenticationEpoch(machine);
      const currentAuthentication = () => authEpoch === authenticationEpoch(machine);
      const expireAuthentication = () => {
        if (!currentAuthentication()) return;
        invalidateAuthentication(machine); expire(machine);
      };
      let cached = kind ? reads.get(key) : undefined;
      const release = isReloadBlockingRequest(path, method) ? holdReload() : () => {};
      let finishActivity = () => {};
      try {
        try { finishActivity = activity.begin({ machine, path, method }); }
        catch { /* Activity is optional observation, never a request precondition. */ }
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
        // A preceding session must neither expire a new login nor retry an old
        // mutation using its credentials. Cache/source invalidation is separate.
        if (response.status === 403 && data.error === "请求已过期，请刷新页面" && currentAuthentication()) {
          const fresh = await request(machineApiPath("/api/catalog", machine), { cache: "no-store", signal: options.signal });
          checkMachineResponse(fresh, machine);
          if (fresh.ok) {
            const catalog = await fresh.json();
            if (catalog.csrfToken && currentAuthentication()) {
              token = catalog.csrfToken; tokens.set(machine, token); cached = undefined; response = await send();
              checkMachineResponse(response, machine); data = await response.json();
            }
          } else if (fresh.status === 401) expireAuthentication();
        }
        if (response.status === 401) expireAuthentication();
        if (!response.ok) throw Object.assign(new Error(data.error || "请求失败"), { status: response.status, ...(typeof data.code === "string" ? { code: data.code } : {}) });
        if (changesAuthentication) invalidateAuthentication(machine);
        const version = kind ? response.headers?.get("ETag") : undefined;
        if (kind && epoch === readEpoch && isReadVersion(version)) reads.put(key, version!, data);
        return data;
      } finally {
        release();
        try { finishActivity(); } catch { /* Preserve the actual response/error if an observer fails. */ }
      }
    },
  };
}
const client = createApiClient();
export const api = client.api;
export const setToken = client.setToken;
export const clearReadResponses = client.clearReadResponses;
export const invalidateAuthentication = client.invalidateAuthentication;

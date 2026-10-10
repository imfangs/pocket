import { holdReload, isReloadBlockingRequest } from "./updateSafety.ts";

let token = "";
export function setToken(value: string) {
  token = value;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options: { signal?: AbortSignal; raw?: boolean; contentType?: string } = {},
): Promise<T> {
  const release = isReloadBlockingRequest(path, method) ? holdReload() : () => {};
  try {
    const send = () =>
      fetch(path, {
        method,
        signal: options.signal,
        cache: "no-store",
        headers: {
          "Content-Type": options.contentType || "application/json",
          ...(method === "GET" ? {} : { "X-Navigator-Token": token }),
        },
        ...(body === undefined ? {} : { body: options.raw ? body as BodyInit : JSON.stringify(body) }),
      });
    let response = await send();
    let data = await response.json();
    if (response.status === 403 && data.error === "请求已过期，请刷新页面") {
      const fresh = await fetch("/api/catalog", { cache: "no-store", signal: options.signal });
      if (fresh.ok) {
        const catalog = await fresh.json();
        if (catalog.csrfToken) {
          token = catalog.csrfToken;
          response = await send();
          data = await response.json();
        }
      } else if (fresh.status === 401)
        window.dispatchEvent(new Event("navigator-auth-expired"));
    }
    if (response.status === 401)
      window.dispatchEvent(new Event("navigator-auth-expired"));
    if (!response.ok)
      throw Object.assign(new Error(data.error || "请求失败"), {
        status: response.status,
        ...(typeof data.code === "string" ? { code: data.code } : {}),
      });
    return data;
  } finally {
    release();
  }
}

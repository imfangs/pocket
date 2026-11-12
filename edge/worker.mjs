import { htmlPreviewShellPath, htmlPreviewShellAlias, interactiveHtmlPolicy } from "../shared/html-runtime-policy.mjs";

const defaultMachine = "local";
const publicEntryOrigin = null;
const validMachine = (id) => typeof id === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(id);
const validVerifier = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const machineCookie = (id) => id === defaultMachine ? "navigator_session" : `navigator_session_${id}`;
const json = (status, data, machineId = defaultMachine) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Pocket-Machine": validMachine(machineId) ? machineId : "invalid",
    },
  });
function machineConfig(env, machineId) {
  if (!validMachine(machineId)) return { status: 400, error: "Mac 标识无效" };
  if (machineId === defaultMachine)
    return { key: "origin", verifier: env.NAVIGATOR_REGISTRATION_SHA256 };
  let keys;
  try {
    keys = JSON.parse(env.NAVIGATOR_MACHINE_KEYS || "{}");
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new Error();
  } catch { return { status: 503, error: "Mac 连接配置暂时不可用" }; }
  if (!Object.hasOwn(keys, machineId)) return { status: 404, error: "未配置这台 Mac" };
  if (!validVerifier(keys[machineId])) return { status: 503, error: "Mac 连接配置暂时不可用" };
  return { key: `origin:${machineId}`, verifier: keys[machineId] };
}
function matchesVerifier(digest, expected) {
  const bytes = Uint8Array.from(expected.match(/../g), (pair) => parseInt(pair, 16));
  if (typeof crypto.subtle.timingSafeEqual === "function")
    return crypto.subtle.timingSafeEqual(digest, bytes);
  const actual = new Uint8Array(digest);
  let difference = 0;
  for (let i = 0; i < bytes.length; i++) difference |= actual[i] ^ bytes[i];
  return difference === 0;
}
function selectedCookie(request, machineId) {
  const name = machineCookie(machineId);
  const cookie = request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return cookie === undefined ? null : `navigator_session=${cookie.slice(name.length + 1)}`;
}
function responseHeaders(response, machineId) {
  const headers = new Headers(response.headers);
  // Workers exposes getAll for Set-Cookie; newer runtimes also have getSetCookie.
  // Never split on commas: Expires contains one too.
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie() : response.headers.getAll("Set-Cookie");
  headers.delete("Set-Cookie");
  for (const cookie of cookies) {
    if (cookie.startsWith("navigator_session="))
      headers.append("Set-Cookie", machineCookie(machineId) + cookie.slice("navigator_session".length));
  }
  headers.set("Cache-Control", "no-store");
  headers.set("X-Navigator-Relay", "stable-v1");
  headers.set("X-Pocket-Machine", machineId);
  headers.delete("Access-Control-Allow-Origin");
  return headers;
}
async function fetchVideo(target, options, clientSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(clientSignal?.reason);
  const deadline = setTimeout(() => controller.abort(), 20000);
  clientSignal?.addEventListener("abort", abort, { once: true });
  if (clientSignal?.aborted) abort();
  const cleanup = () => { clearTimeout(deadline); clientSignal?.removeEventListener("abort", abort); };
  let response;
  try { response = await fetch(target, { ...options, signal: controller.signal }); }
  catch (error) { cleanup(); throw error; }
  // Bound connection/header waiting, not playback duration. A timeout left
  // attached to fetch would also cut off a healthy long-running video body.
  clearTimeout(deadline);
  if (!response.body) { cleanup(); return response; }
  const reader = response.body.getReader();
  let finished = false;
  const release = () => { cleanup(); try { reader.releaseLock(); } catch {} };
  const body = new ReadableStream({
    async pull(output) {
      try {
        const { value, done } = await reader.read();
        if (finished) return;
        if (done) { finished = true; release(); output.close(); }
        else output.enqueue(value);
      } catch (error) {
        if (!finished) { finished = true; controller.abort(); release(); output.error(error); }
      }
    },
    async cancel(reason) {
      finished = true; controller.abort(reason);
      try { await reader.cancel(reason); } finally { release(); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
async function registerConnection(request, env, url) {
  // Each credential renews only its own Mac route, never another machine or a user session.
  if (request.method !== "POST") return json(405, { error: "不支持的方法" });
  if (request.headers.has("Origin") || request.headers.get("Sec-Fetch-Site") === "cross-site")
    return json(403, { error: "登记接口仅供 Mac 连接器使用" });
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    return json(415, { error: "需要 JSON 请求" });
  let machineId = defaultMachine;
  try {
    const reader = request.body?.getReader();
    if (!reader) return json(400, { error: "缺少登记信息" });
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        return json(413, { error: "登记信息过大" });
      }
      chunks.push(value);
    }
    const input = JSON.parse(await new Blob(chunks).text());
    if (!input || typeof input !== "object" || Array.isArray(input))
      return json(400, { error: "登记信息无效" });
    machineId = input.machineId === undefined ? defaultMachine : input.machineId;
    const config = machineConfig(env, machineId);
    if (config.error) return json(config.status, { error: config.error }, machineId);
    if (!validVerifier(config.verifier)) return json(503, { error: "连接登记尚未配置" }, machineId);
    const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) return json(401, { error: "登记凭据无效" }, machineId);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    if (!matchesVerifier(digest, config.verifier)) return json(401, { error: "登记凭据无效" }, machineId);
    const upstream = new URL(input.publicOrigin);
    if (input.connected !== true || upstream.protocol !== "https:" ||
        !/^[a-z0-9-]+\.trycloudflare\.com$/.test(upstream.hostname) ||
        upstream.username || upstream.password || upstream.port ||
        upstream.pathname !== "/" || upstream.search || upstream.hash)
      return json(400, { error: "接入地址无效" }, machineId);
    const now = Date.now();
    const record = { machineId, publicOrigin: upstream.origin, connected: true, updatedAt: new Date(now).toISOString() };
    await env.NAVIGATOR_CONNECTION.put(config.key, JSON.stringify(record), { expirationTtl: 1800 });
    return json(200, { ok: true, machineId, entryOrigin: url.origin, publicOrigin: upstream.origin,
      publishedAt: record.updatedAt, expiresAt: new Date(now + 1800000).toISOString() }, machineId);
  } catch (e) {
    if (e instanceof SyntaxError || e instanceof TypeError)
      return json(400, { error: "登记信息无效" }, machineId);
    return json(503, { error: "登记服务暂时不可用" }, machineId);
  }
}

export async function serveHtmlPreviewShell(request, env) {
  const url = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
  if (url.search) return new Response(null, { status: 400, headers: { "Cache-Control": "no-store" } });
  let response = await env.ASSETS.fetch(request);
  // Pages may canonicalize .html to an extensionless URL. Follow only this
  // same-origin shell alias inside the Worker, retaining the isolated policy.
  if ([301, 302, 307, 308].includes(response.status)) {
    const target = new URL(response.headers.get("Location") || "", url);
    if (target.origin !== url.origin || target.pathname !== htmlPreviewShellAlias || target.search || target.hash)
      return new Response(null, { status: 502, headers: { "Cache-Control": "no-store" } });
    response = await env.ASSETS.fetch(new Request(target, { method: request.method }));
  }
  const headers = new Headers(response.headers);
  // Setting replaces the global _headers policy: appending would intersect it
  // with script-src 'self' and prevent the preview's inline scripts.
  headers.set("Content-Security-Policy", interactiveHtmlPolicy);
  headers.delete("Content-Security-Policy-Report-Only");
  headers.delete("X-Frame-Options");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ([htmlPreviewShellPath, htmlPreviewShellAlias].includes(url.pathname)) return serveHtmlPreviewShell(request, env);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const explicit = url.pathname === "/api/machines" || url.pathname.startsWith("/api/machines/");
    const route = explicit ? url.pathname.match(/^\/api\/machines\/([^/]+)(\/.*)$/) : null;
    const machineId = explicit ? route?.[1] || url.pathname.split("/")[3] || "invalid" : defaultMachine;
    const error = (status, message, code = "relay_not_forwarded") => json(status, { error: message, code }, machineId);
    const configuredEntry = env.NAVIGATOR_PUBLIC_ORIGIN || publicEntryOrigin;
    if (configuredEntry ? url.origin !== configuredEntry : !url.hostname.endsWith(".pages.dev"))
      return error(403, "不允许的入口");
    if (url.pathname === "/api/relay/register")
      return registerConnection(request, env, url);
    if (explicit && (!route || !validMachine(machineId))) return error(400, "Mac 路径无效");
    const config = machineConfig(env, machineId);
    if (config.error) return error(config.status, config.error);
    const pathname = explicit ? `/api${route[2]}` : url.pathname;
    const feedbackHook = request.method === "POST" && /^\/api\/feedback\/(?:webhook|relay\/[a-z][a-z0-9-]{0,31}|relay-status\/[a-z][a-z0-9-]{0,31})$/.test(pathname);
    const origin = request.headers.get("Origin");
    if (
      (origin && origin !== url.origin) ||
      request.headers.get("Sec-Fetch-Site") === "cross-site"
    )
      return error(403, "拒绝跨站请求");
    if (feedbackHook && (origin || !["webhook-id", "webhook-timestamp", "webhook-signature"].every(key => request.headers.get(key)?.length > 0)))
      return error(401, "反馈签名缺失");
    if (!feedbackHook && !["GET", "HEAD"].includes(request.method) && origin !== url.origin)
      return error(403, "缺少同源请求信息");
    let forwarded = false;
    try {
      const connection = await env.NAVIGATOR_CONNECTION.get(config.key, {
        type: "json",
        cacheTtl: 60,
      });
      if (!connection?.connected || !connection.publicOrigin)
        return error(503, "Mac 暂时离线，请稍后重新连接");
      if (connection.machineId !== undefined && connection.machineId !== machineId)
        return error(503, "Mac 连接信息不匹配");
      const upstream = new URL(connection.publicOrigin);
      if (
        upstream.protocol !== "https:" ||
        !/^[a-z0-9-]+\.trycloudflare\.com$/.test(upstream.hostname) ||
        upstream.port ||
        upstream.username ||
        upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash
      )
        return error(503, "Mac 接入地址不可用");
      const headers = new Headers();
      // The deployed Worker is a standalone copied file. Keep this narrow
      // route allowlist aligned with shared/read-response.mjs (covered by QA).
      const conditionalRead = request.method === "GET" && (pathname === "/api/catalog" ||
        /^\/api\/tasks\/[a-f0-9-]{36}\/(?:transcript|history)$/i.test(pathname));
      const conditionalSync = request.method === "POST" && pathname === "/api/sync";
      const videoRead = ["GET", "HEAD"].includes(request.method) && (url.searchParams.get("video") === "1" &&
        /^\/api\/tasks\/[a-f0-9-]{36}\/files\/[a-f0-9]{64}$/i.test(pathname) ||
        /^\/api\/tasks\/[a-f0-9-]{36}\/files\/[a-f0-9]{64}\/audio$/i.test(pathname));
      for (const key of [
        "Content-Type",
        ...(feedbackHook ? ["webhook-id", "webhook-timestamp", "webhook-signature"] : ["X-Navigator-Token"]),
        "Accept",
        ...(conditionalRead ? ["If-None-Match"] : []),
        ...(conditionalSync ? ["X-Pocket-Read-Version"] : []),
        ...(videoRead ? ["Range", "If-Range"] : []),
      ])
        if (request.headers.has(key))
          headers.set(key, request.headers.get(key));
      // Optional diagnostic metadata, never an authentication or compatibility gate.
      const clientVersion = request.headers.get("X-Pocket-Client-Version");
      if (!feedbackHook && clientVersion && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,159}$/.test(clientVersion))
        headers.set("X-Pocket-Client-Version", clientVersion);
      const cookie = feedbackHook ? null : selectedCookie(request, machineId);
      if (cookie !== null) headers.set("Cookie", cookie);
      if (origin) headers.set("Origin", upstream.origin);
      const target = new URL(pathname + url.search, upstream.origin);
      const uploading = request.method === "PUT" &&
        /^\/api\/tasks\/[a-f0-9-]{36}\/attachments\/[a-f0-9-]{36}$/i.test(pathname);
      const readingHistoryPage = request.method === "GET" && /^\/api\/tasks\/[a-f0-9-]{36}\/transcript-page$/i.test(pathname);
      const timeout = videoRead ? null : AbortSignal.timeout(uploading ? 180000 : readingHistoryPage ? 45000 : 20000);
      // A reader leaving the page withdraws its own GET. Writes keep their
      // original outcome/timeout contract: disconnect is never non-delivery.
      const readSignal = ["GET", "HEAD"].includes(request.method) && request.signal;
      // Once fetch starts, a lost reply cannot prove the Mac did not execute.
      forwarded = true;
      const upstreamOptions = {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : request.body,
        redirect: "manual",
        ...(videoRead ? {} : { signal: readSignal ? AbortSignal.any([timeout, readSignal]) : timeout }),
      };
      const response = videoRead ? await fetchVideo(target, upstreamOptions, request.signal) : await fetch(target, upstreamOptions);
      const upstreamMachine = response.headers.get("X-Pocket-Machine");
      if (upstreamMachine !== machineId && (machineId !== defaultMachine || upstreamMachine !== null)) {
        if (videoRead) await response.body?.cancel().catch(() => {});
        return error(503, "Mac 连接身份不匹配，请重新连接", "relay_unavailable");
      }
      if (
        response.status >= 500 ||
        (response.status >= 300 && response.status < 400 && !(conditionalRead && response.status === 304))
      ) {
        if (videoRead) await response.body?.cancel().catch(() => {});
        return error(503, "Mac 暂时不可达，请稍后重试", "relay_unavailable");
      }
      return new Response(response.body, { status: response.status, statusText: response.statusText,
        headers: responseHeaders(response, machineId) });
    } catch {
      return error(503, "暂时无法连接 Mac，请稍后重试", forwarded ? "relay_unavailable" : "relay_not_forwarded");
    }
  },
};

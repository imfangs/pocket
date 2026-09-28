const json = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
async function registerConnection(request, env, url) {
  // This credential renews only this project's Mac route, never a user session.
  if (request.method !== "POST") return json(405, { error: "不支持的方法" });
  if (request.headers.has("Origin") || request.headers.get("Sec-Fetch-Site") === "cross-site")
    return json(403, { error: "登记接口仅供 Mac 连接器使用" });
  const expected = env.NAVIGATOR_REGISTRATION_SHA256;
  if (!/^[a-f0-9]{64}$/.test(expected || ""))
    return json(503, { error: "连接登记尚未配置" });
  const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) return json(401, { error: "登记凭据无效" });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  if (actual !== expected) return json(401, { error: "登记凭据无效" });
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    return json(415, { error: "需要 JSON 请求" });
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
    const upstream = new URL(input.publicOrigin);
    if (input.connected !== true || upstream.protocol !== "https:" ||
        !/^[a-z0-9-]+\.trycloudflare\.com$/.test(upstream.hostname) ||
        upstream.username || upstream.password || upstream.port ||
        upstream.pathname !== "/" || upstream.search || upstream.hash)
      return json(400, { error: "接入地址无效" });
    const now = Date.now();
    const record = { publicOrigin: upstream.origin, connected: true, updatedAt: new Date(now).toISOString() };
    await env.NAVIGATOR_CONNECTION.put("origin", JSON.stringify(record), { expirationTtl: 900 });
    return json(200, { ok: true, entryOrigin: url.origin, publicOrigin: upstream.origin,
      publishedAt: record.updatedAt, expiresAt: new Date(now + 900000).toISOString() });
  } catch (e) {
    if (e instanceof SyntaxError || e instanceof TypeError)
      return json(400, { error: "登记信息无效" });
    return json(503, { error: "登记服务暂时不可用" });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.hostname !== "x.fangs.cc" && !url.hostname.endsWith(".pages.dev"))
      return json(403, { error: "不允许的入口" });
    if (url.pathname === "/api/relay/register")
      return registerConnection(request, env, url);
    const origin = request.headers.get("Origin");
    if (
      (origin && origin !== url.origin) ||
      request.headers.get("Sec-Fetch-Site") === "cross-site"
    )
      return json(403, { error: "拒绝跨站请求" });
    if (!["GET", "HEAD"].includes(request.method) && origin !== url.origin)
      return json(403, { error: "缺少同源请求信息" });
    try {
      const connection = await env.NAVIGATOR_CONNECTION.get("origin", {
        type: "json",
        cacheTtl: 60,
      });
      if (!connection?.connected || !connection.publicOrigin)
        return json(503, { error: "Mac 暂时离线，请稍后重新连接" });
      const upstream = new URL(connection.publicOrigin);
      if (
        upstream.protocol !== "https:" ||
        !upstream.hostname.endsWith(".trycloudflare.com") ||
        upstream.port ||
        upstream.username ||
        upstream.password
      )
        return json(503, { error: "Mac 接入地址不可用" });
      const headers = new Headers();
      for (const key of [
        "Content-Type",
        "Cookie",
        "X-Navigator-Token",
        "Accept",
      ])
        if (request.headers.has(key))
          headers.set(key, request.headers.get(key));
      if (origin) headers.set("Origin", upstream.origin);
      const target = new URL(url.pathname + url.search, upstream.origin);
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method)
          ? undefined
          : request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
      if (
        response.status >= 500 ||
        (response.status >= 300 && response.status < 400)
      )
        return json(503, { error: "Mac 暂时不可达，请稍后重试" });
      const out = new Response(response.body, response);
      out.headers.set("Cache-Control", "no-store");
      out.headers.set("X-Navigator-Relay", "stable-v1");
      out.headers.delete("Access-Control-Allow-Origin");
      return out;
    } catch {
      return json(503, { error: "暂时无法连接 Mac，请稍后重试" });
    }
  },
};

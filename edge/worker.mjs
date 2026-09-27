const json = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.hostname !== "x.fangs.cc" && !url.hostname.endsWith(".pages.dev"))
      return json(403, { error: "不允许的入口" });
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

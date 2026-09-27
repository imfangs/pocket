import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NavigatorStore, AppError } from "./store.mjs";
import { readCodexSource } from "./source.mjs";

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const safeEqual = (a, b) =>
  typeof a === "string" &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function makeApp(options = {}) {
  const store = new NavigatorStore(
    options.dataDir ||
      process.env.NAVIGATOR_DATA_DIR ||
      join(homedir(), "Library/Application Support/CodexNavigator"),
  );
  const codexHome =
    options.codexHome ||
    process.env.NAVIGATOR_CODEX_HOME ||
    join(homedir(), ".codex");
  const readSource = options.readSource || (() => readCodexSource(codexHome));
  const openThread =
    options.openThread ||
    ((id) =>
      exec("/usr/bin/open", [`codex://threads/${id}`], { timeout: 10000 }));
  const csrf = randomBytes(24).toString("hex");
  const hosts = new Set(
    options.hosts || ["127.0.0.1", "localhost", "[::1]", "threads.local"],
  );
  const dist = options.dist || join(root, "dist");
  function sync() {
    try {
      const data = readSource();
      store.sync(data);
      return data.sourceInfo;
    } catch (e) {
      store.failSync(e);
      throw e;
    }
  }
  try {
    sync();
  } catch {
    /* Keep the last successful catalog available. */
  }
  const interval = setInterval(() => {
    try {
      sync();
    } catch {}
  }, 45000);
  interval.unref();
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    if (
      !String(req.headers["content-type"] || "").startsWith("application/json")
    )
      throw new AppError("需要 JSON 请求", 415);
    const chunks = [];
    let n = 0;
    for await (const chunk of req) {
      n += chunk.length;
      if (n > 4 * 1024 * 1024) throw new AppError("请求过大", 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AppError("JSON 格式不正确");
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = req.headers.host;
      if (!host || !/^([a-z0-9.-]+|\[::1\])(:\d+)?$/i.test(host))
        throw new AppError("不允许的 Host", 403);
      const url = new URL(req.url, `http://${host}`);
      if (!hosts.has(url.hostname)) throw new AppError("不允许的 Host", 403);
      const forwarded = req.headers["x-forwarded-proto"];
      if (forwarded && !["http", "https"].includes(forwarded))
        throw new AppError("无效的转发协议", 403);
      const origin = `${forwarded || "http"}://${host}`;
      if (req.headers.origin && req.headers.origin !== origin)
        throw new AppError("拒绝跨站请求", 403);
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw new AppError("拒绝跨站请求", 403);
      const path = url.pathname,
        method = req.method;
      if (!["GET", "HEAD"].includes(method)) {
        if (
          req.headers.origin !== origin ||
          !safeEqual(req.headers["x-navigator-token"], csrf)
        )
          throw new AppError("请求已过期，请刷新页面", 403);
      }
      if (method === "GET" && path === "/api/health")
        return json(res, 200, {
          ok: true,
          app: "codex-navigator",
          sourceReady: !!store.setting("sourceInfo"),
          sourceError: !!store.lastError,
        });
      if (method === "GET" && path === "/api/catalog")
        return json(res, 200, { ...store.catalog(), csrfToken: csrf });
      if (method === "POST" && path === "/api/sync") {
        sync();
        return json(res, 200, store.catalog());
      }
      if (method === "GET" && path === "/api/export") {
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="codex-navigator-${new Date().toISOString().slice(0, 10)}.json"`,
        );
        return json(res, 200, store.export());
      }
      if (method === "POST" && path === "/api/import") {
        store.restore(await body(req));
        return json(res, 200, store.catalog());
      }
      if (method === "POST" && path === "/api/batch") {
        const b = await body(req);
        return json(res, 200, store.batch(b.ids, b.change));
      }
      const task = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)$/);
      if (task && method === "PATCH")
        return json(res, 200, store.patchThread(task[1], await body(req)));
      const open = path.match(/^\/api\/open\/([a-f0-9-]{36})$/i);
      if (open && method === "POST") {
        const t = store.thread(open[1]);
        if (t.missing)
          throw new AppError("来源中已找不到这条会话，请先同步", 409);
        await openThread(t.id);
        const updated = store.recordOpen(t.id);
        return json(res, 200, { status: "handoff_requested", thread: updated });
      }
      if (method === "POST" && path === "/api/groups")
        return json(res, 201, store.saveGroup(await body(req)));
      const group = path.match(/^\/api\/groups\/([a-f0-9-]{36})$/i);
      if (group && method === "PATCH")
        return json(res, 200, store.saveGroup(await body(req), group[1]));
      if (group && method === "DELETE") {
        store.deleteGroup(group[1]);
        return json(res, 200, { ok: true });
      }
      if (path.startsWith("/api/")) throw new AppError("接口不存在", 404);
      if (method !== "GET" && method !== "HEAD")
        throw new AppError("不支持的方法", 405);
      let file = resolve(dist, "." + decodeURIComponent(path));
      if (!file.startsWith(dist + "/") && file !== dist)
        throw new AppError("无效路径", 403);
      if (path === "/" || !extname(path)) file = join(dist, "index.html");
      if (!existsSync(file))
        throw new AppError("页面不存在，请先构建项目", 404);
      const content = readFileSync(file);
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
      });
      res.end(method === "HEAD" ? undefined : content);
    } catch (e) {
      json(res, e.status || 500, {
        error: e.status ? e.message : "操作未完成，请刷新后重试",
        ...(e.status ? {} : { detail: String(e.message).slice(0, 250) }),
      });
    }
  });
  const close = () => {
    clearInterval(interval);
    store.close();
  };
  server.on("close", close);
  return { server, store, sync };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { server } = makeApp();
  const port = Number(process.env.PORT || 4397);
  server.listen(port, "127.0.0.1", () =>
    console.log(`Codex Navigator ready on loopback port ${port}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => server.close(() => process.exit(0)));
}

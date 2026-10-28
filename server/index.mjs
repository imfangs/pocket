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
import { AccessControl, readConnection } from "./auth.mjs";
import { DesktopService } from "./desktop.mjs";
import { ReadStateService } from "./read-state.mjs";
import { PocketContentService, POCKET_CONTENT } from "./pocket-content.mjs";
import { HistoryPageReader } from "./history.mjs";
import { ThreadAutomations } from "./thread-automations.mjs";
import { LifecycleService } from "./lifecycle.mjs";
import { RenameService } from "./rename.mjs";
import { TaskStatusService } from "./task-statuses.mjs";
import { Notifications } from "./notifications.mjs";
import { sendCatalog } from "./catalog-response.mjs";
import { MessageImages } from "./message-images.mjs";
import { MessageFiles } from "./message-files.mjs";
import { dispatchResponse } from "./dispatch-response.mjs";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};
const safeEqual = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function makeApp(options = {}) {
  const machineId = options.machineId ?? process.env.NAVIGATOR_MACHINE_ID ?? "ged";
  if (typeof machineId !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(machineId)) throw new Error("Invalid Pocket machine ID");
  const store = new NavigatorStore(
    options.dataDir ||
      process.env.NAVIGATOR_DATA_DIR ||
      join(homedir(), "Library/Application Support/CodexNavigator"),
  );
  const codexHome =
    options.codexHome ||
    process.env.NAVIGATOR_CODEX_HOME ||
    join(homedir(), ".codex");
  const auth = new AccessControl(store.directory, store.db);
  const openThread =
    options.openThread ||
    ((id) =>
      exec("/usr/bin/open", [`codex://threads/${id}`], { timeout: 10000 }));
  const desktop = new DesktopService(
    store,
    codexHome,
    options.desktopRequest,
    options.readHistory,
    { openThread, connectionTimeoutMs: options.connectionTimeoutMs, connectionPollMs: options.connectionPollMs, attachmentOptions: options.attachments },
  );
  const readState = new ReadStateService(store, codexHome, options.readState);
  const pocketContent = new PocketContentService(store, codexHome, options.pocketContent);
  const historyPages = options.historyPages || new HistoryPageReader(options.historyPageOptions);
  const automations = new ThreadAutomations(codexHome, options.automations);
  const catalog = () => automations.enrich(pocketContent.catalog(store.catalog()));
  const notifications = new Notifications(store, desktop, { ...options.notifications, machineId });
  const images = new MessageImages();
  const files = new MessageFiles();
  desktop.onAccepted = (id, turnId) => {
    try { notifications.followSubmission(id, turnId); }
    catch { /* Notification bookkeeping must not change an accepted send receipt. */ }
  };
  const readSource = options.readSource || (() => readCodexSource(codexHome));
  const lifecycle = new LifecycleService(store, desktop, codexHome, sync, options.lifecycle);
  const rename = new RenameService(store, codexHome, sync, {
    ...options.rename, lifecycleBlocked: id => lifecycle.blocked.has(id) || desktop.models.pending(id),
  });
  desktop.renamePending = id => !!rename.active(id);
  lifecycle.renamePending = id => !!rename.active(id);
  lifecycle.modelPending = id => desktop.models.pending(id);
  desktop.onModelChanged = () => { try { sync(); } catch { /* Keep the last source snapshot on a read failure. */ } };
  const taskStatuses = new TaskStatusService({ codexHome, threads: () => store.catalog().threads,
    excluded: () => lifecycle.blocked, ...options.taskStatuses });
  lifecycle.onBlockedChange = () => taskStatuses.invalidate();
  const csrf = randomBytes(24).toString("hex");
  const hosts = new Set(
    options.hosts || ["127.0.0.1", "localhost", "[::1]", "threads.local"],
  );
  const dist = options.dist || join(root, "dist");
  function sync() {
    try {
      const data = pocketContent.source(readSource());
      store.sync(data);
      return data.sourceInfo;
    } catch (e) {
      pocketContent.sourceUnavailable();
      store.failSync(e);
      throw e;
    }
  }
  let readingSync;
  function syncForClient() {
    if (!readingSync) {
      readingSync = (async () => {
        sync();
        const wait = pocketContent.readConfirmationDelay();
        if (wait !== null) { await delay(wait); sync(); }
      })().finally(() => { readingSync = null; });
    }
    return readingSync;
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
  const replyToSend = async (res, threadId, requestId, operation) => {
    const result = await dispatchResponse(operation, () => desktop.getReceipt(threadId, requestId), options.dispatchReplyWaitMs ?? 1000);
    return json(res, result.status, result.data);
  };
  async function body(req, maxBytes = 4 * 1024 * 1024, allowEmpty = false) {
    const isJson = String(req.headers["content-type"] || "").startsWith("application/json");
    if (!isJson && !allowEmpty)
      throw new AppError("需要 JSON 请求", 415);
    const chunks = [];
    let n = 0;
    for await (const chunk of req) {
      n += chunk.length;
      if (n > maxBytes) throw new AppError("请求过大", 413);
      chunks.push(chunk);
    }
    if (allowEmpty && n === 0) return {};
    if (!isJson) throw new AppError("需要 JSON 请求", 415);
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AppError("JSON 格式不正确");
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Pocket-Machine", machineId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = req.headers.host;
      if (!host || !/^([a-z0-9.-]+|\[::1\])(:\d+)?$/i.test(host))
        throw new AppError("不允许的 Host", 403);
      const url = new URL(req.url, `http://${host}`);
      const connection = options.connection || readConnection(store.directory);
      const publicHost = connection.publicOrigin
        ? new URL(connection.publicOrigin).hostname
        : null;
      if (!hosts.has(url.hostname) && url.hostname !== publicHost)
        throw new AppError("不允许的 Host", 403);
      const forwarded = req.headers["x-forwarded-proto"];
      if (forwarded && !["http", "https"].includes(forwarded))
        throw new AppError("无效的转发协议", 403);
      const origin = `${forwarded || "http"}://${host}`;
      const protectedRequest =
        url.pathname.startsWith("/api/") ||
        !["GET", "HEAD"].includes(req.method);
      if (
        protectedRequest &&
        req.headers.origin &&
        req.headers.origin !== origin
      )
        throw new AppError("拒绝跨站请求", 403);
      if (protectedRequest && req.headers["sec-fetch-site"] === "cross-site")
        throw new AppError("拒绝跨站请求", 403);
      const path = url.pathname,
        method = req.method;
      const authAction =
        path === "/api/auth/login" || path === "/api/auth/logout";
      if (!["GET", "HEAD"].includes(method)) {
        if (
          req.headers.origin !== origin ||
          (!authAction && !safeEqual(req.headers["x-navigator-token"], csrf))
        )
          throw new AppError("请求已过期，请刷新页面", 403);
      }
      if (method === "GET" && path === "/api/health")
        return json(res, 200, {
          ok: true,
          app: "codex-navigator",
          machineId,
        });
      const localBearerAllowed =
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        !req.headers["cf-connecting-ip"] &&
        !forwarded;
      if (method === "GET" && path === "/api/auth/status")
        return json(res, 200, {
          authenticated: auth.authenticate(req, localBearerAllowed),
        });
      if (method === "POST" && path === "/api/auth/login") {
        const input = await body(req, 2048);
        const cfIp =
          url.hostname === publicHost ? req.headers["cf-connecting-ip"] : null;
        const ip =
          typeof cfIp === "string" && isIP(cfIp)
            ? cfIp
            : req.socket.remoteAddress;
        const result = auth.login(input?.passphrase, ip);
        res.setHeader(
          "Set-Cookie",
          auth.cookie(result.token, origin.startsWith("https:")),
        );
        return json(res, 200, {
          authenticated: true,
          expiresAt: result.expiresAt,
        });
      }
      if (method === "POST" && path === "/api/auth/logout") {
        auth.logout(req);
        res.setHeader(
          "Set-Cookie",
          auth.cookie("", origin.startsWith("https:")),
        );
        return json(res, 200, { authenticated: false });
      }
      if (
        path.startsWith("/api/") &&
        !auth.authenticate(req, localBearerAllowed)
      )
        throw new AppError("请先输入口令", 401);
      if (method === "GET" && path === "/api/connection")
        return json(res, 200, connection);
      if (method === "GET" && path === "/api/catalog")
        return sendCatalog(res, { ...catalog(), csrfToken: csrf }, req.headers["accept-encoding"], { path, method, machineId, headers: req.headers });
      if (method === "GET" && path === "/api/task-statuses")
        return json(res, 200, await taskStatuses.snapshot({ priorityThreadIds: url.searchParams.get("priorityThreadIds") }));
      if (method === "GET" && path === "/api/tasks/create-options")
        return json(res, 200, lifecycle.options());
      if (method === "POST" && path === "/api/tasks") {
        const result = lifecycle.startCreate(await body(req, 70000));
        return json(res, result.status === "pending" ? 202 : 200, result);
      }
      if (method === "GET" && path === "/api/task-operations")
        return json(res, 200, lifecycle.list());
      const lifecycleOperation = path.match(/^\/api\/task-operations\/([a-f0-9-]{36})(\/cancel)?$/i);
      if (lifecycleOperation && method === "GET" && !lifecycleOperation[2])
        return json(res, 200, await lifecycle.get(lifecycleOperation[1]));
      if (lifecycleOperation && method === "POST" && lifecycleOperation[2])
        return json(res, 200, await lifecycle.cancel(lifecycleOperation[1]));
      const archiveThread = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/archive$/i);
      if (archiveThread && method === "POST") {
        const result = lifecycle.startArchive(archiveThread[1], await body(req, 2048));
        return json(res, result.status === "pending" ? 202 : 200, result);
      }
      const taskName = path.match(/^\/api\/tasks\/([^/]+)\/name(?:\/([^/]+))?$/);
      if (taskName && method === "GET")
        return json(res, 200, taskName[2]
          ? await rename.get(taskName[1], taskName[2])
          : await rename.inspect(taskName[1]));
      if (taskName && method === "POST" && !taskName[2]) {
        const result = rename.start(taskName[1], await body(req, 8192));
        return json(res, result.status === "pending" ? 202 : 200, result);
      }
      const modelSettings = path.match(/^\/api\/tasks\/([^/]+)\/model-settings(?:\/([^/]+))?$/);
      if (modelSettings && method === "GET")
        return json(res, 200, modelSettings[2]
          ? await desktop.models.get(modelSettings[1], modelSettings[2])
          : await desktop.models.read(modelSettings[1]));
      if (modelSettings && method === "POST" && !modelSettings[2]) {
        const result = desktop.models.start(modelSettings[1], await body(req, 2048));
        return json(res, result.status === "pending" ? 202 : 200, result);
      }
      if (method === "GET" && path === "/api/notifications")
        return json(res, 200, notifications.config());
      if (path === "/api/notifications/subscription" && method === "POST")
        return json(res, 200, notifications.subscribe(await body(req, 4096)));
      if (path === "/api/notifications/subscription" && method === "DELETE")
        return json(res, 200, notifications.unsubscribe((await body(req, 4096)).endpoint));
      if (path === "/api/notifications/state" && method === "POST")
        return json(res, 200, notifications.subscriptionState((await body(req, 4096)).endpoint));
      if (method === "POST" && path === "/api/sync") {
        await syncForClient();
        return sendCatalog(res, catalog(), req.headers["accept-encoding"], { path, method, machineId, headers: req.headers });
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
        return json(res, 200, catalog());
      }
      if (method === "POST" && path === "/api/batch") {
        const b = await body(req);
        return json(res, 200, store.batch(b.ids, b.change));
      }
      const task = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)$/);
      const attachment = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/attachments(?:\/([a-f0-9-]{36}))?$/i);
      if (attachment) {
        const [, threadId, uploadId] = attachment;
        if (method === "GET" && !uploadId)
          return json(res, 200, desktop.attachments.list(threadId));
        if (method === "PUT" && uploadId) {
          if ([...url.searchParams.keys()].some(key => key !== "name")) throw new AppError("附件参数无效");
          if (Number(req.headers["content-length"]) > desktop.attachments.maxBytes) throw new AppError("每个附件最多 20 MiB", 413);
          req.setTimeout(120000, () => req.destroy());
          return json(res, 200, await desktop.attachments.upload(threadId, uploadId, url.searchParams.get("name"), req.headers["content-type"], req));
        }
        if (method === "DELETE" && uploadId)
          return json(res, 200, desktop.attachments.remove(threadId, uploadId));
        if (method === "GET" && uploadId) {
          if (url.searchParams.get("metadata") === "1")
            return json(res, 200, desktop.attachments.metadata(threadId, uploadId));
          const data = await desktop.attachments.read(threadId, uploadId, url.searchParams.get("preview") === "1");
          res.writeHead(200, {
            "Content-Type": data.mime, "Content-Length": data.bytes.length,
            "Content-Disposition": `${data.kind === "image" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(data.name)}`,
            "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; sandbox",
          });
          return res.end(data.bytes);
        }
      }
      const taskPin = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/pin$/);
      if (taskPin && method === "POST")
        return json(res, 200, store.setPin(taskPin[1], await body(req, 2048)));
      const taskPriority = path.match(/^\/api\/tasks\/([a-zA-Z0-9-]+)\/priority$/);
      if (taskPriority && method === "POST")
        return json(res, 200, store.setPriority(taskPriority[1], await body(req, 2048)));
      const taskConnection = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/connection$/i);
      if (taskConnection && method === "GET")
        return json(res, 200, desktop.connection(taskConnection[1]));
      const threadAutomations = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/automations$/i);
      if (threadAutomations && method === "GET") {
        store.thread(threadAutomations[1]);
        return json(res, 200, automations.details(threadAutomations[1]));
      }
      const history = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/history$/i);
      if (history && method === "GET") {
        const start = performance.now();
        const data = await desktop.history(history[1]);
        notifications.watch(history[1], data);
        res.setHeader("Server-Timing", `desktop_history;dur=${(performance.now() - start).toFixed(1)}`);
        const thread = store.thread(history[1]);
        return sendCatalog(res, files.attach(thread, images.attach(thread, data)), req.headers["accept-encoding"], { path, method, machineId, headers: req.headers });
      }
      const historyPage = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/transcript-page$/i);
      if (historyPage && method === "GET") {
        const start = performance.now(), id = historyPage[1];
        const thread = store.thread(id);
        if ([...url.searchParams.keys()].some(key => !["before", "limit"].includes(key)) ||
            url.searchParams.getAll("before").length > 1 || url.searchParams.getAll("limit").length > 1)
          throw new AppError("历史分页参数无效", 400);
        const rawLimit = url.searchParams.get("limit");
        if (rawLimit !== null && !/^(?:[1-9]|[1-7]\d|80)$/.test(rawLimit)) throw new AppError("历史分页条数无效", 400);
        const data = await historyPages.read(codexHome, id, {
          before: url.searchParams.get("before"), limit: rawLimit === null ? 80 : Number(rawLimit),
        });
        res.setHeader("Server-Timing", `history_page;dur=${(performance.now() - start).toFixed(1)}`);
        // Historical pages are display-only. Do not mint read observations or
        // pass these messages into the live history/receipt controllers.
        return sendCatalog(res, files.attach(thread, images.attach(thread, data)), req.headers["accept-encoding"]);
      }
      const transcript = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/transcript$/i);
      if (transcript && method === "GET") {
        const start = performance.now();
        const thread = store.thread(transcript[1]);
        let observed;
        try {
          observed = readState.observeTranscript(transcript[1], () => pocketContent.transcript(transcript[1], desktop.transcript(transcript[1])));
        }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          const recent = await historyPages.recent(codexHome, transcript[1]);
          const saved = desktop.attachments.enrich(transcript[1], { source: "rollout", messages: recent.messages,
            hasMore: !!recent.hasMore, turnTiming: recent.turnTiming || null, checkedAt: Date.now(),
            [POCKET_CONTENT]: recent[POCKET_CONTENT] });
          // This source was read asynchronously. A later native before/after
          // pair cannot authorize marking a newer desktop snapshot as read.
          observed = { ...pocketContent.transcript(transcript[1], saved), readObservation: null };
        }
        const data = files.attach(thread, images.attach(thread, observed));
        res.setHeader("Server-Timing", `transcript;dur=${(performance.now() - start).toFixed(1)}`);
        return sendCatalog(res, data, req.headers["accept-encoding"], { path, method, machineId, headers: req.headers });
      }
      const markRead = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/read$/i);
      if (markRead && method === "POST") {
        const result = await readState.markRead(markRead[1], await body(req, 2048));
        if (result.status === "read") {
          sync();
          return json(res, 200, { ...result, thread: store.thread(markRead[1]) });
        }
        return json(res, 200, result);
      }
      const image = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/images\/([a-f0-9]{64})$/i);
      if (image && method === "GET") {
        const data = await images.read(store.thread(image[1]), image[2]);
        res.writeHead(200, {
          "Content-Type": data.type,
          "Content-Length": data.bytes.length,
          "Content-Disposition": "inline",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        return res.end(data.bytes);
      }
      const messageFile = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/files\/([a-f0-9]{64})$/i);
      if (messageFile && method === "GET") {
        const data = await files.read(store.thread(messageFile[1]), messageFile[2]);
        res.writeHead(200, {
          "Content-Type": data.type,
          "Content-Length": data.bytes.length,
          "Content-Disposition": data.disposition,
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        });
        return res.end(data.bytes);
      }
      const message = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/messages$/i);
      if (message && method === "POST") {
        const input = await body(req, 70000);
        return await replyToSend(res, message[1], input?.requestId, desktop.send(message[1], input));
      }
      const receipt = path.match(
        /^\/api\/tasks\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})$/i,
      );
      if (receipt && method === "GET")
        return json(res, 200, desktop.getReceipt(receipt[1], receipt[2]));
      const outbox = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/outbox\/([a-f0-9-]{36})(\/(?:send|edit|resume))?$/i);
      const compact = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/compact$/i);
      const stop = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/stop$/i);
      if (stop && method === "POST")
        return json(res, 200, await desktop.stop(stop[1], await body(req)));
      const stopReceipt = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/stop\/([a-f0-9-]{36})$/i);
      if (stopReceipt && method === "GET")
        return json(res, 200, desktop.stops.receipt(stopReceipt[1], stopReceipt[2]));
      const resumeQueue = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/queue\/resume$/i);
      if (resumeQueue && method === "POST")
        return json(res, 200, await desktop.resumeQueue(resumeQueue[1], await body(req)));
      const response = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/requests\/([a-f0-9]{64})\/respond$/i);
      const answer = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/questions\/([a-f0-9]{64})\/answer$/i);
      if (answer && method === "POST")
        return json(res, 200, await desktop.answer(answer[1], answer[2], await body(req, 70000)));
      if (response && method === "POST")
        return json(res, 200, await desktop.respond(response[1], response[2], await body(req)));
      const responseReceipt = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/responses\/([a-f0-9-]{36})$/i);
      if (responseReceipt && method === "GET")
        return json(res, 200, desktop.getResponseReceipt(responseReceipt[1], responseReceipt[2]));
      if (compact && method === "POST")
        return json(res, 200, await desktop.compact(compact[1], await body(req)));
      const compactReceipt = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/compact\/([a-f0-9-]{36})$/i);
      if (compactReceipt && method === "GET")
        return json(res, 200, desktop.getCompactionReceipt(compactReceipt[1], compactReceipt[2]));
      if (outbox) {
        if (method === "PATCH" && !outbox[3])
          return json(res, 200, desktop.editQueued(outbox[1], outbox[2], await body(req, 70000)));
        if (method === "DELETE" && !outbox[3])
          return json(res, 200, desktop.cancelQueued(outbox[1], outbox[2], await body(req)));
        if (method === "POST" && outbox[3] === "/send")
        return await replyToSend(res, outbox[1], outbox[2], desktop.dispatchQueued(outbox[1], outbox[2], await body(req)));
        if (method === "POST" && ["/edit", "/resume"].includes(outbox[3]))
          return json(res, 200, desktop.pauseQueued(outbox[1], outbox[2], await body(req), outbox[3] === "/resume"));
      }
      if (task && method === "PATCH")
        return json(res, 200, store.patchThread(task[1], await body(req)));
      const open = path.match(/^\/api\/open\/([a-f0-9-]{36})$/i);
      if (open && method === "POST") {
        const input = await body(req, 1024, true);
        if (!input || typeof input !== "object" || Array.isArray(input) ||
            Object.keys(input).some(key => key !== "intent") ||
            input.intent !== undefined && input.intent !== "reading")
          throw new AppError("连接参数无效", 400);
        const t = store.thread(open[1]);
        if (input.intent === "reading") {
          const connection = desktop.connect(t.id, { reading: true });
          // Staying on a reading view is not another explicit navigation/open.
          return json(res, 200, { status: connection ? "handoff_requested" : "skipped", thread: { ...t, ...store.annotation(t.id, t) },
            connection: connection || desktop.connection(t.id) });
        }
        desktop.requireLifecycleOpen(t.id);
        if (t.missing)
          throw new AppError("来源中已找不到这条会话，请先同步", 409);
        if (t.archived) {
          await openThread(t.id);
          return json(res, 200, { status: "handoff_requested", thread: store.recordOpen(t.id),
            connection: { status: "idle" }, readOnly: true });
        }
        const connection = desktop.connect(t.id);
        const updated = store.recordOpen(t.id);
        return json(res, 200, { status: "handoff_requested", thread: updated, connection });
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
      if (path === "/sw.js") res.setHeader("Service-Worker-Allowed", "/");
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
      });
      res.end(method === "HEAD" ? undefined : content);
    } catch (e) {
      if (e.status === 429) res.setHeader("Retry-After", "900");
      json(res, e.status || 500, {
        error: e.status ? e.message : "操作未完成，请刷新后重试",
        ...(e.status ? {} : { detail: String(e.message).slice(0, 250) }),
      });
    }
  });
  const close = () => {
    clearInterval(interval);
    taskStatuses.stop();
    lifecycle.stop();
    rename.stop();
    desktop.models.stop();
    notifications.stop();
    desktop.stopQueue();
    historyPages.close?.();
    store.close();
  };
  server.on("listening", () => { desktop.startQueue(); notifications.start(); lifecycle.start(); });
  server.on("close", close);
  return { server, store, sync, auth, lifecycle, rename };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { server } = makeApp();
  const port = Number(process.env.PORT || 4397);
  server.listen(port, "127.0.0.1", () =>
    console.log(`Pocket ready on loopback port ${port}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => server.close(() => process.exit(0)));
}

#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { publishConnection } from "./publish-connection.mjs";
import { connectionHealth } from "./connection-state.mjs";
const directory =
  process.env.NAVIGATOR_DATA_DIR ||
  join(homedir(), "Library/Application Support/CodexNavigator");
const origin = "http://127.0.0.1:4397",
  port = Number(process.env.PORT || 4399);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const state = {
  publicOrigin: null,
  temporary: true,
  connected: false,
  updatedAt: new Date().toISOString(),
};
function persist() {
  state.updatedAt = new Date().toISOString();
  const p = join(directory, "connection.json");
  writeFileSync(p + ".tmp", JSON.stringify(state), { mode: 0o600 });
  renameSync(p + ".tmp", p);
}
// Refuse to expose an old/unprotected server, even if its health check is green.
const probe = await fetch(origin + "/api/catalog", {
  signal: AbortSignal.timeout(5000),
});
if (probe.status !== 401)
  throw new Error("Password protection is not ready; tunnel remains closed");
const status = await fetch(origin + "/api/auth/status", {
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json());
if (status.authenticated !== false)
  throw new Error("Unexpected authentication state; tunnel remains closed");
persist();
const server = http.createServer((req, res) => {
  const health = connectionHealth(state);
  res.writeHead(health.ok ? 200 : 503, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      app: "codex-navigator-tunnel",
      ...state,
      ...health,
    }),
  );
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    [
      "HOME",
      "PATH",
      "TMPDIR",
      "LANG",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "no_proxy",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
    ].includes(key),
  ),
);
const child = spawn(
  "/opt/homebrew/bin/cloudflared",
  [
    "tunnel",
    "--no-autoupdate",
    "--loglevel",
    "info",
    "--protocol",
    "http2",
    "--url",
    origin,
  ],
  { stdio: ["ignore", "pipe", "pipe"], env },
);
let buffer = "",
  closing = false,
  publishing = false,
  publishedOrigin = null,
  lastPublishedAt = 0;
async function publish() {
  if (
    publishing ||
    !state.connected ||
    !state.publicOrigin ||
    (publishedOrigin === state.publicOrigin &&
      Date.now() - lastPublishedAt < 600000)
  )
    return;
  publishing = true;
  try {
    const receipt = await publishConnection({ ...state });
    publishedOrigin = state.publicOrigin;
    lastPublishedAt = Date.now();
    Object.assign(state, receipt, { published: true, registrationError: null });
    persist();
  } catch (error) {
    state.published = false;
    state.registrationError = error.code || "registration_failed";
    persist();
    console.error(
      `Mac route registration failed (${state.registrationError}); will retry without changing the entry URL`,
    );
  } finally {
    publishing = false;
  }
}
const refreshRoute = setInterval(() => void publish(), 60000);
refreshRoute.unref();
function log(chunk) {
  const text = chunk.toString();
  process.stderr.write(text);
  buffer = (buffer + text).slice(-12000);
  const url = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
  if (url && state.publicOrigin !== url[0]) {
    state.publicOrigin = url[0];
    persist();
  }
  if (/Registered tunnel connection/.test(text)) {
    state.connected = true;
    persist();
    void publish();
  }
  if (/Connection terminated|Unregistered tunnel connection/.test(text)) {
    state.connected = false;
    persist();
  }
}
child.stdout.on("data", log);
child.stderr.on("data", log);
child.on("error", (error) => {
  console.error(error.message);
  stop(1);
});
child.on("exit", (code) => {
  if (!closing) stop(code || 1);
});
function stop(code = 0) {
  if (closing) return;
  closing = true;
  state.connected = false;
  persist();
  child.kill("SIGTERM");
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());

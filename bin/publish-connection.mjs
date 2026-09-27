import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
export async function publishConnection(connection) {
  if (!connection.connected || !connection.publicOrigin)
    throw new Error("Tunnel must be connected before publishing");
  const config = JSON.parse(
    readFileSync(new URL("../config/relay.json", import.meta.url), "utf8"),
  );
  await exec(
    config.wrangler[0],
    [
      ...config.wrangler.slice(1),
      "kv",
      "key",
      "put",
      "origin",
      JSON.stringify({
        publicOrigin: connection.publicOrigin,
        connected: true,
        updatedAt: new Date().toISOString(),
      }),
      "--namespace-id",
      config.namespaceId,
      "--remote",
      "--ttl",
      "900",
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: config.accountId,
        WRANGLER_SEND_METRICS: "false",
      },
      timeout: 60000,
      maxBuffer: 200000,
    },
  );
  return {
    entryOrigin: config.publicOrigin,
    publishedAt: new Date().toISOString(),
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const directory =
    process.env.NAVIGATOR_DATA_DIR ||
    join(homedir(), "Library/Application Support/CodexNavigator");
  const c = JSON.parse(
    readFileSync(join(directory, "connection.json"), "utf8"),
  );
  try {
    console.log(JSON.stringify({ ok: true, ...(await publishConnection(c)) }));
  } catch (e) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Failed to publish Mac route",
        code: e.code || null,
      }),
    );
    process.exitCode = 1;
  }
}

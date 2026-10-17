import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const failure = (code) => Object.assign(new Error(code), { code });
export async function publishConnection(connection, options = {}) {
  if (!connection.connected || !connection.publicOrigin)
    throw failure("tunnel_not_connected");
  const config = options.config || JSON.parse(readFileSync(new URL("../config/relay.json", import.meta.url), "utf8"));
  const machineId = config.machineId === undefined ? process.env.NAVIGATOR_MACHINE_ID ?? "ged" : config.machineId;
  if (typeof machineId !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(machineId))
    throw failure("registration_machine_invalid");
  const directory = options.dataDir || process.env.NAVIGATOR_DATA_DIR ||
    join(homedir(), "Library/Application Support/CodexNavigator");
  let token;
  try {
    ({ token } = JSON.parse(readFileSync(join(directory, "relay-registration.json"), "utf8")));
    if (!/^[a-f0-9]{64}$/.test(token || "")) throw new Error();
  } catch {
    throw failure("registration_credential_missing");
  }
  const entry = new URL(config.publicOrigin);
  if (entry.protocol !== "https:" || entry.username || entry.password || entry.pathname !== "/" || entry.search || entry.hash)
    throw failure("registration_endpoint_invalid");
  try {
    const response = await (options.fetch || fetch)(new URL("/api/relay/register", entry), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ connected: true, machineId, publicOrigin: connection.publicOrigin }),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw failure(`registration_http_${response.status}`);
    const receipt = await response.json();
    if (receipt.ok !== true || receipt.entryOrigin !== entry.origin ||
        (receipt.machineId !== machineId && !(machineId === "ged" && receipt.machineId === undefined)) ||
        (response.headers.has("X-Pocket-Machine") && response.headers.get("X-Pocket-Machine") !== machineId) ||
        receipt.publicOrigin !== connection.publicOrigin ||
        !Number.isFinite(Date.parse(receipt.publishedAt)) || Date.parse(receipt.expiresAt) <= Date.now() ||
        !Number.isFinite(Date.parse(receipt.expiresAt)))
      throw failure("registration_receipt_invalid");
    return { machineId, entryOrigin: receipt.entryOrigin, publishedAt: receipt.publishedAt, expiresAt: receipt.expiresAt };
  } catch (e) {
    // Never include raw request/response bodies or credentials in service logs.
    if (typeof e.code === "string" && e.code.startsWith("registration_")) throw e;
    throw failure(e.name === "TimeoutError" ? "registration_timeout" : "registration_network_error");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.env.NAVIGATOR_DATA_DIR || join(homedir(), "Library/Application Support/CodexNavigator");
  try {
    const connection = JSON.parse(readFileSync(join(directory, "connection.json"), "utf8"));
    console.log(JSON.stringify({ ok: true, ...(await publishConnection(connection)) }));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: "Failed to publish Mac route", code: e.code || "registration_failed" }));
    process.exitCode = 1;
  }
}

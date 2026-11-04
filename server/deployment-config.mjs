import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { normalizeClientConfig } from "../shared/client-config.mjs";

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
const legacyHosts = [...loopbackHosts, "threads.local"];
const machinePattern = /^[a-z][a-z0-9-]{0,31}$/;
const fail = () => { throw new Error("Invalid Pocket deployment configuration"); };

function hostname(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 253 || value !== value.trim()) fail();
  const name = value.toLowerCase();
  if (name.startsWith("[")) {
    if (!name.endsWith("]") || isIP(name.slice(1, -1)) !== 6) fail();
    return new URL(`https://${name}`).hostname;
  }
  if (isIP(name) === 6) return new URL(`https://[${name}]`).hostname;
  if (isIP(name) === 4) return name;
  if (!name.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail();
  return name;
}

function publicOrigin(value) {
  if (typeof value !== "string" || value.length > 2048 || value !== value.trim()) fail();
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) fail();
  hostname(url.hostname);
  return url.origin;
}

// This describes a deployment, not proof that its proxy, desktop or network is ready.
// The old default remains for existing installations; explicit files are fail-closed.
export function normalizeDeploymentConfig(value) {
  if (value === undefined) return Object.freeze({ configured: false, publicOrigin: null,
    allowedHosts: Object.freeze(legacyHosts), machineId: null, minimumPassphraseLength: 4 });
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 ||
      Object.keys(value).some(key => !["schemaVersion", "publicOrigin", "allowedHosts", "machineId", "minimumPassphraseLength"].includes(key))) fail();
  const origin = value.publicOrigin === undefined ? null : publicOrigin(value.publicOrigin);
  const machineId = value.machineId === undefined ? null : value.machineId;
  if (machineId !== null && (typeof machineId !== "string" || !machinePattern.test(machineId))) fail();
  const supplied = value.allowedHosts === undefined ? [] : value.allowedHosts;
  if (!Array.isArray(supplied) || supplied.length > 32) fail();
  const minimum = value.minimumPassphraseLength === undefined ? (origin ? 12 : 4) : value.minimumPassphraseLength;
  if (!Number.isInteger(minimum) || minimum < (origin ? 12 : 4) || minimum > 128) fail();
  const hosts = [...loopbackHosts, ...supplied.map(hostname), ...(origin ? [new URL(origin).hostname] : [])];
  return Object.freeze({ configured: true, publicOrigin: origin, allowedHosts: Object.freeze([...new Set(hosts)]),
    machineId, minimumPassphraseLength: minimum });
}

export function readDeploymentConfig(path = process.env.NAVIGATOR_DEPLOYMENT_CONFIG) {
  if (path === undefined || path === "") return normalizeDeploymentConfig(undefined);
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("NAVIGATOR_DEPLOYMENT_CONFIG must be an absolute file path");
  let content;
  try { content = readFileSync(path); } catch { throw new Error("Unable to read Pocket deployment configuration"); }
  if (content.length > 65536) fail();
  let value;
  try { value = JSON.parse(content.toString("utf8")); } catch { fail(); }
  return normalizeDeploymentConfig(value);
}

export function readClientProfile(path = process.env.NAVIGATOR_CLIENT_CONFIG) {
  if (path === undefined || path === "") return null;
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("NAVIGATOR_CLIENT_CONFIG must be an absolute file path");
  let content;
  try { content = readFileSync(path); } catch { throw new Error("Unable to read Pocket public client configuration"); }
  if (content.length > 65536) throw new Error("Pocket public client configuration is too large");
  let value;
  try { value = JSON.parse(content.toString("utf8")); } catch { throw new Error("Invalid Pocket public client configuration"); }
  return normalizeClientConfig(value);
}

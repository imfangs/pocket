#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// Idempotent setup: restarting or re-running never rotates the deployed key.
const directory = process.env.NAVIGATOR_DATA_DIR || join(homedir(), "Library/Application Support/CodexNavigator");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const credentialFile = join(directory, "relay-registration.json");
const verifierFile = join(directory, "relay-registration.sha256");
if (!existsSync(credentialFile))
  writeFileSync(credentialFile, JSON.stringify({ token: randomBytes(32).toString("hex"), createdAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
chmodSync(credentialFile, 0o600);
const { token } = JSON.parse(readFileSync(credentialFile, "utf8"));
if (!/^[a-f0-9]{64}$/.test(token || "")) throw new Error("登记凭据损坏，请先恢复本机备份");
writeFileSync(verifierFile, createHash("sha256").update(token).digest("hex") + "\n", { mode: 0o600 });
chmodSync(verifierFile, 0o600);
console.log(JSON.stringify({ ok: true, credentialFile, verifierFile }));

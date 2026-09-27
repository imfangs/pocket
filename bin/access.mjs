#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { NavigatorStore } from "../server/store.mjs";
import { AccessControl } from "../server/auth.mjs";
const command = process.argv[2] || "info";
if (!["info", "rotate", "set"].includes(command)) {
  console.error("用法：node bin/access.mjs info|rotate|set --stdin");
  process.exit(2);
}
const store = new NavigatorStore(
  process.env.NAVIGATOR_DATA_DIR ||
    join(homedir(), "Library/Application Support/CodexNavigator"),
);
try {
  const auth = new AccessControl(store.directory, store.db);
  if (command === "rotate")
    auth.setPassphrase(randomBytes(9).toString("base64url"));
  if (command === "set") {
    if (!process.argv.includes("--stdin"))
      throw new Error("自定义口令只从 stdin 读取，请勿放进命令参数");
    auth.setPassphrase(readFileSync(0, "utf8").trim());
  }
  console.log(
    JSON.stringify({
      ok: true,
      passphraseFile: auth.passphrasePath,
      rotated: command !== "info",
      sessionsRevoked: command !== "info",
    }),
  );
} finally {
  store.close();
}

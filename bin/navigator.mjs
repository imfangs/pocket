#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
const help = `Pocket CLI（服务需已运行）
  node bin/navigator.mjs list [--query 游戏] [--intent later] [--archived] [--json]
  node bin/navigator.mjs groups [--json]
  node bin/navigator.mjs group 名称 [--parent 分组ID] [--json]
  node bin/navigator.mjs annotate 会话ID [--intent none|active|later|reference] [--note-file 文件] [--review-at YYYY-MM-DD] [--json]
  node bin/navigator.mjs open 会话ID [--json]
  node bin/navigator.mjs sync [--json]
  node bin/navigator.mjs backup /绝对路径/backup.json [--json]
  node bin/navigator.mjs connection [--json]

list/search 只读。分组与 annotate 仅写 Pocket 自己的数据。open 使用原会话 ID。
`;
async function main() {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      query: { type: "string" },
      intent: { type: "string" },
      "note-file": { type: "string" },
      "review-at": { type: "string" },
      parent: { type: "string" },
      archived: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (v.help || !p.length) {
    console.log(help);
    return;
  }
  const base = new URL(process.env.NAVIGATOR_URL || "http://127.0.0.1:4397");
  if (
    !["127.0.0.1", "localhost", "[::1]", "threads.local"].includes(
      base.hostname,
    )
  )
    throw new Error("仅支持本机 Pocket 地址");
  let token = "";
  const access = JSON.parse(
    readFileSync(
      join(
        process.env.NAVIGATOR_DATA_DIR ||
          join(homedir(), "Library/Application Support/CodexNavigator"),
        "access.json",
      ),
      "utf8",
    ),
  );
  async function call(path, method = "GET", data) {
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: base.origin,
        Authorization: `Bearer ${access.localToken}`,
        ...(method === "GET" ? {} : { "X-Navigator-Token": token }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  }
  const catalog = await call("/api/catalog");
  token = catalog.csrfToken;
  let result;
  switch (p[0]) {
    case "connection":
      result = await call("/api/connection");
      break;
    case "list": {
      const terms = (v.query || "")
        .toLocaleLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const tasks = catalog.threads.filter(
        (t) =>
          !t.separator &&
          (v.archived ? t.archived : v.intent ? true : !t.archived) &&
          (!v.intent || t.intent === v.intent) &&
          terms.every((q) =>
            [t.title, t.note, t.cwd, t.projectName]
              .join(" ")
              .toLocaleLowerCase()
              .includes(q),
          ),
      );
      result = {
        count: tasks.length,
        threads: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          project: t.projectName,
          intent: t.intent,
          note: t.note,
          reviewAt: t.reviewAt,
          groupIds: t.groupIds,
          archived: t.archived,
        })),
      };
      break;
    }
    case "groups":
      result = catalog.groups;
      break;
    case "group":
      if (!p[1]) throw new Error("需要分组名称");
      result = await call("/api/groups", "POST", {
        name: p[1],
        parentId: v.parent || null,
      });
      break;
    case "annotate": {
      if (!p[1]) throw new Error("需要原会话 ID");
      const patch = {};
      if (v.intent) patch.intent = v.intent;
      if (v["note-file"] !== undefined)
        patch.note = readFileSync(resolve(v["note-file"]), "utf8");
      if (v["review-at"] !== undefined) patch.reviewAt = v["review-at"] || null;
      if (!Object.keys(patch).length) throw new Error("请指定要修改的字段");
      result = await call(
        `/api/tasks/${encodeURIComponent(p[1])}`,
        "PATCH",
        patch,
      );
      break;
    }
    case "open":
      if (!p[1]) throw new Error("需要原会话 ID");
      result = await call(`/api/open/${encodeURIComponent(p[1])}`, "POST");
      break;
    case "sync": {
      const c = await call("/api/sync", "POST");
      result = c.sourceInfo;
      break;
    }
    case "backup": {
      if (!p[1]) throw new Error("需要输出文件路径");
      const output = resolve(p[1]);
      writeFileSync(
        output,
        JSON.stringify(await call("/api/export"), null, 2) + "\n",
        { mode: 0o600 },
      );
      result = { output };
      break;
    }
    default:
      throw new Error("未知命令，使用 --help 查看");
  }
  console.log(JSON.stringify({ ok: true, result }, null, v.json ? 0 : 2));
}
main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message }));
  process.exitCode = 1;
});

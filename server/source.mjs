import { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readLocalUnreadState, readRecordedTurnState } from "./unread.mjs";
import { readLastMessageAt } from "./message-time.mjs";

const separator = (s) => /^[-—–_\s]{3,}$/.test(s);
export function readCodexSource(codexHome) {
  const file = join(codexHome, "state_5.sqlite");
  const globalFile = join(codexHome, ".codex-global-state.json");
  const global = JSON.parse(readFileSync(globalFile, "utf8"));
  const unread = readLocalUnreadState(global, codexHome);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000");
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(threads)")
        .all()
        .map((x) => x.name),
    );
    for (const field of [
      "id",
      "title",
      "cwd",
      "archived",
      "created_at",
      "updated_at",
      "source",
    ]) {
      if (!columns.has(field))
        throw new Error(`Codex 数据结构已变化，缺少 ${field}`);
    }
    const optional = (f, fallback = "NULL") =>
      columns.has(f) ? `"${f}"` : `${fallback} AS "${f}"`;
    const rows = db
      .prepare(
        `SELECT id, title, cwd, archived, created_at, updated_at, source,
      ${["name", "thread_source", "agent_path", "project_id", "updated_at_ms", "git_branch", "rollout_path"].map((f) => optional(f)).join(", ")}
      FROM threads WHERE source IN ('vscode', 'cli', 'exec', 'app')`,
      )
      .all();
    const locals = global["local-projects"] || {};
    const order = global["project-order"] || Object.keys(locals);
    const projects = Object.values(locals)
      .map((p) => ({
        id: p.id,
        name: String(p.name || p.id),
        paths: p.rootPaths || [],
        order: order.indexOf(p.id) < 0 ? 999 : order.indexOf(p.id),
        separator: separator(String(p.name || "")),
      }))
      .sort((a, b) => a.order - b.order);
    const hostKey = `local:${codexHome}`;
    const migration =
      global["app-server-project-id-by-legacy-project-id-by-host"]?.[hostKey] ||
      {};
    const reverseMigration = Object.fromEntries(
      Object.entries(migration).map(([a, b]) => [b, a]),
    );
    const assignment = global["thread-project-assignments"] || {};
    const pinned = global["pinned-thread-ids"];
    if (!Array.isArray(pinned))
      throw new Error("未能读取桌面置顶列表，请检查客户端版本");
    const projectless = new Set(global["projectless-thread-ids"] || []);
    let excludedChildren = 0;
    const threads = rows
      .filter((r) => {
        const child =
          r.thread_source === "subagent" ||
          (r.agent_path && r.agent_path !== "/root");
        if (child) excludedChildren++;
        return !child;
      })
      .map((r) => {
        const a = assignment[r.id];
        const legacyId = a?.projectKind === "local" ? a.projectId : null;
        const nativeId = reverseMigration[r.project_id] || r.project_id;
        const projectId =
          legacyId || (projectless.has(r.id) ? null : nativeId) || null;
        const project = projects.find((p) => p.id === projectId);
        const title = String(r.name || r.title || "未命名会话")
          .split("\n")[0]
          .slice(0, 220);
        const hasUnreadTurn = unread.available ? unread.ids.has(r.id) : null;
        const recordedTurnState = hasUnreadTurn && !r.archived && !separator(title)
          ? readRecordedTurnState(codexHome, r.id, r.rollout_path) : undefined;
        return {
          id: r.id,
          hostId: "local",
          title,
          cwd: r.cwd,
          projectId,
          projectName: project?.name || "无项目",
          archived: !!r.archived,
          pinned: pinned.includes(r.id),
          pinnedOrder: pinned.indexOf(r.id),
          separator: separator(title),
          source: r.source,
          createdAt: r.created_at * 1000,
          // Keep native metadata time for compatibility; it is not message activity.
          updatedAt: r.updated_at_ms || r.updated_at * 1000,
          lastMessageAt: readLastMessageAt(codexHome, r.id, r.rollout_path),
          branch: r.git_branch || null,
          hasUnreadTurn,
          needsInput: hasUnreadTurn === true && recordedTurnState === "ended",
          ...(recordedTurnState ? { recordedTurnState } : {}),
        };
      });
    return {
      threads,
      projects,
      sourceInfo: {
        type: "codex-desktop-local",
        adapterVersion: 1,
        readOnly: true,
        syncedAt: Date.now(),
        databaseMtime: statSync(file).mtimeMs,
        total: threads.length,
        active: threads.filter((t) => !t.archived && !t.separator).length,
        archived: threads.filter((t) => t.archived && !t.separator).length,
        separators: threads.filter((t) => t.separator).length,
        excludedChildren,
        unread: {
          available: unread.available,
          source: unread.source,
          pending: threads.filter(t => t.hasUnreadTurn && !t.archived && !t.separator && !t.needsInput).length,
        },
        scope: "本机 Codex 用户、自动化及独立任务；不含子代理、云端和其他电脑",
      },
    };
  } finally {
    db.close();
  }
}

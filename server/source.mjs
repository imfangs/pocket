import { DatabaseSync } from "node:sqlite";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readLocalUnreadState, readRecordedTurnState } from "./unread.mjs";
import { readLastMessageAt } from "./message-time.mjs";
import { readSourceScope } from "./source-scope.mjs";

const separator = (s) => /^[-—–_\s]{3,}$/.test(s);
const reasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
function savedModelSettings(row) {
  const model = typeof row.model === "string" && row.model.length <= 120 &&
    !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(row.model) && row.model.trim()
    ? row.model.trim() : null;
  const effort = reasoningEfforts.has(row.reasoning_effort) ? row.reasoning_effort : null;
  return model || effort ? { model, effort } : null;
}
export function readCodexSource(codexHome) {
  const file = join(codexHome, "state_5.sqlite");
  const globalFile = join(codexHome, ".codex-global-state.json");
  const global = JSON.parse(readFileSync(globalFile, "utf8"));
  const unread = readLocalUnreadState(global, codexHome);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000");
    db.exec("BEGIN");
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
      ${["name", "thread_source", "agent_path", "project_id", "updated_at_ms", "git_branch", "rollout_path", "model", "reasoning_effort"].map((f) => optional(f)).join(", ")}
      FROM threads`,
      )
      .all();
    const scope = readSourceScope(db, rows);
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
    const threads = scope.visibleRows
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
        const savedSettings = savedModelSettings(r);
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
          ...(savedSettings ? { savedModelSettings: savedSettings } : {}),
          hasUnreadTurn,
          needsInput: hasUnreadTurn === true && recordedTurnState === "ended",
          ...(recordedTurnState ? { recordedTurnState } : {}),
        };
      });
    const result = {
      threads,
      projects,
      excludedThreadIds: scope.excludedThreadIds,
      excludedThreadStates: scope.excludedThreadStates,
      sourceInfo: {
        type: "codex-desktop-local",
        adapterVersion: 2,
        readOnly: true,
        syncedAt: Date.now(),
        databaseMtime: statSync(file).mtimeMs,
        total: threads.length,
        active: threads.filter((t) => !t.archived && !t.separator).length,
        archived: threads.filter((t) => t.archived && !t.separator).length,
        separators: threads.filter((t) => t.separator).length,
        ...scope.counts,
        unread: {
          available: unread.available,
          source: unread.source,
          pending: threads.filter(t => t.hasUnreadTurn && !t.archived && !t.separator && !t.needsInput).length,
        },
        scope: "本机 Codex 桌面会话；不含后台 exec、隐藏内部任务、子代理、云端和其他电脑",
      },
    };
    db.exec("COMMIT");
    return result;
  } finally {
    db.close();
  }
}

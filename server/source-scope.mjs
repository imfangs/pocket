const desktopSources = new Set(["vscode", "cli", "app"]);
const hiddenThreadSources = new Set([
  "chatgpt_hidden", "ambient_suggestions", "pull_request_fix_automation",
]);

function readSpawnedChildren(db) {
  const table = db.prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get("thread_spawn_edges");
  // Older source databases expose only thread_source / agent_path.
  if (!table) return new Set();
  const columns = new Set(db.prepare("PRAGMA table_info(thread_spawn_edges)").all().map(row => row.name));
  if (table.type !== "table" || !columns.has("child_thread_id"))
    throw new Error("Codex 数据结构已变化，thread_spawn_edges 缺少有效的 child_thread_id");
  const children = new Set();
  for (const row of db.prepare("SELECT child_thread_id FROM thread_spawn_edges").all()) {
    if (typeof row.child_thread_id !== "string" || !row.child_thread_id.trim())
      throw new Error("Codex 数据结构已变化，thread_spawn_edges.child_thread_id 无效");
    children.add(row.child_thread_id);
  }
  return children;
}

export function readSourceScope(db, rows) {
  const children = readSpawnedChildren(db);
  const counts = { excludedChildren: 0, excludedBackground: 0, excludedHidden: 0, excludedSources: 0 };
  const visibleRows = [], excludedThreadStates = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || !row.id.trim())
      throw new Error("Codex 数据结构已变化，threads.id 无效");
    let reason;
    if (children.has(row.id) || row.thread_source === "subagent" || (row.agent_path && row.agent_path !== "/root"))
      reason = "excludedChildren";
    else if (hiddenThreadSources.has(row.thread_source)) reason = "excludedHidden";
    else if (row.source === "exec") reason = "excludedBackground";
    else if (!desktopSources.has(row.source)) reason = "excludedSources";
    if (reason) {
      if (row.archived !== 0 && row.archived !== 1)
        throw new Error("Codex 数据结构已变化，threads.archived 无效");
      counts[reason]++;
      excludedThreadStates.push({ id: row.id, archived: row.archived === 1 });
    } else visibleRows.push(row);
  }
  // Use source provenance, not catalog presence: the desktop catalog can lag a
  // new Pocket-created thread and normally omits already archived history.
  const excludedThreadIds = excludedThreadStates.map(state => state.id);
  return { visibleRows, excludedThreadIds, excludedThreadStates,
    counts: { ...counts, excludedTotal: excludedThreadIds.length } };
}

import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const parse = (s, fallback) => (s ? JSON.parse(s) : fallback);
const validDate = (s) =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;
export const intents = ["none", "active", "later", "reference"];
export class NavigatorStore {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "navigator.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_threads(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT,color TEXT NOT NULL,position INTEGER NOT NULL,source_project_id TEXT);
      CREATE TABLE IF NOT EXISTS annotations(thread_id TEXT PRIMARY KEY,intent TEXT NOT NULL DEFAULT 'none',note TEXT NOT NULL DEFAULT '',review_at TEXT,group_ids TEXT,last_opened_at INTEGER,updated_at INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
    `);
    this.lastError = null;
  }
  close() {
    this.db.close();
  }
  setting(k, fallback = null) {
    return parse(
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value,
      fallback,
    );
  }
  set(k, v) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(k, JSON.stringify(v));
  }
  groups() {
    return this.db
      .prepare("SELECT * FROM groups ORDER BY position,name")
      .all()
      .map((g) => ({
        id: g.id,
        name: g.name,
        parentId: g.parent_id,
        color: g.color,
        position: g.position,
        sourceProjectId: g.source_project_id,
      }));
  }
  sync(source) {
    if (!Array.isArray(source.threads) || !Array.isArray(source.projects))
      throw new AppError("来源格式无效");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = this.db.prepare(
        "INSERT INTO source_threads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      );
      const seen = new Set();
      for (const t of source.threads) {
        if (seen.has(t.id)) throw new AppError("来源包含重复 ID");
        seen.add(t.id);
        upsert.run(t.id, JSON.stringify({ ...t, missing: false }));
      }
      for (const row of this.db
        .prepare("SELECT id,data FROM source_threads")
        .all()) {
        if (!seen.has(row.id))
          upsert.run(
            row.id,
            JSON.stringify({ ...JSON.parse(row.data), missing: true }),
          );
      }
      if (!this.setting("seeded")) {
        const insert = this.db.prepare(
          "INSERT INTO groups VALUES(?,?,?,?,?,?)",
        );
        const colors = [
          "#547569",
          "#b17947",
          "#7775a8",
          "#58859c",
          "#9e7292",
          "#bba354",
        ];
        source.projects
          .filter((p) => !p.separator)
          .forEach((p, i) =>
            insert.run(
              randomUUID(),
              p.name,
              null,
              colors[i % colors.length],
              i,
              p.id,
            ),
          );
        this.set("seeded", true);
      }
      this.set("projects", source.projects);
      this.set("sourceInfo", source.sourceInfo);
      this.db.exec("COMMIT");
      this.lastError = null;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  failSync(error) {
    this.lastError = error.message || "来源读取失败";
  }
  annotation(id, source, groups = this.groups()) {
    const a = this.db
      .prepare("SELECT * FROM annotations WHERE thread_id=?")
      .get(id);
    const defaults = groups
      .filter(
        (g) => g.sourceProjectId && g.sourceProjectId === source?.projectId,
      )
      .map((g) => g.id);
    const groupIds = parse(a?.group_ids, defaults).filter((id) =>
      groups.some((g) => g.id === id),
    );
    return {
      intent: a?.intent || "none",
      note: a?.note || "",
      reviewAt: a?.review_at || null,
      groupIds,
      lastOpenedAt: a?.last_opened_at || null,
      revision: a?.revision || 0,
    };
  }
  thread(id) {
    const row = this.db
      .prepare("SELECT data FROM source_threads WHERE id=?")
      .get(id);
    if (!row) throw new AppError("找不到原会话", 404);
    return JSON.parse(row.data);
  }
  catalog() {
    const groups = this.groups();
    const threads = this.db
      .prepare("SELECT id,data FROM source_threads")
      .all()
      .map((row) => {
        const t = JSON.parse(row.data);
        return { ...t, ...this.annotation(row.id, t, groups) };
      });
    return {
      threads,
      groups,
      projects: this.setting("projects", []),
      sourceInfo: this.setting("sourceInfo"),
      sourceError: this.lastError,
    };
  }
  patchThread(id, patch, makeBackup = true) {
    const source = this.thread(id),
      prev = this.annotation(id, source);
    const allowed = [
      "intent",
      "note",
      "reviewAt",
      "groupIds",
      "expectedRevision",
    ];
    if (Object.keys(patch).some((k) => !allowed.includes(k)))
      throw new AppError("包含未知字段");
    if (
      patch.expectedRevision !== undefined &&
      patch.expectedRevision !== prev.revision
    )
      throw new AppError("这条任务刚在另一处更新，请刷新后重试", 409);
    const next = { ...prev, ...patch };
    if (!intents.includes(next.intent)) throw new AppError("无效的接续状态");
    if (typeof next.note !== "string" || next.note.length > 12000)
      throw new AppError("接续说明最多 12000 字");
    if (next.reviewAt !== null && !validDate(next.reviewAt))
      throw new AppError("无效的回顾日期");
    const groupSet = new Set(this.groups().map((g) => g.id));
    if (
      !Array.isArray(next.groupIds) ||
      next.groupIds.length > 50 ||
      next.groupIds.some((g) => !groupSet.has(g))
    )
      throw new AppError("分组不存在");
    next.groupIds = [...new Set(next.groupIds)];
    this.db
      .prepare(
        `INSERT INTO annotations(thread_id,intent,note,review_at,group_ids,last_opened_at,updated_at,revision)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET intent=excluded.intent,note=excluded.note,review_at=excluded.review_at,group_ids=excluded.group_ids,updated_at=excluded.updated_at,revision=excluded.revision`,
      )
      .run(
        id,
        next.intent,
        next.note,
        next.reviewAt,
        JSON.stringify(next.groupIds),
        prev.lastOpenedAt,
        Date.now(),
        prev.revision + 1,
      );
    if (makeBackup) this.backup();
    return { ...source, ...this.annotation(id, source) };
  }
  batch(ids, change) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 2000 ||
      new Set(ids).size !== ids.length
    )
      throw new AppError("每次请选择 1–2000 条任务");
    if (
      !change ||
      Object.keys(change).some((k) => !["intent", "groupId"].includes(k)) ||
      !Object.keys(change).length
    )
      throw new AppError("无效的批量操作");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of ids) {
        const old = this.annotation(id, this.thread(id));
        const patch = {};
        if (change.intent !== undefined) patch.intent = change.intent;
        if (change.groupId)
          patch.groupIds = [...new Set([...old.groupIds, change.groupId])];
        this.patchThread(id, patch, false);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.backup();
    return this.catalog();
  }
  recordOpen(id) {
    const source = this.thread(id);
    this.db
      .prepare(
        `INSERT INTO annotations(thread_id,last_opened_at,updated_at) VALUES(?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET last_opened_at=excluded.last_opened_at`,
      )
      .run(id, Date.now(), Date.now());
    return { ...source, ...this.annotation(id, source) };
  }
  saveGroup(input, id = null) {
    const groups = this.groups(),
      old = groups.find((g) => g.id === id);
    if (id && !old) throw new AppError("分组不存在", 404);
    const g = {
      name: old?.name || "",
      parentId: old?.parentId || null,
      color: old?.color || "#547569",
      position: old?.position ?? groups.length,
      ...input,
    };
    g.name = typeof g.name === "string" ? g.name.trim() : "";
    if (!g.name || g.name.length > 60)
      throw new AppError("分组名称需在 1–60 字之间");
    if (!/^#[0-9a-f]{6}$/i.test(g.color)) throw new AppError("无效的分组颜色");
    if (!Number.isInteger(g.position) || g.position < 0 || g.position > 10000)
      throw new AppError("无效的分组顺序");
    if (g.parentId && !groups.some((p) => p.id === g.parentId))
      throw new AppError("上级分组不存在");
    let p = g.parentId;
    const seen = new Set([id]);
    while (p) {
      if (seen.has(p)) throw new AppError("分组不能移入自身或子分组");
      seen.add(p);
      p = groups.find((g) => g.id === p)?.parentId;
    }
    if (
      groups.some(
        (x) =>
          x.id !== id &&
          x.parentId === g.parentId &&
          x.name.toLocaleLowerCase() === g.name.toLocaleLowerCase(),
      )
    )
      throw new AppError("同一级已有这个分组");
    const gid = id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO groups VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id,color=excluded.color,position=excluded.position`,
      )
      .run(
        gid,
        g.name,
        g.parentId,
        g.color,
        g.position,
        old?.sourceProjectId || null,
      );
    this.backup();
    return this.groups().find((g) => g.id === gid);
  }
  deleteGroup(id) {
    const group = this.groups().find((g) => g.id === id);
    if (!group) throw new AppError("分组不存在", 404);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Materialize inherited memberships before dropping their source group.
      for (const t of this.catalog().threads) {
        if (t.groupIds.includes(id)) {
          this.db
            .prepare(
              `INSERT INTO annotations(thread_id,group_ids,updated_at,revision) VALUES(?,?,?,1)
          ON CONFLICT(thread_id) DO UPDATE SET group_ids=excluded.group_ids,updated_at=excluded.updated_at,revision=annotations.revision+1`,
            )
            .run(
              t.id,
              JSON.stringify(t.groupIds.filter((g) => g !== id)),
              Date.now(),
            );
        }
      }
      this.db
        .prepare("UPDATE groups SET parent_id=? WHERE parent_id=?")
        .run(group.parentId, id);
      this.db.prepare("DELETE FROM groups WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.backup();
  }
  export() {
    return {
      format: "codex-navigator",
      version: 1,
      exportedAt: new Date().toISOString(),
      groups: this.groups(),
      annotations: this.db.prepare("SELECT * FROM annotations").all(),
    };
  }
  backup() {
    const directory = join(this.directory, "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `navigator-${Date.now()}-${randomUUID().slice(0, 6)}.json`,
      tmp = join(directory, ".pending");
    writeFileSync(tmp, JSON.stringify(this.export()), { mode: 0o600 });
    renameSync(tmp, join(directory, name));
    const files = readdirSync(directory)
      .filter((x) => /^navigator-.*\.json$/.test(x))
      .sort()
      .reverse();
    files.slice(50).forEach((x) => unlinkSync(join(directory, x)));
  }
  restore(data) {
    if (
      data?.format !== "codex-navigator" ||
      data.version !== 1 ||
      !Array.isArray(data.groups) ||
      !Array.isArray(data.annotations) ||
      data.groups.length > 1000 ||
      data.annotations.length > 20000
    )
      throw new AppError("不是支持的任务架备份");
    const ids = new Set(data.groups.map((g) => g.id));
    if (ids.size !== data.groups.length)
      throw new AppError("备份中分组 ID 重复");
    for (const g of data.groups) {
      if (
        typeof g.id !== "string" ||
        g.id.length > 120 ||
        typeof g.name !== "string" ||
        !g.name.trim() ||
        g.name.length > 60 ||
        !/^#[0-9a-f]{6}$/i.test(g.color) ||
        !Number.isInteger(g.position) ||
        g.position < 0
      )
        throw new AppError("备份分组格式无效");
      const seen = new Set([g.id]);
      let p = g.parentId;
      while (p) {
        if (!ids.has(p) || seen.has(p))
          throw new AppError("备份的分组层级无效");
        seen.add(p);
        p = data.groups.find((g) => g.id === p).parentId;
      }
    }
    const threadIds = new Set();
    for (const a of data.annotations) {
      if (
        typeof a.thread_id !== "string" ||
        a.thread_id.length > 120 ||
        !/^[-a-zA-Z0-9:]+$/.test(a.thread_id) ||
        threadIds.has(a.thread_id) ||
        !intents.includes(a.intent) ||
        typeof a.note !== "string" ||
        a.note.length > 12000 ||
        !Number.isSafeInteger(a.revision) ||
        a.revision < 0 ||
        (a.last_opened_at !== null &&
          (!Number.isSafeInteger(a.last_opened_at) || a.last_opened_at < 0))
      )
        throw new AppError("备份任务格式无效");
      threadIds.add(a.thread_id);
      const groups = parse(a.group_ids, null);
      if (
        groups !== null &&
        (!Array.isArray(groups) || groups.some((id) => !ids.has(id)))
      )
        throw new AppError("备份的任务分组无效");
      if (a.review_at !== null && !validDate(a.review_at))
        throw new AppError("备份日期无效");
    }
    this.backup();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM groups; DELETE FROM annotations;");
      const g = this.db.prepare("INSERT INTO groups VALUES(?,?,?,?,?,?)");
      data.groups.forEach((x) =>
        g.run(
          x.id,
          x.name,
          x.parentId || null,
          x.color,
          x.position,
          x.sourceProjectId || null,
        ),
      );
      const a = this.db.prepare(
        "INSERT INTO annotations VALUES(?,?,?,?,?,?,?,?)",
      );
      data.annotations.forEach((x) =>
        a.run(
          x.thread_id,
          x.intent,
          x.note,
          x.review_at || null,
          x.group_ids || null,
          x.last_opened_at || null,
          Date.now(),
          (x.revision || 0) + 1,
        ),
      );
      this.set("seeded", true);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.backup();
  }
}

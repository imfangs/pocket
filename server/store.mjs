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
function pinFromRow(source, row, pinRevision) {
  const titleRevision = parse(row.title_revision, 0);
  if (row.pocket_pinned == null) return { ...source, pinRevision, titleRevision, pinSource: "codex" };
  return {
    ...source,
    pinRevision,
    titleRevision,
    pinSource: "pocket",
    pinned: row.pocket_pinned === 1,
    pinnedOrder: row.pocket_pinned === 1 ? row.pocket_position : -1,
  };
}
function annotationFromRow(a, source, groups) {
  const defaults = groups
    .filter((g) => g.sourceProjectId && g.sourceProjectId === source?.projectId)
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
      CREATE TABLE IF NOT EXISTS pin_overrides(thread_id TEXT PRIMARY KEY,pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),position INTEGER,updated_at INTEGER NOT NULL,CHECK((pinned=1 AND position IS NOT NULL AND position<0) OR (pinned=0 AND position IS NULL)));
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
    const excludedIds = Object.hasOwn(source, "excludedThreadIds") ? source.excludedThreadIds : [];
    if (!Array.isArray(excludedIds) || excludedIds.some(id => typeof id !== "string" || !id) ||
        new Set(excludedIds).size !== excludedIds.length)
      throw new AppError("来源排除 ID 格式无效");
    const excluded = new Set(excludedIds);
    if (source.threads.some(thread => excluded.has(thread.id)))
      throw new AppError("来源 ID 同时被纳入和排除");
    const excludedStates = new Map();
    if (Object.hasOwn(source, "excludedThreadStates")) {
      const states = source.excludedThreadStates;
      if (!Array.isArray(states) || states.length !== excluded.size)
        throw new AppError("来源排除状态格式无效");
      for (const state of states) {
        if (!state || typeof state !== "object" || Array.isArray(state) ||
            Object.keys(state).some(key => !["id", "archived"].includes(key)) ||
            !excluded.has(state.id) || excludedStates.has(state.id) || typeof state.archived !== "boolean")
          throw new AppError("来源排除状态格式无效");
        excludedStates.set(state.id, state.archived);
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previousRows = this.db.prepare("SELECT s.id,s.data,p.pinned AS pocket_pinned FROM source_threads s LEFT JOIN pin_overrides p ON p.thread_id=s.id").all();
      const previousById = new Map(previousRows.map(row => [row.id, row]));
      let pinsChanged = false, titlesChanged = false;
      const upsert = this.db.prepare(
        "INSERT INTO source_threads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      );
      const seen = new Set();
      for (const t of source.threads) {
        if (seen.has(t.id)) throw new AppError("来源包含重复 ID");
        seen.add(t.id);
        const previous = previousById.get(t.id);
        if (previous && JSON.parse(previous.data).title !== t.title)
          titlesChanged = true;
        if (previous && previous.pocket_pinned == null) {
          const old = JSON.parse(previous.data);
          if (Boolean(old.pinned) !== Boolean(t.pinned) ||
              (t.pinned && old.pinnedOrder !== t.pinnedOrder))
            pinsChanged = true;
        }
        const included = { ...t, missing: false };
        delete included.sourceExcluded;
        upsert.run(t.id, JSON.stringify(included));
      }
      for (const row of previousRows) {
        if (!seen.has(row.id))
          upsert.run(
            row.id,
            JSON.stringify({ ...JSON.parse(row.data),
              ...(excludedStates.has(row.id) ? { archived: excludedStates.get(row.id) } : {}),
              ...(excluded.has(row.id) ? { sourceExcluded: true } : { missing: true }) }),
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
      if (pinsChanged) this.advancePinRevision();
      if (titlesChanged) this.advanceTitleRevision();
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
    return annotationFromRow(a, source, groups);
  }
  thread(id) {
    const row = this.db
      .prepare("SELECT s.data,p.pinned AS pocket_pinned,p.position AS pocket_position,(SELECT value FROM settings WHERE key='pinRevision') AS pin_revision,(SELECT value FROM settings WHERE key='titleRevision') AS title_revision FROM source_threads s LEFT JOIN pin_overrides p ON p.thread_id=s.id WHERE s.id=?")
      .get(id);
    if (!row) throw new AppError("找不到原会话", 404);
    return pinFromRow(JSON.parse(row.data), row, parse(row.pin_revision, 0));
  }
  catalog() {
    const groups = this.groups();
    // Revision lookups share the source/pin SQLite snapshot, so an older
    // catalog response cannot carry a newer revision for an older title.
    const rows = this.db
      .prepare("SELECT s.data,a.*,p.pinned AS pocket_pinned,p.position AS pocket_position,(SELECT value FROM settings WHERE key='pinRevision') AS pin_revision,(SELECT value FROM settings WHERE key='titleRevision') AS title_revision FROM source_threads s LEFT JOIN annotations a ON a.thread_id=s.id LEFT JOIN pin_overrides p ON p.thread_id=s.id")
      .all();
    const pinRevision = parse(rows[0]?.pin_revision, 0);
    const threads = rows.map((row) => {
      const t = pinFromRow(JSON.parse(row.data), row, pinRevision);
      return { ...t, ...annotationFromRow(row, t, groups) };
    });
    return {
      threads: threads.filter(thread => !thread.sourceExcluded),
      // Keep explicit scope separate from missing sources and native archival.
      // Clients also use it to reject late operation metadata for hidden rows.
      excludedThreadIds: threads.filter(thread => thread.sourceExcluded).map(thread => thread.id),
      excludedThreadStates: threads.filter(thread => thread.sourceExcluded)
        .map(thread => ({ id: thread.id, archived: thread.archived })),
      groups,
      projects: this.setting("projects", []),
      sourceInfo: this.setting("sourceInfo"),
      sourceError: this.lastError,
    };
  }
  advancePinRevision() {
    const previous = this.setting("pinRevision", 0);
    if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER)
      throw new AppError("置顶修订编号已超出可用范围");
    this.set("pinRevision", previous + 1);
  }
  advanceTitleRevision() {
    const previous = this.setting("titleRevision", 0);
    if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER)
      throw new AppError("会话名称修订编号已超出可用范围");
    this.set("titleRevision", previous + 1);
  }
  setPin(id, input) {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "pinned") ||
        typeof input.pinned !== "boolean")
      throw new AppError("置顶请求只接受 pinned 布尔值");
    let changed = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.thread(id);
      const previous = this.db.prepare("SELECT pinned FROM pin_overrides WHERE thread_id=?").get(id);
      // Explicitly choosing the source's current value still creates an
      // override, so a later source refresh cannot undo the user's choice.
      if (previous?.pinned !== Number(input.pinned)) {
        const position = input.pinned
          ? Math.min(0, this.db.prepare("SELECT MIN(position) AS minimum FROM pin_overrides").get().minimum ?? 0) - 1
          : null;
        if (position !== null && !Number.isSafeInteger(position))
          throw new AppError("置顶顺序已超出可用范围");
        this.db.prepare(`INSERT INTO pin_overrides(thread_id,pinned,position,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(thread_id) DO UPDATE SET pinned=excluded.pinned,position=excluded.position,updated_at=excluded.updated_at`)
          .run(id, Number(input.pinned), position, Date.now());
        this.advancePinRevision();
        changed = true;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (changed) this.backup();
    const source = this.thread(id);
    return { ...source, ...this.annotation(id, source) };
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
      pins: this.pins(),
    };
  }
  pins() {
    return this.db.prepare("SELECT * FROM pin_overrides ORDER BY thread_id").all()
      .map((pin) => ({ ...pin, pinned: pin.pinned === 1 }));
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
      throw new AppError("不是支持的 Pocket 备份");
    const restorePins = Object.hasOwn(data, "pins");
    if (restorePins) {
      if (!Array.isArray(data.pins) || data.pins.length > 20000)
        throw new AppError("备份置顶格式无效");
      const pinIds = new Set(), positions = new Set();
      for (const pin of data.pins) {
        if (!pin || typeof pin !== "object" || Array.isArray(pin) ||
            Object.keys(pin).some((key) => !["thread_id", "pinned", "position", "updated_at"].includes(key)) ||
            typeof pin.thread_id !== "string" || pin.thread_id.length > 120 ||
            !/^[-a-zA-Z0-9:]+$/.test(pin.thread_id) || pinIds.has(pin.thread_id) ||
            typeof pin.pinned !== "boolean" ||
            !Number.isSafeInteger(pin.updated_at) || pin.updated_at < 0 ||
            (pin.pinned
              ? !Number.isSafeInteger(pin.position) || pin.position >= 0 || positions.has(pin.position)
              : pin.position !== null))
          throw new AppError("备份置顶格式无效");
        pinIds.add(pin.thread_id);
        if (pin.pinned) positions.add(pin.position);
      }
    }
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
      const importedPins = restorePins ? data.pins.map(pin => ({
        thread_id: pin.thread_id, pinned: pin.pinned, position: pin.position, updated_at: pin.updated_at,
      })).sort((a, b) => a.thread_id < b.thread_id ? -1 : a.thread_id > b.thread_id ? 1 : 0) : null;
      const pinsChanged = restorePins && JSON.stringify(this.pins()) !== JSON.stringify(importedPins);
      // A restore must invalidate snapshots from before it, including tasks
      // whose annotations disappear from the imported backup. Keep default
      // rows for those tasks so their revision cannot fall back to zero.
      const previousRevisions = new Map(
        this.db.prepare("SELECT thread_id,revision FROM annotations").all()
          .map((row) => [row.thread_id, row.revision]),
      );
      for (const { id } of this.db.prepare("SELECT id FROM source_threads").all())
        if (!previousRevisions.has(id)) previousRevisions.set(id, 0);
      const nextRevision = (id, importedRevision = 0) => {
        const revision = Math.max(previousRevisions.get(id) || 0, importedRevision);
        if (!Number.isSafeInteger(revision) || revision >= Number.MAX_SAFE_INTEGER)
          throw new AppError("备份修订编号已超出可恢复范围");
        return revision + 1;
      };
      this.db.exec("DELETE FROM groups; DELETE FROM annotations;");
      if (pinsChanged) {
        this.db.exec("DELETE FROM pin_overrides");
        const pin = this.db.prepare("INSERT INTO pin_overrides(thread_id,pinned,position,updated_at) VALUES(?,?,?,?)");
        for (const entry of data.pins)
          pin.run(entry.thread_id, Number(entry.pinned), entry.position, entry.updated_at);
        this.advancePinRevision();
      }
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
          nextRevision(x.thread_id, x.revision),
        ),
      );
      for (const [id] of previousRevisions) {
        if (!threadIds.has(id))
          a.run(id, "none", "", null, null, null, Date.now(), nextRevision(id));
      }
      this.set("seeded", true);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.backup();
  }
}

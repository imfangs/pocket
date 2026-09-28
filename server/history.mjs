import { DatabaseSync } from "node:sqlite";
import {
  openSync,
  closeSync,
  readSync,
  fstatSync,
  realpathSync,
} from "node:fs";
import { join, isAbsolute, sep } from "node:path";
import { AppError } from "./store.mjs";

export function parseHistoryLines(text, startOffset = 0) {
  return parseHistory(text, startOffset).messages;
}

export function parseHistory(text, startOffset = 0) {
  const messages = [];
  const turns = new Map();
  let currentTurnId = null, latestTurnId = null, observedAt = null;
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  let offset = startOffset;
  for (const line of text.split("\n")) {
    try {
      const record = JSON.parse(line),
        item = record.payload;
      const timestamp = Date.parse(record.timestamp);
      if (Number.isFinite(timestamp)) observedAt = timestamp;
      if (record.type === "turn_context" && item?.turn_id) currentTurnId = item.turn_id;
      if (record.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(item?.type)) {
        const id = item.turn_id || (item.type === "turn_aborted" ? currentTurnId : null);
        if (id && Number.isFinite(timestamp)) {
          const turn = turns.get(id) || { turnId: id, startedAt: null, durationMs: null };
          if (item.type === "task_started") {
            Object.assign(turn, { startedAt: timestamp, status: "inProgress", durationMs: null });
            currentTurnId = latestTurnId = id;
          } else {
            turn.status = item.type === "turn_aborted" ? "interrupted" : "completed";
            turn.durationMs = number(item.duration_ms) ?? (turn.startedAt == null ? null : number(timestamp - turn.startedAt));
            if (!latestTurnId || currentTurnId === id) latestTurnId = id;
          }
          turns.set(id, turn);
        }
      }
      if (
        record.type === "response_item" &&
        item?.type === "message" &&
        ["user", "assistant"].includes(item.role) &&
        item.phase !== "analysis"
      ) {
        const value = (item.content || [])
          .filter((c) => ["input_text", "output_text", "text"].includes(c.type))
          .map((c) => c.text || "")
          .join("\n");
        if (value)
          messages.push({
            id: item.id || `rollout:${offset}`,
            role: item.role,
            turnId: currentTurnId,
            text: value.slice(0, 24000),
            phase: item.phase,
            timestamp: Date.parse(record.timestamp) || null,
            truncated: value.length > 24000,
          });
      }
    } catch {
      /* An active append may end with an incomplete JSON record. */
    }
    offset += Buffer.byteLength(line) + 1;
  }
  const marked = new Set();
  for (const message of [...messages].reverse()) {
    const duration = turns.get(message.turnId)?.durationMs;
    if (message.role === "assistant" && ["final", "final_answer"].includes(message.phase) && duration != null && !marked.has(message.turnId)) {
      message.turnDurationMs = duration;
      marked.add(message.turnId);
    }
  }
  let budget = 160000;
  const visible = messages
    .slice(-80)
    .reverse()
    .map((message) => {
      const text = message.text.slice(0, Math.max(0, budget));
      budget -= text.length;
      return {
        ...message,
        text,
        truncated: message.truncated || text.length < message.text.length,
      };
    })
    .filter((m) => m.text)
    .reverse();
  return { messages: visible, turnTiming: latestTurnId ? { ...turns.get(latestTurnId), observedAt } : null };
}

export function readPersistedHistory(codexHome, threadId) {
  const db = new DatabaseSync(join(codexHome, "state_5.sqlite"), {
    readOnly: true,
  });
  let row;
  try {
    row = db
      .prepare("SELECT rollout_path FROM threads WHERE id=?")
      .get(threadId);
  } finally {
    db.close();
  }
  if (!row?.rollout_path) throw new AppError("暂时没有可读取的会话历史", 404);
  const home = realpathSync(codexHome);
  const file = realpathSync(
    isAbsolute(row.rollout_path)
      ? row.rollout_path
      : join(home, row.rollout_path),
  );
  if (
    !["sessions", "archived_sessions"].some((dir) =>
      file.startsWith(join(home, dir) + sep),
    )
  )
    throw new AppError("会话历史位置不在允许的来源目录", 403);
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const header = Buffer.alloc(Math.min(size, 65536));
    readSync(fd, header, 0, header.length, 0);
    const meta = JSON.parse(header.toString("utf8").split("\n")[0]);
    if (meta.type !== "session_meta" || meta.payload?.id !== threadId)
      throw new AppError("会话历史身份不匹配", 409);
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8"),
      offset = start;
    if (start) {
      const end = text.indexOf("\n");
      offset += Buffer.byteLength(text.slice(0, end + 1));
      text = end < 0 ? "" : text.slice(end + 1);
    }
    return {
      source: "rollout",
      ...parseHistory(text, offset),
      hasMore: start > 0,
      runtime: "unavailable",
      canSend: false,
      hint: "显示已保存的历史。连接 Mac 中的原任务后可发送消息。",
    };
  } finally {
    closeSync(fd);
  }
}

import { DatabaseSync } from "node:sqlite";
import {
  openSync,
  closeSync,
  readSync,
  fstatSync,
  realpathSync,
} from "node:fs";
import { join, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "./store.mjs";

const injectedKinds = new Set([
  "agents_md.instructions", "environments.environment_context", "hooks.additional_context",
  "generic.developer_instructions", "memories.instructions", "host_skills.instructions",
  "permissions.instructions", "collaboration_mode.instructions",
  "multi_agent.role_instructions", "multi_agent.mode_instructions",
]);

function visibleContent(item) {
  const content = Array.isArray(item.content) ? item.content : [];
  const kinds = item.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const visible = content.filter((c, index) => c &&
      !(Array.isArray(kinds) && kinds.length === content.length && injectedKinds.has(kinds[index])));
  const value = visible
    .filter(c => ["input_text", "output_text", "text"].includes(c.type))
    .map(c => typeof c.text === "string" ? c.text : "").join("\n");
  // Media-only user messages have a visible timestamp even when this text
  // projection has nothing to render. Never retain their bytes or URLs here.
  const hasMedia = visible.some(c => {
    const fields = ["input_image", "output_image"].includes(c.type) ? ["image_url", "url", "data"]
      : c.type === "input_file" ? ["file_id", "file_data", "file_url"]
      : c.type === "localImage" ? ["path"] : c.type === "image" ? ["url"] : [];
    return fields.some(field => typeof c[field] === "string" && c[field].length > 0);
  });
  if (Array.isArray(kinds)) {
    if (kinds.length && kinds.every(kind => injectedKinds.has(kind))) return { text: "", hasMedia: false };
    return { text: value, hasMedia };
  }
  // Legacy records lack provenance. Recognize only full runtime envelopes;
  // ordinary discussion of AGENTS or memory remains a user message.
  if (item.role === "user" && (
    /^# AGENTS\.md instructions for [^\n]+\n+<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?\s*$/.test(value) ||
    /^<environment_context>[\s\S]*<\/environment_context>\s*$/.test(value)
  )) return { text: "", hasMedia: false };
  return { text: value, hasMedia };
}

export function parseHistoryLines(text, startOffset = 0) {
  return parseHistory(text, startOffset).messages;
}

export function parseHistory(text, startOffset = 0) {
  const messages = [];
  const turns = new Map();
  const responseMessages = new Map(), summaryIds = new Set(), nativeMessageIds = new Set();
  let lastAssistant = null;
  let currentTurnId = null, latestTurnId = null, observedAt = null;
  const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  let offset = startOffset;
  for (const line of text.split("\n")) {
    try {
      const record = JSON.parse(line),
        item = record.payload;
      const lifecycleType = item?.type === "turn_started" ? "task_started" : item?.type === "turn_complete" ? "task_complete" : item?.type;
      const timestamp = Date.parse(record.timestamp);
      if (Number.isFinite(timestamp)) observedAt = timestamp;
      if (record.type === "event_msg" && item?.type === "item_completed" && item.item?.type === "AgentMessage")
        nativeMessageIds.add(item.item.id);
      if (record.type === "token_usage_record" && item?.response_id && lastAssistant)
        responseMessages.set(item.response_id, lastAssistant);
      if (record.type === "compacted") {
        const summary = responseMessages.get(item?.compaction_response_id);
        if (summary) summaryIds.add(summary.id);
        else if (lastAssistant?.fullText && typeof item?.message === "string" && (
          item.message.trim() === lastAssistant.fullText.trim() ||
          item.message.trimEnd().endsWith("\n" + lastAssistant.fullText.trim())
        )) summaryIds.add(lastAssistant.id);
      }
      if (record.type === "turn_context" && item?.turn_id) currentTurnId = item.turn_id;
      if (record.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(lifecycleType)) {
        const id = item.turn_id || (lifecycleType === "turn_aborted" ? currentTurnId : null);
        if (id && Number.isFinite(timestamp)) {
          const turn = turns.get(id) || { turnId: id, startedAt: null, durationMs: null };
          if (lifecycleType === "task_started") {
            Object.assign(turn, { startedAt: timestamp, status: "inProgress", durationMs: null });
            currentTurnId = latestTurnId = id;
            lastAssistant = null;
          } else {
            turn.status = lifecycleType === "turn_aborted" ? "interrupted" : "completed";
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
        const { text: value, hasMedia } = visibleContent(item);
        if (value || hasMedia) {
          const id = item.id || `rollout:${offset}`;
          messages.push({
            id,
            role: item.role,
            turnId: item.internal_chat_message_metadata_passthrough?.turn_id || currentTurnId,
            text: value.slice(0, 24000),
            phase: item.phase,
            timestamp: Number.isFinite(timestamp) ? timestamp : null,
            truncated: value.length > 24000,
          });
          if (item.role === "assistant") lastAssistant = { id, fullText: value };
        }
      }
    } catch {
      /* An active append may end with an incomplete JSON record. */
    }
    offset += Buffer.byteLength(line) + 1;
  }
  const visibleMessages = messages.filter(m => !summaryIds.has(m.id) || nativeMessageIds.has(m.id));
  const lastMessageAt = visibleMessages.at(-1)?.timestamp ?? null;
  const textMessages = visibleMessages.filter(m => m.text);
  const hiddenTurns = new Set(messages.filter(m => summaryIds.has(m.id) && !nativeMessageIds.has(m.id)).map(m => m.turnId));
  const visibleTurns = new Set(visibleMessages.map(m => m.turnId));
  if (hiddenTurns.has(latestTurnId) && !visibleTurns.has(latestTurnId))
    latestTurnId = [...turns.keys()].reverse().find(id => !hiddenTurns.has(id) || visibleTurns.has(id)) || null;
  const marked = new Set();
  for (const message of [...textMessages].reverse()) {
    const duration = turns.get(message.turnId)?.durationMs;
    if (message.role === "assistant" && ["final", "final_answer"].includes(message.phase) && duration != null && !marked.has(message.turnId)) {
      message.turnDurationMs = duration;
      marked.add(message.turnId);
    }
  }
  let budget = 160000;
  const visible = textMessages
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
  return { messages: visible, lastMessageAt, turnTiming: latestTurnId ? { ...turns.get(latestTurnId), observedAt } : null };
}

function openHistorySource(codexHome, threadId) {
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
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new AppError("会话历史不是普通文件", 403);
    const size = Number(stat.size);
    const header = Buffer.alloc(Math.min(size, 65536));
    readSync(fd, header, 0, header.length, 0);
    const meta = JSON.parse(header.toString("utf8").split("\n")[0]);
    if (meta.type !== "session_meta" || meta.payload?.id !== threadId)
      throw new AppError("会话历史身份不匹配", 409);
    return { fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readHistorySourceVersion(codexHome, threadId) {
  const { fd, stat } = openHistorySource(codexHome, threadId);
  try {
    return createHash("sha256").update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String))).digest("hex");
  } finally { closeSync(fd); }
}

export function readPersistedHistory(codexHome, threadId) {
  const { fd, stat } = openHistorySource(codexHome, threadId);
  try {
    const size = Number(stat.size);
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    // Skip a clipped line as raw bytes before decoding: a UTF-8 character
    // split at the tail boundary would otherwise change fallback message IDs.
    const end = start ? buffer.indexOf(10) : -1;
    const skip = start ? (end < 0 ? buffer.length : end + 1) : 0;
    const offset = start + skip;
    const text = buffer.subarray(skip).toString("utf8");
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

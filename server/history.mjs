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
import { POCKET_CONTENT, EMPTY_CONTENT_VERSION, assistantContentVersion, contentFileVersion, contentEvidence } from './pocket-content.mjs';
import { historyMessageProjection } from './history-message.mjs';
import { turnFailureFromError } from '../shared/turn-failure.mjs';
import { userAttachmentEnvelope } from '../shared/user-attachment-envelope.mjs';

const injectedKinds = new Set([
  "agents_md.instructions", "environments.environment_context", "hooks.additional_context",
  "generic.developer_instructions", "memories.instructions", "host_skills.instructions",
  "permissions.instructions", "collaboration_mode.instructions",
  "multi_agent.role_instructions", "multi_agent.mode_instructions",
]);

const descriptivePath = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') &&
  value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);

function userAttachmentPaths(content, text) {
  const localImages = content.filter(part => part.type === 'localImage' && descriptivePath(part.path));
  if (localImages.length) return [...new Map(localImages.slice(0, 32).map(part =>
    [part.path, { path: part.path, name: part.path.split('/').at(-1), kind: 'image' }])).values()];
  const envelope = userAttachmentEnvelope(text);
  if (!envelope?.imageTransport) return [];
  const images = envelope.attachments.filter(attachment => attachment.kind === 'image');
  // The rollout represents an uploaded image as text(open), typed image, then
  // text(close). Require that exact native seam; a literal XML example cannot
  // promote paths into even descriptive attachment metadata.
  if (content.length !== 1 + images.length * 3 ||
      !['input_text', 'text'].includes(content[0]?.type) ||
      userAttachmentEnvelope(content[0]?.text)?.query !== envelope.query) return [];
  for (let index = 0; index < images.length; index++) {
    const [open, image, close] = content.slice(1 + index * 3, 4 + index * 3);
    if (open?.type !== 'input_text' || open.text !== `<image name=[Image #${index + 1}] path="${images[index].path}">` ||
        image?.type !== 'input_image' || typeof image.image_url !== 'string' ||
        !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(image.image_url) ||
        close?.type !== 'input_text' || close.text !== '</image>') return [];
  }
  return envelope.attachments;
}

export function visibleContent(item) {
  const content = Array.isArray(item.content) ? item.content : [];
  const kinds = item.internal_chat_message_metadata_passthrough?.content_item_kinds;
  // A broken mixed-provenance list cannot safely identify which item contains
  // authored text. Do not promote an injected item merely because lengths differ.
  if (Array.isArray(kinds) && kinds.length !== content.length && kinds.some(kind => injectedKinds.has(kind)))
    return { text: '', hasMedia: false };
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
  const paths = item.role === 'user' ? userAttachmentPaths(visible, value) : [];
  const projection = { text: value, hasMedia, ...(paths.length ? { attachmentPaths: paths } : {}) };
  if (Array.isArray(kinds)) {
    if (kinds.length && kinds.every(kind => injectedKinds.has(kind))) return { text: "", hasMedia: false };
    return projection;
  }
  // Legacy records lack provenance. Recognize only full runtime envelopes;
  // ordinary discussion of AGENTS or memory remains a user message.
  if (item.role === "user" && (
    /^# AGENTS\.md instructions for [^\n]+\n+<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?\s*$/.test(value) ||
    /^<environment_context>[\s\S]*<\/environment_context>\s*$/.test(value)
  )) return { text: "", hasMedia: false };
  return projection;
}

export function parseHistoryLines(text, startOffset = 0) {
  return parseHistory(text, startOffset).messages;
}

export function parseHistory(text, startOffset = 0) {
  const messages = [];
  const contentVersions = new Map();
  const turns = new Map();
  const failures = new Map();
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
            failures.delete(id);
            Object.assign(turn, { startedAt: timestamp, status: "inProgress", durationMs: null });
            currentTurnId = latestTurnId = id;
            lastAssistant = null;
          } else {
            const failure = lifecycleType === "task_complete" ? turnFailureFromError(id, item.error, timestamp) : null;
            turn.status = lifecycleType === "turn_aborted" ? "interrupted" : failure ? "failed" : "completed";
            if (failure) failures.set(id, failure); else failures.delete(id);
            turn.durationMs = number(item.duration_ms) ?? (turn.startedAt == null ? null : number(timestamp - turn.startedAt));
            if (!latestTurnId || currentTurnId === id) latestTurnId = id;
          }
          turns.set(id, turn);
        }
      }
      const projected = historyMessageProjection(record), displayItem = projected?.item;
      if (displayItem && ["user", "assistant"].includes(displayItem.role) &&
        displayItem.phase !== "analysis" && displayItem.channel !== "analysis") {
        const { text: value, hasMedia, attachmentPaths } = visibleContent(displayItem);
        if (value || hasMedia) {
          const id = displayItem.id || `rollout:${offset}`;
          const message = {
            id,
            role: displayItem.role,
            turnId: displayItem.internal_chat_message_metadata_passthrough?.turn_id || currentTurnId,
            text: value.slice(0, 24000),
            phase: displayItem.phase,
            timestamp: Number.isFinite(timestamp) ? timestamp : null,
            truncated: value.length > 24000,
            ...(projected.origin ? { origin: projected.origin } : {}),
            ...(attachmentPaths?.length ? { attachmentPaths } : {}),
          };
          messages.push(message);
          if (displayItem.role === "assistant" && value)
            contentVersions.set(message, assistantContentVersion(id, value, displayItem.phase));
          if (displayItem.role === "assistant") lastAssistant = { id, fullText: value };
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
  const lastReadableAssistant = textMessages.findLast(message => message.role === "assistant");
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
  let budgetTruncated = false;
  const visible = textMessages
    .slice(-80)
    .reverse()
    .map((message) => {
      const text = message.text.slice(0, Math.max(0, budget));
      // Individual messages were already capped above. Only a further loss to
      // the aggregate window can be recovered by loading an earlier page.
      budgetTruncated ||= text.length < message.text.length;
      budget -= text.length;
      return {
        ...message,
        text,
        truncated: message.truncated || text.length < message.text.length,
      };
    })
    .filter((m) => m.text)
    .reverse();
  const target = visible.findLast(message => message.role === "assistant");
  const content = lastReadableAssistant ? { known: true, version: contentVersions.get(lastReadableAssistant),
    messageId: lastReadableAssistant.id, readable: target?.id === lastReadableAssistant.id && !target.truncated }
    : startOffset === 0 ? { known: true, version: EMPTY_CONTENT_VERSION, messageId: null, readable: false }
      : { known: false };
  return { messages: visible, hasMore: budgetTruncated || textMessages.length > visible.length, lastMessageAt, [POCKET_CONTENT]: content,
    turnFailures: [...failures.values()].slice(-30),
    turnTiming: latestTurnId ? { ...turns.get(latestTurnId), observedAt } : null };
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
    if (readSync(fd, header, 0, header.length, 0) !== header.length)
      throw new AppError("会话历史正在变化，请稍后重试", 409);
    const meta = JSON.parse(header.toString("utf8").split("\n")[0]);
    if (meta.type !== "session_meta" || meta.payload?.id !== threadId)
      throw new AppError("会话历史身份不匹配", 409);
    return { fd, stat, file };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readHistorySourceVersion(codexHome, threadId) {
  const { fd, stat } = openHistorySource(codexHome, threadId);
  try {
    if (contentFileVersion(stat) !== contentFileVersion(fstatSync(fd, { bigint: true })))
      throw new AppError("会话历史正在变化，请稍后重试", 409);
    return createHash("sha256").update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeNs].map(String))).digest("hex");
  } finally { closeSync(fd); }
}

export function readPersistedHistory(codexHome, threadId) {
  const { fd, stat, file } = openHistorySource(codexHome, threadId);
  try {
    const size = Number(stat.size);
    const start = Math.max(0, size - 4 * 1024 * 1024);
    const readStart = Math.max(0, start - 1);
    const buffer = Buffer.alloc(size - readStart);
    if (readSync(fd, buffer, 0, buffer.length, readStart) !== buffer.length)
      throw new AppError("会话历史正在变化，请稍后重试", 409);
    // Skip a clipped line as raw bytes before decoding: a UTF-8 character
    // split at the tail boundary would otherwise change fallback message IDs.
    const end = start ? buffer.indexOf(10) : -1;
    const skip = start ? (end < 0 ? buffer.length : end + 1) : 0;
    const offset = readStart + skip;
    const text = buffer.subarray(skip).toString("utf8");
    const parsed = parseHistory(text, offset);
    const stable = contentFileVersion(stat) === contentFileVersion(fstatSync(fd, { bigint: true }));
    const content = stable ? contentEvidence(parsed[POCKET_CONTENT], file, contentFileVersion(stat))
      : contentEvidence({ known: false }, file, contentFileVersion(stat));
    return {
      source: "rollout",
      ...parsed,
      [POCKET_CONTENT]: content,
      hasMore: start > 0 || parsed.hasMore,
      runtime: "unavailable",
      canSend: false,
      hint: "历史已载入，连接后可发送。",
    };
  } finally {
    closeSync(fd);
  }
}

export { HistoryPageReader, readPersistedHistoryPage, readPersistedHistoryRecent } from './history-pages.mjs';

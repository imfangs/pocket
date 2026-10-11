import { Check, MessageSquareText, MoreHorizontal, UserRound } from "lucide-react";
import CopyButton from "./CopyButton";
import MessageMarkdown from "./MessageMarkdown";
import { readableQuestionReply } from "./questionReply";
import type { Message } from "./conversationFeed";
import { formatDuration } from "./TurnDuration";
import { readableCodexMarkdown } from "./codexMarkup";
import { useMemo } from "react";
import AttachmentList from "./AttachmentList";

export default function ConversationMessage({ message, recentlySent = false }: { message: Message; recentlySent?: boolean }) {
  const displayText = useMemo(() => message.role === "user"
    ? readableQuestionReply(message.text) : readableCodexMarkdown(message.text), [message.role, message.text]);
  const progress =
    message.role === "assistant" && message.phase === "commentary";
  const final = message.phase === "final_answer" || message.phase === "final";
  const kind =
    message.role === "user" ? "user" : progress ? "progress" : "answer";
  const label =
    kind === "user"
      ? "你"
      : message.isQuestion
        ? "Codex · 问题"
        : progress
          ? "Codex · 过程"
          : final
            ? "Codex · 最终回复"
            : "Codex · 回复";
  const Icon =
    kind === "user" ? UserRound : progress ? MoreHorizontal : MessageSquareText;
  const confirmed = kind === "user" && recentlySent;
  return (
    <article
      className={`conversation-message ${message.role} message-${kind}${confirmed ? " is-recently-sent" : ""}`}
      data-message-id={message.id}
      aria-label={label}
    >
      <div className="message-label">
        <strong>
          <Icon size={13} aria-hidden="true" />
          <span className="message-role">{kind === "user" ? "你" : "Codex"}</span>
          {kind !== "user" && <span className="message-phase">{message.isQuestion ? "问题" : progress ? "过程" : "回复"}</span>}
        </strong>
        <div className="message-meta">
          {confirmed && <span className="message-send-confirmed"><Check size={13} aria-hidden="true" />已发送</span>}
          {message.timestamp && (
            <time dateTime={new Date(message.timestamp).toJSON() ?? undefined}>
              {new Date(message.timestamp).toLocaleString("zh-CN", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          )}
          {kind !== "progress" && displayText.trim() && (
            <CopyButton text={displayText} label={kind === "user" ? "复制这条消息" : "复制回复"} />
          )}
        </div>
      </div>
      <MessageMarkdown
        images={message.images}
        text={displayText}
        codex={false}
      />
      <AttachmentList attachments={message.attachments} />
      {final && message.turnDurationMs != null && (
        <div className="message-duration">总用时 <time>{formatDuration(message.turnDurationMs)}</time></div>
      )}
      {message.truncated && <small>内容较长，此处已截取。</small>}
    </article>
  );
}

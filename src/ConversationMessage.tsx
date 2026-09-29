import { MessageSquareText, MoreHorizontal, UserRound } from "lucide-react";
import CopyButton from "./CopyButton";
import MessageMarkdown from "./MessageMarkdown";
import { readableQuestionReply } from "./questionReply";
import type { Message } from "./conversationFeed";
import { formatDuration } from "./TurnDuration";

export default function ConversationMessage({ message }: { message: Message }) {
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
  return (
    <article
      className={`conversation-message ${message.role} message-${kind}`}
      aria-label={label}
    >
      <div className="message-label">
        <strong>
          <Icon size={13} aria-hidden="true" />
          {label}
        </strong>
        <div className="message-meta">
          {message.timestamp && (
            <time>
              {new Date(message.timestamp).toLocaleString("zh-CN", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          )}
          {kind === "answer" && (
            <CopyButton text={message.text} label="复制回复" />
          )}
        </div>
      </div>
      <MessageMarkdown
        images={message.images}
        text={
          message.role === "user"
            ? readableQuestionReply(message.text)
            : message.text
        }
      />
      {final && message.turnDurationMs != null && (
        <div className="message-duration">总用时 <time>{formatDuration(message.turnDurationMs)}</time></div>
      )}
      {message.truncated && <small>内容较长，此处已截取。</small>}
    </article>
  );
}

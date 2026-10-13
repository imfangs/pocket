import { Check } from "lucide-react";
import CopyButton from "./CopyButton";
import MessageMarkdown from "./MessageMarkdown";
import { readableQuestionReply } from "./questionReply";
import type { Message } from "./conversationFeed";
import { formatDuration } from "./TurnDuration";
import { readableCodexMarkdown } from "./codexMarkup";
import { useMemo } from "react";
import AttachmentList from "./AttachmentList";
import UserQueryBody, { type QueryDisclosure } from "./UserQueryBody";
import "./message-footer.css";

export default function ConversationMessage({ message, recentlySent = false, queryDisclosure }: {
  message: Message; recentlySent?: boolean; queryDisclosure?: QueryDisclosure;
}) {
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
  const confirmed = kind === "user" && recentlySent;
  const copyable = !!displayText.trim();
  const date = message.timestamp ? new Date(message.timestamp) : null;
  const dateTime = date?.toJSON();
  const duration = final && message.turnDurationMs != null ? formatDuration(message.turnDurationMs) : null;
  return (
    <article
      className={`conversation-message ${message.role} message-${kind}${confirmed ? " is-recently-sent" : ""}`}
      data-message-id={message.id}
      aria-label={label}
    >
      {kind === "user" && queryDisclosure ? <UserQueryBody text={displayText} images={message.images} disclosure={queryDisclosure} /> : <MessageMarkdown
        images={message.images}
        text={displayText}
        codex={false}
      />}
      <AttachmentList attachments={message.attachments} />
      {message.truncated && <small>内容较长，此处已截取。</small>}
      {(dateTime || copyable || confirmed || duration) && <footer className="message-footer">
        {confirmed && <span className="message-send-confirmed"><Check size={13} aria-hidden="true" />已发送</span>}
        {duration && <span className="message-duration">总用时 <time>{duration}</time></span>}
        {dateTime && <time className="message-timestamp" dateTime={dateTime}>
          {date!.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </time>}
        {copyable && <CopyButton text={displayText} label={kind === "user" ? "复制这条消息" : progress ? "复制过程" : "复制回复"} />}
      </footer>}
    </article>
  );
}

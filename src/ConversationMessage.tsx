import { Check } from "lucide-react";
import CopyButton from "./CopyButton";
import MessageMarkdown from "./MessageMarkdown";
import { presentUserMessage } from "./userMessage";
import AnnotationQuotes, { type AnnotationLayoutChange } from "./AnnotationQuotes";
import type { Message } from "./conversationFeed";
import { formatDuration } from "./TurnDuration";
import { readableCodexMarkdown } from "./codexMarkup";
import { useMemo, type Ref } from "react";
import AttachmentList from "./AttachmentList";
import UserQueryBody, { type QueryDisclosure } from "./UserQueryBody";
import MessageTimestamp from "./MessageTimestamp";
import { validMessageTimestamp } from "./messageTime";
import "./message-footer.css";

export default function ConversationMessage({ message, threadId, recentlySent = false, queryDisclosure, readMarker, changeLayout }: {
  message: Message; threadId?: string; recentlySent?: boolean; queryDisclosure?: QueryDisclosure; readMarker?: Ref<HTMLDivElement>; changeLayout?: AnnotationLayoutChange;
}) {
  const presentation = useMemo(() => {
    if (message.role === "user") return presentUserMessage(message.text);
    const text = readableCodexMarkdown(message.text);
    return { text, copyText: text, annotations: [] };
  }, [message.role, message.text]);
  const displayText = presentation.text;
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
  const copyable = !!presentation.copyText.trim();
  const timestamp = message.timestamp;
  const hasTimestamp = validMessageTimestamp(timestamp);
  const duration = final && message.turnDurationMs != null ? formatDuration(message.turnDurationMs) : null;
  return (
    <article
      className={`conversation-message ${message.role} message-${kind}${confirmed ? " is-recently-sent" : ""}`}
      data-message-id={message.id}
      aria-label={label}
    >
      {displayText.trim() && (kind === "user" && queryDisclosure ? <UserQueryBody text={displayText} images={message.images} disclosure={queryDisclosure} /> : <MessageMarkdown
        images={message.images}
        files={message.role === "assistant" && !message.truncated ? message.files : undefined}
        threadId={threadId}
        text={displayText}
        codex={false}
      />)}
      {presentation.annotations.length > 0 && <AnnotationQuotes annotations={presentation.annotations} changeLayout={changeLayout} />}
      <AttachmentList attachments={message.attachments} />
      {message.truncated && <small>内容较长，此处已截取。</small>}
      {(hasTimestamp || copyable || confirmed || duration) && <footer className="message-footer">
        {confirmed && <span className="message-send-confirmed"><Check size={13} aria-hidden="true" />已发送</span>}
        {duration && <span className="message-duration">总用时 <time>{duration}</time></span>}
        {hasTimestamp && <MessageTimestamp timestamp={timestamp} />}
        {copyable && <CopyButton text={presentation.copyText} label={kind === "user" ? "复制这条消息" : progress ? "复制过程" : "复制回复"} />}
      </footer>}
      {readMarker && <div ref={readMarker} data-pocket-read-marker="" aria-hidden="true" style={{ height: 1 }} />}
    </article>
  );
}

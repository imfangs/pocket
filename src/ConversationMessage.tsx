import { AppIcon } from "./ui/AppIcon";
import { t, useLocale } from "./i18n";
import { Check } from "lucide-react";
import CopyButton from "./CopyButton";
import MessageMarkdown from "./MessageMarkdown";
import { presentUserMessage } from "./userMessage";
import AnnotationQuotes, { type AnnotationLayoutChange } from "./AnnotationQuotes";
import type { Message } from "./conversationFeed";
import { formatDuration } from "./TurnDuration";
import { readableCodexMarkdown } from "./codexMarkup";
import { useMemo, type Ref, type ReactNode } from "react";
import AttachmentList from "./AttachmentList";
import UserQueryBody, { type QueryDisclosure } from "./UserQueryBody";
import HeartbeatTrigger from "./HeartbeatTrigger";
import SubagentNotificationMessage from "./SubagentNotificationMessage";
import { subagentNotification } from "./subagentNotification";
import MessageTimestamp, { ProgressMessageFooter } from "./MessageTimestamp";
import { validMessageTimestamp } from "./messageTime";
import "./message-footer.css";

export default function ConversationMessage({ message, threadId, recentlySent = false, queryDisclosure, readMarker, changeLayout, queryDelivery }: {
  message: Message; threadId?: string; recentlySent?: boolean; queryDisclosure?: QueryDisclosure; readMarker?: Ref<HTMLDivElement>; changeLayout?: AnnotationLayoutChange;
  queryDelivery?: { requestId: string; state?: string; controls: ReactNode; hasControls: boolean };
}) {
  const locale = useLocale();
  const notification = useMemo(() => subagentNotification(message.text), [message.text]);
  const presentation = useMemo(() => {
    if (notification) return { text: notification.text, copyText: [t(notification.label), notification.text].filter(Boolean).join("\n\n"), annotations: [] };
    if (message.role === "user") return presentUserMessage(message.text, t);
    const text = readableCodexMarkdown(message.text, t);
    return { text, copyText: text, annotations: [], automationInstructions: undefined };
  }, [message.role, message.text, notification, locale]);
  const displayText = presentation.text;
  const progress =
    message.role === "assistant" && message.phase === "commentary";
  const final = message.phase === "final_answer" || message.phase === "final";
  const kind =
    notification ? "notification" : message.role === "user" ? "user" : progress ? "progress" : "answer";
  const label =
    notification ? notification.label : kind === "user"
      ? "你"
      : message.isQuestion
        ? "Codex · 问题"
        : progress
          ? "Codex · 过程"
          : final
            ? "Codex · 最终回复"
            : "Codex · 回复";
  const confirmed = kind === "user" && recentlySent;
  const copyable = kind !== "progress" && !!presentation.copyText.trim();
  const timestamp = message.timestamp;
  const hasTimestamp = validMessageTimestamp(timestamp);
  const duration = final && message.turnDurationMs != null ? formatDuration(message.turnDurationMs) : null;
  return (
    <article
      className={`conversation-message ${message.role} message-${kind}${confirmed ? " is-recently-sent" : ""}${queryDelivery ? " query-message" : ""}`}
      data-message-id={message.id}
      data-query-id={queryDelivery?.requestId}
      data-query-state={queryDelivery?.state}
      tabIndex={queryDelivery ? -1 : undefined}
      aria-label={t(label)}
    >
      {notification ? <SubagentNotificationMessage notification={notification} changeLayout={changeLayout} readMarker={readMarker} /> : presentation.automationInstructions ? <HeartbeatTrigger instructions={presentation.automationInstructions} changeLayout={changeLayout} /> : displayText.trim() && (kind === "user" && queryDisclosure ? <UserQueryBody text={displayText} images={message.images} disclosure={queryDisclosure} /> : <MessageMarkdown
        images={message.images}
        files={message.role === "assistant" && !message.truncated ? message.files : undefined}
        threadId={threadId}
        text={displayText}
        codex={false}
      />)}
      {presentation.annotations.length > 0 && <AnnotationQuotes annotations={presentation.annotations} changeLayout={changeLayout} />}
      <AttachmentList attachments={message.attachments} />
      {message.truncated && <small>{t("内容较长，此处已截取。")}</small>}
      {queryDelivery?.controls}
      {kind === "progress" ? hasTimestamp && <ProgressMessageFooter timestamp={timestamp} /> : (hasTimestamp || copyable || confirmed || duration) && <footer className="message-footer">
        {confirmed && !queryDelivery?.hasControls && <span className="message-send-confirmed"><AppIcon icon={Check} kind="marker" aria-hidden="true" />{t("已发送")}</span>}
        {duration && <span className="message-duration">{t("总用时")} <time>{duration}</time></span>}
        {hasTimestamp && <MessageTimestamp timestamp={timestamp} />}
        {copyable && <CopyButton text={presentation.copyText} label={notification ? t("复制子任务结果") : kind === "user" ? t("复制这条消息") : t("复制回复")} />}
      </footer>}
      {readMarker && !notification?.text && <div ref={readMarker} data-pocket-read-marker="" aria-hidden="true" style={{ height: 1 }} />}
    </article>
  );
}

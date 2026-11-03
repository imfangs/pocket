import { useSyncExternalStore } from "react";
import { messageClock, messageTime, progressMessageTime } from "./messageTime";
import { t, useLocale } from "./i18n";

function TimeValue({ time }: { time: NonNullable<ReturnType<typeof messageTime>> }) {
  return <time className="message-timestamp" dateTime={time.dateTime} title={t("消息时间：{{time}}", { time: time.absolute })} aria-label={t("消息时间：{{time}}", { time: time.absolute })}>
    {time.label}
  </time>;
}

export default function MessageTimestamp({ timestamp }: { timestamp: number }) {
  useLocale();
  const now = useSyncExternalStore(messageClock.subscribe, messageClock.getSnapshot, messageClock.getSnapshot);
  const time = messageTime(timestamp, now);
  return time ? <TimeValue time={time} /> : null;
}

// Keep expiry updates within the footer so the shared minute clock never
// rerenders the process body, its code controls or an active text selection.
export function ProgressMessageFooter({ timestamp }: { timestamp?: number }) {
  useLocale();
  const now = useSyncExternalStore(messageClock.subscribe, messageClock.getSnapshot, messageClock.getSnapshot);
  const time = progressMessageTime(timestamp, now);
  return time ? <footer className="message-footer"><TimeValue time={time} /></footer> : null;
}

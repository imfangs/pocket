import { useSyncExternalStore } from "react";
import { messageClock, messageTime } from "./messageTime";

export default function MessageTimestamp({ timestamp }: { timestamp: number }) {
  const now = useSyncExternalStore(messageClock.subscribe, messageClock.getSnapshot, messageClock.getSnapshot);
  const time = messageTime(timestamp, now);
  if (!time) return null;
  return <time className="message-timestamp" dateTime={time.dateTime} title={`消息时间：${time.absolute}`} aria-label={`消息时间：${time.absolute}`}>
    {time.label}
  </time>;
}

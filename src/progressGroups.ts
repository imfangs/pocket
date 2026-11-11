import type { Message } from "./conversationFeed";
import { readableCodexMarkdown } from "./codexMarkup.ts";

export type ProgressMessageEntry =
  | { type: "message"; message: Message }
  | { type: "progress"; id: string; turnId: string; messages: Message[] };

const hasTurnId = (message: Message): message is Message & { turnId: string } =>
  typeof message.turnId === "string" && message.turnId.trim().length > 0;

// Only a final reply already present in the displayed transcript can fold its
// earlier process messages. Runtime/idle status and other feeds are irrelevant.
export function groupProgressMessages(
  messages: readonly Message[],
  protectedMessageIds?: ReadonlySet<string>,
): ProgressMessageEntry[] {
  const firstFinalByTurn = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === "assistant" && !message.isQuestion && hasTurnId(message) &&
        (message.phase === "final" || message.phase === "final_answer") &&
        !firstFinalByTurn.has(message.turnId) && readableCodexMarkdown(message.text).trim())
      firstFinalByTurn.set(message.turnId, index);
  });

  const entries: ProgressMessageEntry[] = [];
  const groupOccurrences = new Map<string, number>();
  messages.forEach((message, index) => {
    const canFold = message.role === "assistant" && message.phase === "commentary" &&
      hasTurnId(message) && !message.isQuestion && !protectedMessageIds?.has(message.id) &&
      index < (firstFinalByTurn.get(message.turnId) ?? -1);
    if (!canFold || !hasTurnId(message)) {
      entries.push({ type: "message", message });
      return;
    }
    const previous = entries.at(-1);
    if (previous?.type === "progress" && previous.turnId === message.turnId)
      previous.messages.push(message);
    else {
      const base = JSON.stringify([message.turnId, message.id]);
      const occurrence = groupOccurrences.get(base) ?? 0;
      groupOccurrences.set(base, occurrence + 1);
      entries.push({ type: "progress", id: `progress:${occurrence ? JSON.stringify([message.turnId, message.id, occurrence]) : base}`,
        turnId: message.turnId, messages: [message] });
    }
  });
  return entries;
}

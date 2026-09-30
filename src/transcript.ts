import type { History, Message, SavedTranscript } from "./conversationFeed";

function bounded(messages: Message[]) {
  let remaining = 160000;
  return messages.slice(-80).reverse().map(message => {
    const text = message.text.slice(0, Math.max(0, Math.min(24000, remaining)));
    remaining -= text.length;
    return text === message.text ? message : { ...message, text, truncated: true };
  }).filter(message => message.text).reverse();
}

// Merge only display text, never runtime/capability fields. Shared IDs establish
// order; divergent branches keep the canonical desktop result.
export function displayMessages(history: History | null, transcript: SavedTranscript | null): Message[] {
  const live = history?.messages || [], saved = transcript?.messages || [];
  if (!saved.length) return live;
  if (!live.length) return saved;
  const a = history?.turnTiming, b = transcript?.turnTiming;
  const isFinal = (message: Message) => message.role === "assistant" && ["final", "final_answer"].includes(message.phase || "");
  if (history?.source === "desktop" && a?.turnId && a.turnId === b?.turnId && b.status === "completed" &&
      saved.some(message => message.turnId === b.turnId && isFinal(message)) &&
      !live.some(message => message.turnId === a.turnId && isFinal(message))) {
    // Native and recorded user messages can have different IDs. A recorded final
    // for the same completed turn is positive evidence, not a text-based guess.
    return bounded([...live.filter(message => message.turnId !== a.turnId),
      ...saved.filter(message => message.turnId === b.turnId)]);
  }
  const index = new Map(live.map((message, i) => [message.id, i]));
  let anchor = saved.length - 1;
  while (anchor >= 0 && !index.has(saved[anchor].id)) anchor--;
  if (anchor < 0) {
    return a?.turnId && b?.turnId && a.turnId !== b.turnId &&
      a.startedAt != null && b.startedAt != null && b.startedAt > a.startedAt ? saved : live;
  }
  const savedById = new Map(saved.map(message => [message.id, message]));
  const merged = live.map(message => {
    const next = savedById.get(message.id);
    if (!next || next.role !== message.role || !next.text.startsWith(message.text)) return message;
    return { ...next, ...message, text: next.text, truncated: next.truncated,
      phase: next.phase ?? message.phase, turnDurationMs: next.turnDurationMs ?? message.turnDurationMs,
      images: next.images ?? message.images };
  });
  if (index.get(saved[anchor].id) === live.length - 1) merged.push(...saved.slice(anchor + 1));
  return bounded(merged);
}

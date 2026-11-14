import type { History, Message, SavedTranscript } from "./conversationFeed";

function bounded(messages: Message[], hasMore = false) {
  let remaining = 160000;
  let budgetTruncated = false;
  const visible = messages.slice(-80).reverse().map(message => {
    const messageLimit = Math.min(24000, message.text.length);
    const available = Math.max(0, Math.min(messageLimit, remaining));
    budgetTruncated ||= available < messageLimit;
    const text = message.text.slice(0, available);
    remaining -= text.length;
    return text === message.text ? message : { ...message, text, truncated: true };
  }).filter(message => message.text || message.attachments?.length || message.unavailableAttachments?.length).reverse();
  return { messages: visible, hasMore: hasMore || budgetTruncated || visible.length < messages.length };
}

function savedEarlierBoundary(displayed: Message[], saved: Message[], hasMore: boolean) {
  const positions = new Map(displayed.map((message, index) => [message.id, { message, index }]));
  let boundary = -1, lastDisplayed = -1, lastSaved = -1;
  for (let index = 0; index < saved.length; index++) {
    const message = saved[index], match = positions.get(message.id);
    if (!match || match.message.role !== message.role ||
        match.message.turnId && message.turnId && match.message.turnId !== message.turnId) continue;
    if (match.index <= lastDisplayed) return false;
    if (match.index === 0) boundary = index;
    lastDisplayed = match.index; lastSaved = index;
  }
  // A longer native prefix already covers a shorter saved tail. Only borrow
  // the saved boundary when it reaches our first visible message and the two
  // ordered views do not continue into different, unshared tails.
  return boundary >= 0 && (lastDisplayed === displayed.length - 1 || lastSaved === saved.length - 1) &&
    (hasMore || boundary > 0);
}

// Merge only display text, never runtime/capability fields. Shared IDs establish
// order; divergent branches keep the canonical desktop result.
export function displayConversation(history: History | null, transcript: SavedTranscript | null): { messages: Message[]; hasMore: boolean } {
  const live = history?.messages || [];
  const saved = (transcript?.messages || []).filter(message => message.origin !== "codex_delegation" ||
    !message.turnId || !live.some(native => native.role === "user" && native.turnId === message.turnId && native.id !== message.id));
  const nativeView = { messages: live, hasMore: !!history?.hasMore };
  const savedView = { messages: saved, hasMore: !!transcript?.hasMore };
  if (!saved.length) return nativeView;
  if (!live.length) return savedView;
  const a = history?.turnTiming, b = transcript?.turnTiming;
  const isFinal = (message: Message) => message.role === "assistant" && !message.isQuestion && ["final", "final_answer"].includes(message.phase || "");
  if (history?.source === "desktop" && a?.turnId && a.turnId === b?.turnId && b.status === "completed" &&
      saved.some(message => message.turnId === b.turnId && isFinal(message)) &&
      !live.some(message => message.turnId === a.turnId && isFinal(message))) {
    // Native and recorded user messages can have different IDs. A recorded final
    // for the same completed turn is positive evidence, not a text-based guess.
    const completed = saved.filter(message => message.turnId === b.turnId);
    const hasDelegatedInput = transcript?.messages.some(message => message.origin === "codex_delegation" && message.turnId === b.turnId);
    const nativeInput = hasDelegatedInput && !completed.some(message => message.role === "user")
      ? live.filter(message => message.turnId === a.turnId && message.role === "user") : [];
    const previous = live.filter(message => message.turnId !== a.turnId);
    const displayed = [...previous, ...nativeInput, ...completed];
    return bounded(displayed, !!history.hasMore ||
      savedEarlierBoundary(displayed, saved, !!transcript?.hasMore) ||
      !previous.length && !!transcript?.hasMore);
  }
  const index = new Map(live.map((message, i) => [message.id, i]));
  let anchor = saved.length - 1;
  while (anchor >= 0 && !index.has(saved[anchor].id)) anchor--;
  if (anchor < 0) {
    return a?.turnId && b?.turnId && a.turnId !== b.turnId &&
      a.startedAt != null && b.startedAt != null && b.startedAt > a.startedAt ? savedView : nativeView;
  }
  const savedById = new Map(saved.map(message => [message.id, message]));
  const merged = live.map(message => {
    const next = savedById.get(message.id);
    if (!next || next.role !== message.role || !next.text.startsWith(message.text)) return message;
    return { ...next, ...message, text: next.text, truncated: next.truncated,
      phase: next.phase ?? message.phase, turnDurationMs: next.turnDurationMs ?? message.turnDurationMs,
      images: next.images ?? message.images, files: next.truncated ? undefined : next.files ?? message.files,
      attachments: next.attachments?.length ? next.attachments : message.attachments,
      unavailableAttachments: next.unavailableAttachments?.length ? next.unavailableAttachments : message.unavailableAttachments,
      unavailableAttachmentPlaceholder: next.unavailableAttachments?.length ? next.unavailableAttachmentPlaceholder
        : next.text === message.text ? message.unavailableAttachmentPlaceholder : undefined };
  });
  if (index.get(saved[anchor].id) === live.length - 1) merged.push(...saved.slice(anchor + 1));
  // Codex-created chats can expose the opening request only in their saved
  // create_thread envelope. Admit that explicitly projected prefix only when
  // its immediate assistant anchor is the same first native item and turn.
  // Never infer the Query from matching text or duplicate a native user item.
  const opening = saved[0], first = live[0], following = saved[1];
  const delegatedPrefix = opening?.origin === "codex_delegation" && opening.role === "user" && !!opening.turnId &&
    following?.role === "assistant" && first?.role === "assistant" && following.id === first.id &&
    opening.turnId === first.turnId && following.turnId === first.turnId && !index.has(opening.id) &&
    !live.some(message => message.role === "user" && message.turnId === opening.turnId) ? [opening] : [];
  const displayed = [...delegatedPrefix, ...merged];
  return bounded(displayed, !!history?.hasMore || savedEarlierBoundary(displayed, saved, !!transcript?.hasMore));
}

// Existing callers that only need display text keep the same merge result.
export function displayMessages(history: History | null, transcript: SavedTranscript | null): Message[] {
  return displayConversation(history, transcript).messages;
}

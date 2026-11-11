import type { Message } from "./conversationFeed";

export type ReadableConversation = { messages: Message[]; hasMore: boolean };
export type ReadableConversationContinuity = ReadableConversation & { retained: boolean };

const limits = { rows: 80, characters: 160000 } as const;
const finalMessage = (message: Message) => message.role === "assistant" && !message.isQuestion &&
  ["final", "final_answer"].includes(message.phase ?? "");

function positions(messages: readonly Message[]) {
  const result = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    const id = messages[index].id;
    // Ambiguous source identities cannot establish a safe boundary. Display
    // deduplication may remove exact copies before this helper is called.
    if (typeof id !== "string" || !id.trim() || result.has(id)) return null;
    result.set(id, index);
  }
  return result;
}

// The caller supplies only the last desktop reading projection from this same
// view/scope, and invokes this for a fallback. Retain an older readable prefix,
// never a stale current tail or any execution, receipt or reading authority.
export function retainReadableConversationPrefix(
  previous: ReadableConversation | null,
  fresh: ReadableConversation,
): ReadableConversationContinuity {
  const unchanged = (): ReadableConversationContinuity => ({ messages: fresh.messages, hasMore: fresh.hasMore, retained: false });
  if (!previous?.messages.length || !fresh.messages.length) return unchanged();
  const before = previous.messages, incoming = fresh.messages;
  const oldPositions = positions(before), newPositions = positions(incoming);
  if (!oldPositions || !newPositions) return unchanged();

  const shared: { before: number; incoming: number }[] = [];
  for (let index = 0; index < incoming.length; index++) {
    const oldIndex = oldPositions.get(incoming[index].id);
    if (oldIndex === undefined) continue;
    const old = before[oldIndex], next = incoming[index];
    if (!old.turnId?.trim() || old.turnId !== next.turnId || old.role !== next.role ||
        oldIndex <= (shared.at(-1)?.before ?? -1)) return unchanged();
    shared.push({ before: oldIndex, incoming: index });
  }
  const first = shared[0], last = shared.at(-1);
  // An older/branched fallback must not displace a native continuation. Require
  // its last native record to remain represented by an exact shared identity.
  if (!first || !last || last.before !== before.length - 1) return unchanged();
  const incomingTurns = new Set(incoming.map(message => message.turnId));
  if (before.slice(first.before).some(message => !message.turnId?.trim() || !incomingTurns.has(message.turnId)))
    return unchanged();

  const oldTurns = new Set(before.map(message => message.turnId));
  // A new turn may follow the shared completed native tail. Unknown turns
  // before that point could be a different branch, so do not splice them.
  if (incoming.some((message, index) => !message.turnId?.trim() ||
      !oldTurns.has(message.turnId) && (index <= last.incoming || !finalMessage(before[last.before]))))
    return unchanged();

  let prefixEnd = first.before;
  if (first.incoming > 0) {
    const leading = incoming.slice(0, first.incoming), turnId = incoming[first.incoming].turnId;
    // Native and recorded user IDs can differ. A fresh opening user replaces
    // the old opening user for that turn; matching text is never evidence.
    if (!leading.some(message => message.role === "user") || leading.some(message => message.turnId !== turnId))
      return unchanged();
    const turnStart = before.findIndex(message => message.turnId === turnId);
    if (turnStart < 0 || turnStart > prefixEnd) return unchanged();
    prefixEnd = turnStart;
  }
  if (!prefixEnd) return unchanged();

  let remainingRows = limits.rows - incoming.length;
  let remainingCharacters = limits.characters - incoming.reduce((sum, message) => sum + message.text.length, 0);
  let prefixStart = prefixEnd;
  // Budget only the retained prefix. Fresh records stay complete and unchanged,
  // even when their own authority projection already reaches the budget.
  while (prefixStart > 0 && remainingRows > 0) {
    const message = before[prefixStart - 1];
    if (message.text.length > remainingCharacters) break;
    remainingRows--; remainingCharacters -= message.text.length; prefixStart--;
  }
  if (prefixStart === prefixEnd) return unchanged();
  return {
    messages: [...before.slice(prefixStart, prefixEnd), ...incoming],
    hasMore: previous.hasMore || fresh.hasMore || prefixStart > 0,
    retained: true,
  };
}

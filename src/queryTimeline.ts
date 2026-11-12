import type { Message, QueuedMessage } from "./conversationFeed";
import { completeSubmittedAttachments, submittedQueryDisplayStatus, type SubmittedQuery, type SubmittedQueryStatus } from "./submittedQueries.ts";

export type TimelineQuery = {
  requestId: string;
  message: Message;
  state?: SubmittedQueryStatus;
  hasControls: boolean;
};

// A request owns one visual row. Changing transport or receipt state never
// changes that row's key, and a display projection cannot confirm a receipt.
export function queryTimeline(messages: readonly Message[], entries: readonly SubmittedQuery[],
  pending: readonly SubmittedQuery[], outbox: readonly QueuedMessage[], deferred: ReadonlySet<string> = new Set()) {
  const submissions = new Map(entries.map(entry => [entry.requestId, entry]));
  const controls = new Set([...pending.map(entry => entry.requestId), ...outbox.map(item => item.id)]);
  const queue = new Map(outbox.map(item => [item.id, item]));
  const state = (requestId: string) => {
    const entry = submissions.get(requestId), item = queue.get(requestId);
    return entry?.status === "accepted" ? "accepted" as const : item ? submittedQueryDisplayStatus(item) : entry ? submittedQueryDisplayStatus(entry) : undefined;
  };
  const byMessage = new Map<string, TimelineQuery>(), placed = new Map<string, string>(), hiddenMessages = new Set<string>();
  const localMessage = (requestId: string, entry?: SubmittedQuery, item?: QueuedMessage): Message => ({
    id: `submitted:${requestId}`, clientMessageId: requestId, role: "user",
    text: item?.text ?? entry?.text ?? "", timestamp: entry?.createdAt ?? item?.createdAt,
    attachments: [...(item?.attachments ?? entry?.attachments ?? [])],
  });
  const waiting = new Map([...controls].map(id => [id, localMessage(id, submissions.get(id), queue.get(id))]));
  const candidates = new Map(messages.filter(message => deferred.has(message.id)).map(message => [message.id,
    [...waiting].filter(([id, local]) => message.text.trim() === local.text.trim()
      && completeSubmittedAttachments(submissions.get(id) ?? queue.get(id) ?? { attachments: local.attachments }, message.attachments)).map(([id]) => id)]));
  for (const message of messages) {
    if (deferred.has(message.id)) {
      const ids = candidates.get(message.id) ?? [], requestId = ids.length === 1 ? ids[0] : undefined;
      // While a separate source record waits for identity, keep the existing
      // local row before the following reply. This reserves layout only: the
      // original record will reappear if the bounded verification fails.
      if (requestId && !placed.has(requestId) && [...candidates.values()].filter(values => values.includes(requestId)).length === 1) {
        byMessage.set(message.id, { requestId, message: waiting.get(requestId)!,
          state: state(requestId), hasControls: true });
        placed.set(requestId, message.id);
      } else hiddenMessages.add(message.id);
      continue;
    }
    if (message.role !== "user" || !message.clientMessageId) continue;
    const requestId = message.clientMessageId, entry = submissions.get(requestId), item = queue.get(requestId);
    const local = controls.has(requestId) ? localMessage(requestId, entry, item) : undefined;
    // Exact identity allows one row even before its full history is available.
    // Keep the complete submitted body until text/attachments have caught up.
    const complete = !message.truncated && (!local || message.text.trim() === local.text.trim()
      && completeSubmittedAttachments(entry ?? item ?? { attachments: local.attachments }, message.attachments));
    const row = { requestId, message: complete || !local ? message : { ...message, ...local, id: message.id, truncated: false },
      state: state(requestId), hasControls: controls.has(requestId) };
    const anchor = placed.get(requestId);
    if (anchor) {
      // A pending steering item and its confirmed item may coexist in a feed.
      // Exact request identity still owns one slot; prefer its complete body.
      if (complete) byMessage.set(anchor, row);
      hiddenMessages.add(message.id);
    } else {
      byMessage.set(message.id, row);
      placed.set(requestId, message.id);
    }
  }
  const tail = [...controls].filter(id => !placed.has(id)).map(requestId => {
    const entry = submissions.get(requestId), item = queue.get(requestId);
    return { requestId, message: localMessage(requestId, entry, item),
      state: state(requestId), hasControls: true };
  }).sort((a, b) => (a.message.timestamp ?? 0) - (b.message.timestamp ?? 0));
  return { byMessage, tail, hiddenMessages };
}

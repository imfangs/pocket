import type { Message, QueuedMessage } from "./conversationFeed";
import { sameAttachments, type PublicAttachment } from "./attachments.ts";

export type SubmittedQueryStatus = "submitting" | "connecting" | "pending" | "queued" | "editing" | "accepted" | "unknown" | "rejected" | "not_found" | "cancelled" | "not_queued";
export type SubmittedQuery = Readonly<{
  threadId: string;
  requestId: string;
  text: string;
  status: SubmittedQueryStatus;
  createdAt: number;
  code?: string;
  queueRevision?: number;
  echoed?: boolean;
  dismissed?: boolean;
  attachments?: readonly PublicAttachment[];
}>;
export type SubmittedQuerySeed = Pick<SubmittedQuery, "threadId" | "requestId" | "text" | "status" | "attachments"> & { createdAt?: number; code?: string };
export type SubmittedQueryReceipt = { requestId: string; status: SubmittedQueryStatus; code?: string };

const empty: readonly SubmittedQuery[] = Object.freeze([]);
const settled = new Set<SubmittedQueryStatus>(["accepted", "cancelled"]);
const submissionKey = (threadId: string, requestId: string) => JSON.stringify([threadId, requestId]);

// Identity confirms which submission this is; exact complete text confirms the
// visible history can replace its full local copy. Text alone confirms neither.
export function completeSubmittedEcho(entry: Pick<SubmittedQuery, "requestId" | "text" | "status" | "attachments">, messages: readonly Message[]) {
  return entry.status === "accepted" && messages.some(message => message.role === "user" && message.clientMessageId === entry.requestId
    && !message.truncated && message.text.trim() === entry.text.trim() && sameAttachments(entry.attachments, message.attachments));
}

// Exact client message identity can carry known attachment display metadata
// while the transcript catches up. This never changes a submission receipt.
export function withSubmittedAttachments(messages: readonly Message[], entries: readonly SubmittedQuery[]): Message[] {
  return messages.map(message => {
    if (message.role !== "user" || !message.clientMessageId || message.attachments?.length) return message;
    const entry = entries.find(item => item.requestId === message.clientMessageId);
    return entry?.attachments?.length ? { ...message, attachments: [...entry.attachments] } : message;
  });
}

// Session memory only. A submission's text is captured separately from the next
// draft. Only a newer, saved outbox revision may replace its immutable snapshot.
export function createSubmittedQueryStore() {
  const threads = new Map<string, readonly SubmittedQuery[]>();
  const listeners = new Set<() => void>();
  const activePosts = new Map<string, Set<symbol>>();
  const getThread = (threadId: string) => threads.get(threadId) ?? empty;
  const change = (threadId: string, update: (entries: readonly SubmittedQuery[]) => readonly SubmittedQuery[]) => {
    const previous = getThread(threadId), next = update(previous);
    if (next === previous) return;
    threads.set(threadId, Object.freeze(next));
    listeners.forEach(listener => listener());
  };
  const receipt = (threadId: string, result: SubmittedQueryReceipt) => change(threadId, entries => {
    const index = entries.findIndex(entry => entry.requestId === result.requestId);
    if (index < 0) return entries;
    const entry = entries[index];
    if (result.status === "not_found" && activePosts.has(submissionKey(threadId, result.requestId))) result = { requestId: result.requestId, status: "unknown" };
    // An early native echo/acceptance wins over late HTTP or queue snapshots.
    if (settled.has(entry.status) && result.status !== entry.status) return entries;
    if (entry.status === result.status && entry.code === result.code) return entries;
    return entries.map((value, i) => i === index ? Object.freeze({ ...entry, status: result.status, code: result.code }) : value);
  });
  return {
    getThread,
    beginPost(threadId: string, requestId: string) {
      const key = submissionKey(threadId, requestId), token = Symbol();
      const posts = activePosts.get(key) ?? new Set<symbol>();
      posts.add(token); activePosts.set(key, posts);
      return () => { posts.delete(token); if (!posts.size && activePosts.get(key) === posts) activePosts.delete(key); };
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    seed(input: SubmittedQuerySeed) {
      const existing = getThread(input.threadId).find(entry => entry.requestId === input.requestId);
      change(input.threadId, entries => entries.some(entry => entry.requestId === input.requestId) ? entries
        : [...entries, Object.freeze({ ...input, ...(input.attachments ? { attachments: Object.freeze([...input.attachments]) } : {}), createdAt: input.createdAt ?? Date.now() })]);
      if (existing?.queueRevision === undefined || settled.has(input.status)) receipt(input.threadId, input);
    },
    receipt,
    observeQueue(threadId: string, items: readonly QueuedMessage[]) {
      change(threadId, entries => {
        let next = entries;
        for (const item of items) {
          const index = next.findIndex(entry => entry.requestId === item.id), entry = next[index];
          if (!entry) {
            next = [...next, Object.freeze({ threadId, requestId: item.id, text: item.text, status: item.status, createdAt: item.createdAt, queueRevision: item.revision, attachments: item.attachments })];
            continue;
          }
          if (entry.echoed || entry.status === "cancelled" || (entry.queueRevision ?? -1) > item.revision) continue;
          if (entry.status === "accepted") {
            // A saved edit can be acknowledged after auto-dispatch already
            // accepted it. Keep acceptance while adopting that newer revision.
            if ((entry.queueRevision ?? -1) < item.revision)
              next = next.map((value, i) => i === index ? Object.freeze({ ...entry, text: item.text, queueRevision: item.revision, attachments: item.attachments?.length ? item.attachments : entry.attachments }) : value);
            continue;
          }
          if (entry.queueRevision === item.revision && (
            (["pending", "unknown", "rejected", "editing"].includes(entry.status) && item.status === "queued") ||
            (["unknown", "rejected", "editing"].includes(entry.status) && item.status === "pending"))) continue;
          const text = (entry.queueRevision ?? -1) < item.revision ? item.text : entry.text;
          const attachments = item.attachments?.length ? item.attachments : entry.attachments;
          if (entry.text === text && entry.status === item.status && entry.queueRevision === item.revision && entry.code === item.code && sameAttachments(entry.attachments, attachments)) continue;
          next = next.map((value, i) => i === index ? Object.freeze({ ...entry, text, status: item.status, queueRevision: item.revision, code: item.code, attachments }) : value);
        }
        // Absence is never delivery evidence. Retain a row until an exact echo
        // appears or the user explicitly dismisses a definite failed/cancelled row.
        return next;
      });
      // Same-revision transitions can be a stale snapshot or a legitimate
      // preflight rollback. Ask the receipt endpoint instead of freezing the UI
      // in pending or trusting an ambiguous queued snapshot as current.
      return items.flatMap(item => {
        const entry = getThread(threadId).find(value => value.requestId === item.id);
        return entry && !entry.echoed && !entry.dismissed && entry.queueRevision === item.revision && entry.status !== item.status
          && !settled.has(entry.status) ? [item.id] : [];
      });
    },
    observeMessages(threadId: string, messages: readonly Message[]) {
      change(threadId, entries => {
        if (!entries.some(entry => !entry.echoed && completeSubmittedEcho(entry, messages))) return entries;
        return entries.map(entry => !entry.echoed && completeSubmittedEcho(entry, messages) ? Object.freeze({ ...entry, echoed: true }) : entry);
      });
    },
    dismiss(threadId: string, requestId: string) {
      if (activePosts.has(submissionKey(threadId, requestId))) return;
      change(threadId, entries => entries.map(entry => entry.requestId === requestId && ["rejected", "not_found", "cancelled"].includes(entry.status)
        ? Object.freeze({ ...entry, dismissed: true }) : entry));
    },
    reloadBlocker() {
      return activePosts.size || [...threads.values()].some(entries => entries.some(entry => !entry.echoed && !entry.dismissed && entry.status !== "cancelled"
        && (entry.queueRevision === undefined || ["accepted", "pending", "unknown"].includes(entry.status))))
        ? "还有已提交内容尚未同步或待核对，请处理后再更新。" : null;
    },
    clear() { threads.clear(); activePosts.clear(); listeners.forEach(listener => listener()); },
  };
}
export type SubmittedQueryStore = ReturnType<typeof createSubmittedQueryStore>;
export function seedSubmittedQuery(store: SubmittedQueryStore, input: SubmittedQuerySeed) { store.seed(input); }
export async function withSubmittedQueryPost<T>(store: SubmittedQueryStore | undefined, threadId: string, requestId: string, post: () => Promise<T>) {
  const finish = store?.beginPost(threadId, requestId);
  try { return await post(); } finally { finish?.(); }
}

export function visibleSubmittedQueries(entries: readonly SubmittedQuery[], messages: readonly Message[], outbox: readonly QueuedMessage[]) {
  const queued = new Set(outbox.map(item => item.id));
  return entries.filter(entry => !entry.echoed && !entry.dismissed && !completeSubmittedEcho(entry, messages) && !queued.has(entry.requestId));
}

export function submittedOutbox(entries: readonly SubmittedQuery[], messages: readonly Message[], outbox: readonly QueuedMessage[]) {
  return outbox.flatMap(item => {
    const entry = entries.find(value => value.requestId === item.id);
    if (entry?.echoed || entry?.status === "cancelled" || completeSubmittedEcho(entry ?? { requestId: item.id, text: item.text, status: item.status, attachments: item.attachments }, messages)) return [];
    if (!entry) return [item];
    if (entry.status === "accepted") return [{ ...item, text: entry.text, status: "accepted" as const, attachments: entry.attachments ? [...entry.attachments] : item.attachments }];
    if (entry.queueRevision !== undefined && entry.queueRevision >= item.revision && ["queued", "editing", "pending", "unknown", "rejected"].includes(entry.status))
      return [{ ...item, text: entry.text, revision: entry.queueRevision, status: entry.status as QueuedMessage["status"], attachments: entry.attachments ? [...entry.attachments] : item.attachments }];
    return [item];
  });
}

export function submittedQueryLabel(entry: SubmittedQuery, connecting = false) {
  if (entry.status === "accepted") return "已发送";
  if (entry.status === "unknown") return "结果待核对";
  if (entry.status === "rejected") return "未能发送";
  if (entry.status === "not_found") return "未找到提交记录";
  if (entry.status === "cancelled") return "已取消发送";
  if (entry.status === "editing") return "编辑中，已暂停发送";
  if (entry.status === "not_queued") return "正在准备首条消息";
  if (entry.status === "connecting" || (entry.status === "queued" && connecting)) return "正在连接 Mac";
  if (entry.status === "queued") return "待发送";
  return "正在提交";
}

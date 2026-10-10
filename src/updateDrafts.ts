import type { QueryDraft } from "./Conversation";
import type { HistoryCache } from "./conversationFeed";
import { hasAnswerText } from "./questionDrafts.ts";
import { hasDraftAttachments } from "./attachments.ts";

export function hasUpdateBlockingDraft(
  drafts: ReadonlyMap<string, QueryDraft>,
  historyCache: HistoryCache,
): boolean {
  for (const [key, draft] of drafts) {
    // An unconfirmed submission or an edited queue entry still needs its local
    // state, even when the text is empty or its original question has ended.
    if (draft.requestId || draft.revision !== undefined || hasDraftAttachments(draft)) return true;
    if (!hasAnswerText(draft)) continue;
    const question = /^([^/]+)\/question\/(.+)$/.exec(key);
    if (question) {
      const history = historyCache.get(question[1])?.history;
      // Only an explicit desktop question list can establish that this answer
      // no longer has a live question. Missing, evicted or fallback data cannot.
      if (history?.source === "desktop" && Array.isArray(history.asyncQuestions) &&
          !history.asyncQuestions.some(item => item.key === question[2])) continue;
    }
    const request = /^([^/]+)\/request\/([^/]+)\/question\//.exec(key);
    if (request) {
      const history = historyCache.get(request[1])?.history;
      if (history?.source === "desktop" && Array.isArray(history.pendingRequests)) {
        const current = history.pendingRequests.find(item => item.key === request[2]);
        if (!current || ["accepted", "resolved"].includes(current.response?.status ?? "")) continue;
      }
    }
    return true;
  }
  return false;
}

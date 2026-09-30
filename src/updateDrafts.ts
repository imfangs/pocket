import type { QueryDraft } from "./Conversation";
import type { HistoryCache } from "./conversationFeed";

export function hasUpdateBlockingDraft(
  drafts: ReadonlyMap<string, QueryDraft>,
  historyCache: HistoryCache,
): boolean {
  for (const [key, draft] of drafts) {
    // An unconfirmed submission or an edited queue entry still needs its local
    // state, even when the text is empty or its original question has ended.
    if (draft.requestId || draft.revision !== undefined) return true;
    if (!draft.text) continue;
    const question = /^([^/]+)\/question\/(.+)$/.exec(key);
    if (question) {
      const history = historyCache.get(question[1])?.history;
      // Only an explicit desktop question list can establish that this answer
      // no longer has a live question. Missing, evicted or fallback data cannot.
      if (history?.source === "desktop" && Array.isArray(history.asyncQuestions) &&
          !history.asyncQuestions.some(item => item.key === question[2])) continue;
    }
    return true;
  }
  return false;
}

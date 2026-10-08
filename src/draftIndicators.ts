import type { QueryDraft } from "./Conversation";

function rootThreadId(key: string) {
  return key.split("/", 1)[0];
}

function unsubmitted(draft: QueryDraft) {
  return !draft.requestId && [draft.text, draft.customText, draft.optionText].some(text => !!text?.trim());
}

export function draftThreadIds(drafts: ReadonlyMap<string, QueryDraft>): Set<string> {
  const result = new Set<string>();
  for (const [key, draft] of drafts) {
    const threadId = rootThreadId(key);
    if (threadId && unsubmitted(draft)) result.add(threadId);
  }
  return result;
}

// Keep Map identity and values intact for draftTransaction. Per-thread counts
// notify the list only when its draft badge changes, never for each keystroke.
export function createDraftMap(onIndicatorChange: () => void): Map<string, QueryDraft> {
  const counted = new Set<string>(), counts = new Map<string, number>();
  const change = (key: string, qualifies: boolean) => {
    const threadId = rootThreadId(key);
    const wasCounted = counted.has(key);
    if (!threadId || wasCounted === qualifies) return false;
    const before = counts.get(threadId) ?? 0;
    const after = before + (qualifies ? 1 : -1);
    if (qualifies) counted.add(key); else counted.delete(key);
    if (after) counts.set(threadId, after); else counts.delete(threadId);
    return (before > 0) !== (after > 0);
  };
  return new class extends Map<string, QueryDraft> {
    override set(key: string, value: QueryDraft) {
      super.set(key, value);
      if (change(key, !!rootThreadId(key) && unsubmitted(value))) onIndicatorChange();
      return this;
    }
    override delete(key: string) {
      const deleted = super.delete(key);
      if (deleted && change(key, false)) onIndicatorChange();
      return deleted;
    }
    override clear() {
      const changed = counts.size > 0;
      super.clear(); counted.clear(); counts.clear();
      if (changed) onIndicatorChange();
    }
  }();
}

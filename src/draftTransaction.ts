import type { QueryDraft } from "./Conversation";

// An async result may only change the exact draft that started its operation.
// Compare identity rather than text: a later edit can contain identical text.
export function captureDraft(drafts: Map<string, QueryDraft>, key: string) {
  let expected = drafts.get(key);
  const current = () => drafts.get(key) === expected;
  return {
    current,
    set(next: QueryDraft) {
      if (!current()) return false;
      drafts.set(key, next);
      expected = next;
      return true;
    },
    clear() {
      if (!current()) return false;
      drafts.delete(key);
      expected = undefined;
      return true;
    },
  };
}

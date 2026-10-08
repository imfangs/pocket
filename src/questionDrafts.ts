import type { QueryDraft } from "./Conversation";
import type { PendingRequest } from "./conversationFeed";

export type AnswerMode = "options" | "custom";

export function answerMode(draft: QueryDraft, options: readonly string[]): AnswerMode {
  if (!options.length) return "custom";
  return draft.answerMode ?? (draft.text && !options.includes(draft.text) ? "custom" : "options");
}

export function switchAnswerMode(draft: QueryDraft, options: readonly string[], mode: AnswerMode): QueryDraft {
  const previous = answerMode(draft, options);
  const remembered = { ...draft, [previous === "custom" ? "customText" : "optionText"]: draft.text };
  return { ...remembered, answerMode: mode, text: (mode === "custom" ? remembered.customText : remembered.optionText) ?? "" };
}

export function editAnswer(draft: QueryDraft, options: readonly string[], text: string, mode = answerMode(draft, options)): QueryDraft {
  return { ...draft, text, answerMode: mode, [mode === "custom" ? "customText" : "optionText"]: text };
}

export function hasAnswerText(draft?: QueryDraft) {
  return !!(draft?.text || draft?.customText || draft?.optionText);
}

export function requestAnswerKey(threadId: string, requestKey: string, questionId: string) {
  return `${threadId}/request/${requestKey}/question/${encodeURIComponent(questionId)}`;
}

export function requestAnswerValues(drafts: ReadonlyMap<string, QueryDraft>, threadId: string, request: PendingRequest) {
  return Object.fromEntries((request.questions ?? []).map(question => [question.id,
    drafts.get(requestAnswerKey(threadId, request.key, question.id))?.text ?? ""]));
}

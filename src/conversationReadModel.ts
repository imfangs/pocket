import type { History, SavedTranscript } from "./conversationFeed";
import { currentQuestions } from "./currentQuestions.ts";
import { uniqueDisplayMessages } from "./displayMessageIdentity.ts";
import { displayedPocketContent } from "./readObservation.ts";
import { retainReadableConversationPrefix, type ReadableConversation } from "./readableConversationContinuity.ts";
import { withSubmittedAttachments, type SubmittedQuery } from "./submittedQueries.ts";
import { displayConversation } from "./transcript.ts";
import { displayedTurnFailures, failureTailTurnId, turnFailures } from "./turnFailures.ts";
import { isPocketContent } from "./pocketReadState.ts";

export type ConversationReadInput = {
  scope: string;
  readingScope?: string;
  history: History | null;
  transcript: SavedTranscript | null;
  submitted: readonly SubmittedQuery[];
  cachedPreview: SavedTranscript | null;
  previewAllowed: boolean;
};
export type DesktopReadingProjection = { scope: string; view: ReadableConversation };

// A newer authenticated reading snapshot can hand off to a newly opened view
// before its live feeds answer. An unversioned old body or equal-revision hash
// conflict provides no ordering proof and must not be replaced optimistically.
export function canAdoptReadingPreview(candidate: SavedTranscript, history: History | null, transcript: SavedTranscript | null, scope?: string) {
  const next = candidate.pocketContent;
  if (!scope || !isPocketContent(next) || next.scope !== scope || !Number.isFinite(candidate.checkedAt) || candidate.checkedAt < 0) return false;
  if ([history, transcript].some(value => value?.messages.length && (!Number.isFinite(value.checkedAt) || value.checkedAt < 0))) return false;
  const oldAt = Math.max(history?.checkedAt ?? 0, transcript?.checkedAt ?? 0);
  if (candidate.checkedAt < oldAt) return false;
  if (!history?.messages.length && !transcript?.messages.length) return true;
  const versions = [history?.pocketContent, transcript?.pocketContent].filter(value => isPocketContent(value) && value.scope === scope);
  if (!versions.length) return false;
  const revision = Math.max(...versions.map(value => value!.revision));
  if (next.revision > revision) return true;
  const sameVersion = next.revision === revision && versions.filter(value => value!.revision === revision)
    .every(value => value!.version === next.version && value!.messageId === next.messageId);
  if (!sameVersion) return false;
  if (candidate.checkedAt > oldAt) return true;
  // A closing view can already remember the new recorded body while its older
  // native projection still wins the display merge. Equal cache metadata may
  // hand that exact known body through; timestamps alone never grant this.
  const oldDisplay = displayConversation(history, transcript).messages;
  return [history, transcript].some(value => value && isPocketContent(value.pocketContent) && value.pocketContent.scope === scope &&
    value.pocketContent.revision === next.revision && value.pocketContent.version === next.version && value.pocketContent.messageId === next.messageId &&
    !!displayedPocketContent(value as SavedTranscript, candidate.messages) && !displayedPocketContent(value as SavedTranscript, oldDisplay));
}

// Own display identity, source continuity and the exact reading target in one
// projection. Raw live display remains separately available to receipt callers;
// cached text and retained prefixes never supply runtime or control fields.
export function conversationReadModel(input: ConversationReadInput, previousDesktop: DesktopReadingProjection | null = null) {
  const { history, transcript, submitted, cachedPreview } = input;
  const liveDisplay = displayConversation(
    history ? { ...history, messages: withSubmittedAttachments(history.messages, submitted) } : null,
    transcript ? { ...transcript, messages: withSubmittedAttachments(transcript.messages, submitted) } : null,
  );
  const freshDisplay = { ...liveDisplay, messages: uniqueDisplayMessages(liveDisplay.messages) };
  const readable = history?.source === "rollout"
    ? retainReadableConversationPrefix(previousDesktop?.scope === input.scope ? previousDesktop.view : null, freshDisplay)
    : freshDisplay;
  const showingDiskPreview = !!cachedPreview && input.previewAllowed && (!liveDisplay.messages.length ||
    canAdoptReadingPreview(cachedPreview, history, transcript, input.readingScope));
  const shownMessages = showingDiskPreview ? uniqueDisplayMessages(cachedPreview.messages) : readable.messages;
  const hasEarlierMessages = showingDiskPreview ? cachedPreview.hasMore : readable.hasMore;
  const seen = new Set<string>(), ambiguousMessageIds = new Set<string>();
  for (const message of shownMessages) {
    if (seen.has(message.id)) ambiguousMessageIds.add(message.id); else seen.add(message.id);
  }
  const timelineMessages = shownMessages.filter(message => !ambiguousMessageIds.has(message.id));
  const questions = currentQuestions(history, transcript);
  const questionsByMessage = new Map<string, typeof questions>();
  for (const question of questions)
    questionsByMessage.set(question.sourceMessageId, [...(questionsByMessage.get(question.sourceMessageId) ?? []), question]);
  const unplacedQuestions = questions.filter(question => ambiguousMessageIds.has(question.sourceMessageId) || !seen.has(question.sourceMessageId));
  // An authenticated cached body may advance only its own local read version.
  // The exact cached source must belong to the active catalog's reading scope.
  const readSource = showingDiskPreview
    ? cachedPreview.pocketContent?.scope === input.readingScope ? cachedPreview : null
    : transcript;
  const pocketContent = unplacedQuestions.length ||
    !!readSource?.pocketContent?.messageId && ambiguousMessageIds.has(readSource.pocketContent.messageId)
    ? null : displayedPocketContent(readSource, shownMessages);
  const failures = showingDiskPreview ? turnFailures(cachedPreview.turnFailures) : displayedTurnFailures(history, transcript);
  return {
    liveDisplay, freshDisplay, showingDiskPreview, shownMessages, hasEarlierMessages,
    ambiguousMessageIds, timelineMessages, questions, questionsByMessage, unplacedQuestions, pocketContent, turnFailures: failures,
    failureTailTurnId: showingDiskPreview ? null : failureTailTurnId(history, transcript, shownMessages),
  };
}
export type ConversationReadModel = ReturnType<typeof conversationReadModel>;

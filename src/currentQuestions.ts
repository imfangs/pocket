import type { History, SavedTranscript } from "./conversationFeed";

export function currentQuestions(history: History | null, transcript: SavedTranscript | null) {
  if (history?.source !== "desktop") return [];
  const live = history.turnTiming, saved = transcript?.turnTiming;
  // Saved text may invalidate an old display, but never grants answer permission.
  if (live?.turnId && saved?.turnId && live.turnId !== saved.turnId &&
      live.startedAt != null && saved.startedAt != null && saved.startedAt > live.startedAt) return [];
  return (history.asyncQuestions || []).filter(question => !!live?.turnId && question.turnId === live.turnId);
}

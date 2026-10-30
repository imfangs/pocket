import type { Thread } from "./types";
import { smartThreadOrder, smartThreadScore, type SmartOrderOptions } from "./smartOrder.ts";
import { hasUnreadContent } from "./unread.ts";

export const unreadPrefetchBoost = 200;
export const transcriptPrefetchLimit = 8;
export const validPrefetchId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);
export type ReadPriorityOptions = SmartOrderOptions & { selectedId?: string | null; excludedThreadIds?: readonly string[] };
export type PrefetchContent = { known: true; scope: string; revision: number; version: string; messageId: string | null };
export type TranscriptPrefetchCandidate = { id: string; content: PrefetchContent };

// Scheduling reuses the list's single score; unread adds urgency without
// replacing the existing recency, real visits, drafts and priority factors.
export function readPriorityScore(thread: Thread, options: SmartOrderOptions) {
  return smartThreadScore(thread, options) + (hasUnreadContent(thread, options.runtimeStates?.get(thread.id)) ? unreadPrefetchBoost : 0);
}

export function prioritizedReadThreads(threads: readonly Thread[], options: ReadPriorityOptions, limit = 32) {
  const excluded = new Set(options.excludedThreadIds);
  const eligible = threads.filter(thread => validPrefetchId(thread.id) && !excluded.has(thread.id) &&
    !thread.archived && !thread.missing && !thread.separator && !thread.sourceExcluded);
  return smartThreadOrder(eligible, options).sort((a, b) => Number(b.id === options.selectedId) - Number(a.id === options.selectedId)
    || readPriorityScore(b, options) - readPriorityScore(a, options)).slice(0, Math.max(0, limit));
}

export function prefetchContent(value: unknown, scope: string): PrefetchContent | null {
  if (!scope || scope.length > 512 || !value || typeof value !== "object") return null;
  const content = value as Partial<PrefetchContent>;
  if (content.known !== true || content.scope !== scope || !Number.isSafeInteger(content.revision) || (content.revision ?? 0) <= 0 ||
      typeof content.version !== "string" || !/^[a-f0-9]{64}$/.test(content.version) ||
      content.messageId !== null && (typeof content.messageId !== "string" || !content.messageId || content.messageId.length > 512)) return null;
  return { known: true, scope, revision: content.revision!, version: content.version, messageId: content.messageId! };
}

export function samePrefetchContent(value: unknown, expected: PrefetchContent) {
  const content = prefetchContent(value, expected.scope);
  return !!content && content.revision === expected.revision && content.version === expected.version && content.messageId === expected.messageId;
}

export function coversPrefetchContent(value: unknown, expected: PrefetchContent) {
  const content = prefetchContent(value, expected.scope);
  return !!content && (content.revision > expected.revision || samePrefetchContent(content, expected));
}

export function transcriptPrefetchCandidates(threads: readonly Thread[], scope: string, options: ReadPriorityOptions): TranscriptPrefetchCandidate[] {
  const known = threads.filter(thread => thread.id !== options.selectedId && prefetchContent(thread.pocketContent, scope));
  // Select the small working set before checking cache hits. Filling vacancies
  // after each hit would quietly walk the entire catalog and churn the cache.
  return prioritizedReadThreads(known, options, transcriptPrefetchLimit).map(thread => ({ id: thread.id, content: prefetchContent(thread.pocketContent, scope)! }));
}

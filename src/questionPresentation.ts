import type { QueryDraft } from "./Conversation";
import { hasAnswerText } from "./questionDrafts.ts";
import { machineStorageKey } from "./machineScope.ts";

const storageKey = "pocket.ignored-questions.v1";
export const MAX_IGNORED_QUESTIONS = 200;
type PresentationStorage = Pick<Storage, "getItem" | "setItem">;
export const questionPresentationKey = (threadId: string, fingerprint: string) => JSON.stringify([threadId, fingerprint]);

function validKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length > 512) return false;
  try {
    const pair = JSON.parse(key);
    return Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === "string" && value.length > 0 && value.length <= 128);
  } catch { return false; }
}

// Only thread identity and the backend question fingerprint are persisted.
// Neither question text nor any answer is passed to this store.
export function createQuestionPresentationStore(storage?: PresentationStorage) {
  const scopedKey = machineStorageKey(storageKey);
  const ignored = new Set<string>(), listeners = new Set<() => void>();
  const activeAnswers = new Map<string, Map<string, Set<symbol>>>();
  const notify = () => listeners.forEach(listener => listener());
  let local = storage;
  try { if (!local && typeof window !== "undefined") local = window.localStorage; } catch { /* Keep a session-only store. */ }
  try {
    const saved = JSON.parse(local?.getItem(scopedKey) || "null");
    if (saved?.version === 1 && Array.isArray(saved.ignored)) {
      const keys = [...new Set(saved.ignored.filter(validKey))] as string[];
      keys.slice(-MAX_IGNORED_QUESTIONS).forEach(key => ignored.add(key));
    }
  } catch { /* Corrupt or unavailable storage must not block answering. */ }
  return {
    answerRequestId: (threadId: string, fingerprint: string) => activeAnswers.get(questionPresentationKey(threadId, fingerprint))?.keys().next().value,
    answerPostPending: (threadId: string, fingerprint: string, requestId: string) => !!activeAnswers.get(questionPresentationKey(threadId, fingerprint))?.has(requestId),
    beginAnswerPost(threadId: string, fingerprint: string, requestId: string) {
      const key = questionPresentationKey(threadId, fingerprint), token = Symbol();
      const requests = activeAnswers.get(key) ?? new Map<string, Set<symbol>>();
      const posts = requests.get(requestId) ?? new Set<symbol>();
      posts.add(token); requests.set(requestId, posts); activeAnswers.set(key, requests); notify();
      return () => {
        if (!posts.delete(token)) return;
        if (!posts.size) requests.delete(requestId);
        if (!requests.size) activeAnswers.delete(key);
        notify();
      };
    },
    isIgnored: (threadId: string, fingerprint: string) => ignored.has(questionPresentationKey(threadId, fingerprint)),
    setIgnored(threadId: string, fingerprint: string, value: boolean) {
      const key = questionPresentationKey(threadId, fingerprint);
      if (!validKey(key) || ignored.has(key) === value) return;
      if (value) ignored.add(key); else ignored.delete(key);
      while (ignored.size > MAX_IGNORED_QUESTIONS) ignored.delete(ignored.values().next().value!);
      try { local?.setItem(scopedKey, JSON.stringify({ version: 1, ignored: [...ignored] })); }
      catch { /* Keep the new state in memory when persistence is unavailable. */ }
      notify();
    },
    notifyDraftChange: notify,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
export type QuestionPresentationStore = ReturnType<typeof createQuestionPresentationStore>;
let defaultStore: QuestionPresentationStore | undefined;
export function questionPresentationStore() { return defaultStore ??= createQuestionPresentationStore(); }

export function questionPresentation(options: { ignored: boolean; draft?: QueryDraft; responseStatus?: string; busy?: boolean; answerOpen?: boolean; postPending?: boolean }) {
  const waiting = !!options.postPending || !!options.draft?.requestId || ["pending", "unknown", "accepted"].includes(options.responseStatus || "");
  const hasDraft = hasAnswerText(options.draft);
  const ignored = options.ignored && !waiting && !options.busy;
  const expanded = !!options.busy || waiting || (!ignored && (!!options.answerOpen || hasDraft));
  return { waiting, hasDraft, ignored, expanded, canIgnore: !options.busy && !waiting,
    state: options.busy || waiting ? "pending" : ignored ? "ignored" : expanded ? "answering" : "compact" };
}

export function ignoreQuestion(store: QuestionPresentationStore, threadId: string, fingerprint: string,
  options: { draft?: QueryDraft; responseStatus?: string; busy?: boolean }) {
  if (!questionPresentation({ ...options, ignored: false, postPending: !!store.answerRequestId(threadId, fingerprint) }).canIgnore) return false;
  store.setIgnored(threadId, fingerprint, true);
  return store.isIgnored(threadId, fingerprint);
}

// Discard only a local, unsubmitted answer. An in-flight or unknown answer must
// retain its identity even if this view was remounted with a fresh busy flag.
export function discardQuestionDraft(store: QuestionPresentationStore, threadId: string, fingerprint: string,
  drafts: Map<string, QueryDraft>, options: { responseStatus?: string; busy?: boolean } = {}) {
  const key = `${threadId}/question/${fingerprint}`;
  const presentation = questionPresentation({ ...options, ignored: store.isIgnored(threadId, fingerprint),
    draft: drafts.get(key), postPending: !!store.answerRequestId(threadId, fingerprint) });
  if (!presentation.canIgnore || !presentation.hasDraft) return false;
  drafts.delete(key);
  store.notifyDraftChange();
  return true;
}

export function questionComposerPending(store: QuestionPresentationStore, threadId: string,
  questions: readonly { key: string; response?: { status: string } | null }[], drafts: ReadonlyMap<string, QueryDraft>) {
  return questions.some(question => {
    const presentation = questionPresentation({ ignored: store.isIgnored(threadId, question.key),
      draft: drafts.get(`${threadId}/question/${question.key}`), responseStatus: question.response?.status,
      postPending: !!store.answerRequestId(threadId, question.key) });
    return !presentation.ignored || presentation.hasDraft || presentation.waiting;
  });
}

export async function withQuestionAnswerPost<T>(store: QuestionPresentationStore, threadId: string, fingerprint: string, requestId: string, post: () => Promise<T>) {
  const finish = store.beginAnswerPost(threadId, fingerprint, requestId);
  try { return await post(); } finally { finish(); }
}

export async function checkQuestionAnswer(store: QuestionPresentationStore, threadId: string, fingerprint: string, requestId: string,
  read: () => Promise<{ status: string; requestId?: string }>) {
  const startedDuringPost = store.answerPostPending(threadId, fingerprint, requestId);
  const result = await read();
  if (result.requestId && result.requestId !== requestId) throw new Error("回执与这条回答不匹配，请重新核对。");
  return result.status === "not_found" && (startedDuringPost || store.answerPostPending(threadId, fingerprint, requestId))
    ? { ...result, status: "unknown" } : result;
}

export function questionSourceText(sourceText: string | undefined, titles: readonly string[], hasImages = false,
  options?: readonly (readonly string[])[]) {
  if (!sourceText?.trim()) return "";
  const source = sourceText.trim();
  // The native async message may contain both titles and plain bullet options.
  // Only omit an exact generated projection; keep extra context and images.
  const projected = options && titles.map((title, i) =>
    [title, ...(options[i] ?? []).map(option => `- ${option}`)].join("\n")).join("\n\n").trim();
  return !hasImages && (source === titles.join("\n").trim() || source === projected) ? "" : sourceText;
}

import type { ThreadConnection } from "./threadConnection";
import type { ReadObservation } from "./readObservation";
import type { PocketContent } from "./pocketReadState";
import type { PublicAttachment } from "./attachments";
import type { AttachmentUploadDescriptor, AttachmentUploadProgress } from "./submittedQueries";

export type MessageFileReference = { url: string; name: string };
export type MessageFiles = Record<string, MessageFileReference>;

export type Message = {
  id: string;
  turnId?: string | null;
  role: "user" | "assistant";
  text: string;
  phase?: string;
  isQuestion?: boolean;
  timestamp?: number;
  truncated?: boolean;
  clientMessageId?: string;
  origin?: "codex_delegation";
  turnDurationMs?: number;
  images?: Record<string, string>;
  files?: MessageFiles;
  attachments?: PublicAttachment[];
  attachmentEnvelope?: boolean;
};
export type TurnTiming = {
  turnId: string | null;
  status: string;
  startedAt: number | null;
  durationMs: number | null;
  observedAt: number;
};
export type TurnFailure = { turnId: string; message?: string; code?: string; additionalDetails?: string | null; timestamp?: number };
export type History = {
  source: string;
  resumeState?: string;
  readOnlyReason?: string;
  messages: Message[];
  runtime: string;
  canSend: boolean;
  canQueue?: boolean;
  canAttemptSend?: boolean;
  hint: string;
  hasMore?: boolean;
  checkedAt: number;
  outbox?: QueuedMessage[];
  asyncQuestions?: AsyncQuestion[];
  canStop?: boolean;
  activeTurnId?: string | null;
  latestTurnStatus?: string;
  latestTurnId?: string | null;
  turnFailures?: TurnFailure[];
  recentTurns?: { id: string; status: string }[];
  pocketContent?: PocketContent | null;
  turnTiming?: TurnTiming | null;
  stopRequest?: StopReceipt | null;
  queuePaused?: { stopId: string } | null;
  pendingRequests?: PendingRequest[];
  contextUsage?: { usedTokens: number; contextWindow: number; remainingTokens: number; percent: number } | null;
  canCompact?: boolean;
  canAttemptCompact?: boolean;
  compaction?: { active: boolean; latestId: string | null; completed?: boolean };
  compactionRequest?: { requestId: string; status: string; code?: string } | null;
  connection?: ThreadConnection;
};
export type QueuedMessage = {
  id: string;
  text: string;
  revision: number;
  status: "queued" | "editing" | "pending" | "accepted" | "rejected" | "unknown";
  code?: string;
  createdAt: number;
  attachments?: PublicAttachment[];
  autoDirect?: boolean;
  uploadProgress?: AttachmentUploadProgress;
  attachmentUploads?: readonly AttachmentUploadDescriptor[];
};
export type ProgressViewState = { expanded: string[]; deferred: string[]; seen: string[] };
export type HistoryCache = Map<string, {
  history?: History;
  transcript?: SavedTranscript;
  progressView?: ProgressViewState;
  expandedQueries?: string[];
  scrollTop: number;
  nearBottom: boolean;
  payloadBytes?: number;
}>;
export type SavedTranscript = {
  source: "rollout";
  messages: Message[];
  hasMore?: boolean;
  turnTiming?: TurnTiming | null;
  turnFailures?: TurnFailure[];
  checkedAt: number;
  readObservation?: ReadObservation | null;
  pocketContent?: PocketContent | null;
};

export const historyCacheLimits = { entries: 20, bytes: 8 * 1024 * 1024 } as const;
function trimHistoryCache(cache: HistoryCache, id: string) {
  const entry = cache.get(id)!;
  entry.payloadBytes = (JSON.stringify(entry.history ?? null).length + JSON.stringify(entry.transcript ?? null).length) * 2;
  let bytes = [...cache.values()].reduce((total, value) => total + (value.payloadBytes ?? 0), 0);
  while (cache.size > historyCacheLimits.entries || bytes > historyCacheLimits.bytes) {
    const oldest = cache.keys().next().value!;
    bytes -= cache.get(oldest)?.payloadBytes ?? 0; cache.delete(oldest);
  }
}
export function rememberHistory(cache: HistoryCache, id: string, history: History) {
  const previous = cache.get(id);
  cache.delete(id);
  cache.set(id, { history, transcript: previous?.transcript, progressView: previous?.progressView,
    expandedQueries: previous?.expandedQueries,
    scrollTop: previous?.scrollTop ?? 0, nearBottom: previous?.nearBottom ?? true });
  trimHistoryCache(cache, id);
}
export function rememberTranscript(cache: HistoryCache, id: string, transcript: SavedTranscript) {
  const previous = cache.get(id);
  cache.delete(id);
  cache.set(id, { ...previous, transcript, progressView: previous?.progressView,
    scrollTop: previous?.scrollTop ?? 0, nearBottom: previous?.nearBottom ?? true });
  trimHistoryCache(cache, id);
}

type FeedOptions<T> = {
  request: (signal: AbortSignal) => Promise<T>;
  onData: (history: T) => void;
  onError: (error: Error) => void;
  browser?: Window;
  visibility?: Document;
};

// One read at a time; resume immediately, then poll according to actual activity.
export function startConversationFeed(options: FeedOptions<History>) {
  let desktopMisses = 0;
  return startFeed(options, data => {
    desktopMisses = data.source === "desktop" ? 0 : desktopMisses + 1;
    return data.runtime === "active" || (desktopMisses > 0 && desktopMisses <= 3) ? 2000 : 8000;
  });
}
export function startTranscriptFeed(options: FeedOptions<SavedTranscript>) {
  return startFeed(options, data => data.turnTiming?.status === "inProgress" ? 2000 : 8000);
}
// This feed only observes an already requested connection. Its request callback
// must be the small status GET; it never opens a Mac task or resends a message.
export function startConnectionFeed(options: FeedOptions<ThreadConnection>) {
  return startFeed(options, data => data.status === "connecting" ? 1000 : null);
}
function startFeed<T>(options: FeedOptions<T>, nextDelay: (data: T) => number | null) {
  const browser = options.browser ?? window;
  const visibility = options.visibility ?? document;
  let stopped = false, failures = 0, queued = false;
  let delay: number | null = 8000;
  let timer: number | undefined;
  let pending: Promise<void> | null = null;
  let controller: AbortController | null = null;
  const ready = () => !stopped && visibility.visibilityState === "visible" && browser.navigator.onLine !== false;
  const clearTimer = () => { browser.clearTimeout(timer); timer = undefined; };
  const refresh = (): Promise<void> => {
    if (!ready()) return Promise.resolve();
    if (pending) { queued = true; return pending; }
    clearTimer();
    const current = new AbortController();
    controller = current;
    const deadline = browser.setTimeout(() => current.abort(new DOMException("读取超时", "TimeoutError")), 18000);
    pending = (async () => {
      try {
        const data = await options.request(current.signal);
        if (!ready() || current.signal.aborted) return;
        failures = 0;
        delay = nextDelay(data);
        options.onData(data);
      } catch (error) {
        if (!ready() || (current.signal.aborted && current.signal.reason?.name !== "TimeoutError")) return;
        failures++;
        delay = Math.min(30000, 2000 * 2 ** (failures - 1));
        options.onError(current.signal.reason?.name === "TimeoutError"
          ? new Error("连接 Mac 较慢，正在自动重试。")
          : error instanceof Error ? error : new Error("连接暂时中断，正在自动重试。"));
      } finally {
        browser.clearTimeout(deadline);
        controller = null;
        pending = null;
        if (ready() && (queued || delay !== null)) timer = browser.setTimeout(() => { void refresh(); }, queued ? 0 : delay!);
        queued = false;
      }
    })();
    return pending;
  };
  const resume = () => {
    if (!ready()) {
      clearTimer();
      controller?.abort();
      if (!stopped && browser.navigator.onLine === false)
        options.onError(new Error("当前离线，联网后会自动恢复。"));
      return;
    }
    failures = 0;
    void refresh();
  };
  visibility.addEventListener("visibilitychange", resume);
  browser.addEventListener("online", resume);
  browser.addEventListener("offline", resume);
  browser.addEventListener("pageshow", resume);
  resume();
  return {
    refresh,
    stop() {
      stopped = true;
      clearTimer();
      controller?.abort();
      visibility.removeEventListener("visibilitychange", resume);
      browser.removeEventListener("online", resume);
      browser.removeEventListener("offline", resume);
      browser.removeEventListener("pageshow", resume);
    },
  };
}

export type PendingRequest = {
  key: string;
  kind: "command" | "file" | "permissions" | "questions" | "unsupported";
  command?: string;
  details?: string;
  questions?: { id: string; question: string; isSecret?: boolean; options?: { label: string; description: string }[] | null }[];
  reason: string;
  cwd: string;
  choices: ("accept" | "cancel")[];
  response?: { responseId: string; status: string } | null;
};

export type { StopReceipt } from "../shared/submission-contracts";

export type AsyncQuestion = {
  id: string; key: string; turnId?: string | null; sourceMessageId: string; title: string; options: string[];
  response?: { requestId: string; status: string } | null;
};
import type { StopReceipt } from "../shared/submission-contracts";

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  phase?: string;
  isQuestion?: boolean;
  timestamp?: number;
  truncated?: boolean;
  clientMessageId?: string;
  turnDurationMs?: number;
};
export type TurnTiming = {
  turnId: string | null;
  status: string;
  startedAt: number | null;
  durationMs: number | null;
  observedAt: number;
};
export type History = {
  source: string;
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
  turnTiming?: TurnTiming | null;
  stopRequest?: StopReceipt | null;
  queuePaused?: { stopId: string } | null;
  pendingRequests?: PendingRequest[];
  contextUsage?: { usedTokens: number; contextWindow: number; remainingTokens: number; percent: number } | null;
  canCompact?: boolean;
  compaction?: { active: boolean; latestId: string | null; completed?: boolean };
  compactionRequest?: { requestId: string; status: string; code?: string } | null;
};
export type QueuedMessage = {
  id: string;
  text: string;
  revision: number;
  status: "queued" | "editing" | "pending" | "accepted" | "rejected" | "unknown";
  code?: string;
  createdAt: number;
};
export type HistoryCache = Map<string, {
  history: History;
  scrollTop: number;
  nearBottom: boolean;
}>;

export function rememberHistory(cache: HistoryCache, id: string, history: History) {
  const previous = cache.get(id);
  cache.delete(id);
  cache.set(id, { history, scrollTop: previous?.scrollTop ?? 0, nearBottom: previous?.nearBottom ?? true });
  if (cache.size > 10) cache.delete(cache.keys().next().value!);
}

type FeedOptions = {
  request: (signal: AbortSignal) => Promise<History>;
  onData: (history: History) => void;
  onError: (error: Error) => void;
  browser?: Window;
  visibility?: Document;
};

// One read at a time; resume immediately, then poll according to actual activity.
export function startConversationFeed(options: FeedOptions) {
  const browser = options.browser ?? window;
  const visibility = options.visibility ?? document;
  let stopped = false, failures = 0, desktopMisses = 0, delay = 8000, queued = false;
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
        desktopMisses = data.source === "desktop" ? 0 : desktopMisses + 1;
        delay = data.runtime === "active" || (desktopMisses > 0 && desktopMisses <= 3) ? 2000 : 8000;
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
        if (ready()) timer = browser.setTimeout(() => { void refresh(); }, queued ? 0 : delay);
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
  kind: "command";
  command: string;
  reason: string;
  cwd: string;
  choices: ("accept" | "cancel")[];
  response?: { responseId: string; status: string } | null;
};

export type StopReceipt = {
  requestId: string;
  targetTurnId?: string;
  status: "pending" | "accepted" | "unknown" | "rejected" | "stopped" | "ended" | "not_found";
  code?: string;
};

export type AsyncQuestion = {
  id: string; key: string; sourceMessageId: string; title: string; options: string[];
  response?: { requestId: string; status: string } | null;
};

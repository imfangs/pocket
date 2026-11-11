import type { SavedTranscript } from "./conversationFeed";
import type { ReadingCache } from "./readingCache";
import { prefetchContent, coversPrefetchContent, transcriptPrefetchLimit, transcriptRefreshMs, validPrefetchId, type PrefetchContent, type TranscriptPrefetchCandidate } from "./prefetchPriority.ts";

export type TranscriptRead = (threadId: string, signal: AbortSignal) => Promise<SavedTranscript>;
export type HoldTranscriptPrefetch = () => () => void;
type ReaderOptions = {
  machine: string; scope: string; request: TranscriptRead;
  cache: Pick<ReadingCache, "loadTranscript" | "rememberTranscript">;
  current: () => boolean;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout> | undefined) => void;
  canPrefetch?: () => boolean;
  getForegroundId?: () => string | null;
  timeoutMs?: number; gapMs?: number;
};
type Consumer = { background: boolean; cancel: () => void };
type Flight = { controller: AbortController; consumers: Set<Consumer>; promise: Promise<SavedTranscript> };
type CandidateState = { candidate: TranscriptPrefetchCandidate; key: string; done: boolean; unusable: boolean;
  checkedCache: boolean; coveredContent?: PrefetchContent; failures: number; nextAt: number; attempt: number };
const abortError = () => new DOMException("读取已取消", "AbortError");
const candidateKey = ({ id, content }: TranscriptPrefetchCandidate) => JSON.stringify([id, content?.scope, content?.revision, content?.version, content?.messageId]);
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

// One scoped owner shares only in-flight requests. Completed raw responses stay
// in the existing bounded API cache; speculative results enter the sanitized L1/IDB.
export function createTranscriptReader(options: ReaderOptions) {
  const now = options.now ?? Date.now, later = options.setTimeout ?? setTimeout, clear = options.clearTimeout ?? clearTimeout;
  const flights = new Map<string, Flight>();
  let stopped = false, generation = 0, enabled = false, foregroundId: string | null = null;
  let candidates = new Map<string, CandidateState>(), timer: ReturnType<typeof setTimeout> | undefined;
  let background: { state: CandidateState; controller: AbortController } | null = null;
  let foregroundConsumers = 0, attempt = 0;
  let preemptions = 0, backgroundAfter = 0;
  const selectedId = () => options.getForegroundId ? options.getForegroundId() : foregroundId;
  const current = () => !stopped && options.current();
  const allowed = () => current() && enabled && !foregroundConsumers && (options.canPrefetch?.() ?? true);
  const resetCooldown = () => { preemptions = 0; backgroundAfter = 0; };
  const cancelBackground = (preempted = true) => {
    if (!background || background.controller.signal.aborted) return;
    if (preempted) {
      // One queue-wide cooldown: rotating eight candidates must not bypass it
      // when foreground polling repeatedly cuts a slow transfer short.
      preemptions = Math.min(preemptions + 1, 5);
      backgroundAfter = now() + Math.min(30000, 2000 * 2 ** (preemptions - 1));
    }
    background.controller.abort();
  };
  const schedule = (delay = options.gapMs ?? 750) => {
    clear(timer); timer = undefined;
    if (allowed() && !background) timer = later(() => { timer = undefined; void pump(); }, Math.max(0, delay, backgroundAfter - now()));
  };

  const read = (id: string, signal: AbortSignal, isBackground = false): Promise<SavedTranscript> => {
    if (!current() || signal.aborted || !validPrefetchId(id)) return Promise.reject(abortError());
    const ticket = generation;
    let flight = flights.get(id);
    if (!flight) {
      const controller = new AbortController();
      const entry: Flight = { controller, consumers: new Set(), promise: Promise.resolve(null as unknown as SavedTranscript) };
      flights.set(id, entry);
      entry.promise = Promise.resolve().then(() => {
        if (!current() || ticket !== generation || controller.signal.aborted) throw abortError();
        return options.request(id, controller.signal);
      }).then(data => {
        if (!current() || ticket !== generation || controller.signal.aborted) throw abortError();
        // Missing version metadata remains readable for older foreground APIs.
        // A known conflicting scope, however, cannot be shown under this owner.
        if (data.pocketContent?.known && data.pocketContent.scope !== options.scope)
          throw Object.assign(new Error("会话来源已变化"), { name: "AbortError", code: "transcript_scope_changed" });
        return data;
      }).finally(() => { if (flights.get(id) === entry) flights.delete(id); });
      // All consumers may cancel before a transport settles.
      void entry.promise.catch(() => {});
      flight = entry;
    }
    const entry = flight;
    return new Promise((resolve, reject) => {
      let settled = false;
      const consumer: Consumer = { background: isBackground, cancel: () => finish(undefined, abortError()) };
      const release = () => {
        entry.consumers.delete(consumer); signal.removeEventListener("abort", consumer.cancel);
        if (!isBackground) foregroundConsumers--;
        if (!entry.consumers.size && flights.get(id) === entry) { flights.delete(id); entry.controller.abort(); }
        schedule();
      };
      const finish = (value?: SavedTranscript, error?: unknown) => {
        if (settled) return;
        if (!error && (!current() || ticket !== generation || signal.aborted || entry.controller.signal.aborted)) error = abortError();
        settled = true; release();
        if (error) reject(error); else resolve(value!);
      };
      entry.consumers.add(consumer);
      if (!isBackground) {
        foregroundConsumers++;
        clear(timer); timer = undefined;
        if (background && background.state.candidate.id !== id) cancelBackground();
      }
      signal.addEventListener("abort", consumer.cancel, { once: true });
      if (signal.aborted) consumer.cancel();
      else entry.promise.then(value => finish(value), error => finish(undefined, error));
    });
  };

  async function pump() {
    if (!allowed() || background) return;
    const at = now();
    if (at < backgroundAfter) { schedule(); return; }
    const pending = [...candidates.values()].filter(state => !state.done);
    const state = pending.filter(item => item.nextAt <= at).sort((a, b) => a.attempt - b.attempt)[0];
    if (!state) {
      if (pending.length) schedule(Math.max(0, Math.min(...pending.map(item => item.nextAt)) - at));
      return;
    }
    const controller = new AbortController(), operation = { state, controller }, ticket = generation;
    state.attempt = ++attempt;
    background = operation;
    const stillCandidate = () => current() && ticket === generation && !controller.signal.aborted && candidates.get(state.candidate.id) === state;
    let timedOut = false;
    const deadline = later(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 12000);
    try {
      if (!state.checkedCache) {
        const cached = await untilAbort(options.cache.loadTranscript(options.machine, options.scope, state.candidate.id), controller.signal);
        if (!stillCandidate()) return;
        state.checkedCache = true;
        const cachedContent = prefetchContent(cached?.value.pocketContent, options.scope);
        if (cachedContent && (!state.candidate.content || coversPrefetchContent(cachedContent, state.candidate.content)) &&
          (!state.coveredContent || coversPrefetchContent(cachedContent, state.coveredContent))) {
          state.coveredContent = cachedContent;
          if (!state.candidate.refresh) { state.done = true; return; }
        }
      }
      if (!allowed() || !stillCandidate()) return;
      const data = await read(state.candidate.id, controller.signal, true);
      if (!stillCandidate()) return;
      // ReadingCache deliberately strips unknown capabilities; it does not
      // reject a body from a different source scope on the caller's behalf.
      const content = prefetchContent(data.pocketContent, options.scope);
      // The directory may catch up in steps behind a body already validated by
      // this owner. Neither a new candidate key nor an evicted cache can lower
      // that floor, and a higher directory version remains required too.
      const expected = [state.coveredContent, state.candidate.content].filter((value): value is PrefetchContent => !!value);
      if (!content || expected.some(value => !coversPrefetchContent(content, value))) { state.done = state.unusable = true; return; }
      // An uncachable response must not be downloaded repeatedly just to fight
      // the cache's existing schema or capacity limits. A new version retries.
      const remembered = options.cache.rememberTranscript(options.machine, options.scope, state.candidate.id, data);
      if (remembered) resetCooldown();
      state.coveredContent = content;
      state.unusable = !remembered;
      state.done = !remembered || !state.candidate.refresh;
      state.nextAt = now() + (state.candidate.refresh ? transcriptRefreshMs[state.candidate.refresh] : 0);
      state.failures = 0;
    } catch (error) {
      if (current() && ticket === generation && candidates.get(state.candidate.id) === state) {
        if ((error as { code?: string })?.code === "transcript_scope_changed") { state.done = state.unusable = true; return; }
        if (!controller.signal.aborted || timedOut) state.failures++;
        state.nextAt = now() + (controller.signal.aborted && !timedOut ? 1000 : Math.min(60000, 2000 * 2 ** Math.min(state.failures - 1, 5)));
      }
    } finally {
      clear(deadline);
      if (background === operation) background = null;
      schedule();
    }
  }

  return {
    available: current,
    read: (id: string, signal: AbortSignal) => read(id, signal),
    update(next: readonly TranscriptPrefetchCandidate[], state: { enabled: boolean; foregroundId: string | null }) {
      if (!current()) return;
      const returnedToList = foregroundId !== null && state.foregroundId === null;
      if (returnedToList) resetCooldown();
      enabled = state.enabled; foregroundId = state.foregroundId;
      const updated = new Map<string, CandidateState>();
      for (const candidate of next) {
        if (updated.size >= transcriptPrefetchLimit) break;
        if (candidate.id === foregroundId || !(prefetchContent(candidate.content, options.scope) ||
          candidate.content === null && candidate.refresh === "running") || !validPrefetchId(candidate.id) || updated.has(candidate.id)) continue;
        const key = candidateKey(candidate), previous = candidates.get(candidate.id);
        if (previous?.key === key) {
          const modeChanged = previous.candidate.refresh !== candidate.refresh;
          previous.candidate = candidate;
          if (modeChanged && !previous.unusable) {
            // Completion/read can change the full transcript (including a
            // failed-turn diagnostic) without changing its last assistant
            // version. Validate that transition once, then ordinary mode ends.
            previous.done = false;
            if (!previous.failures) previous.nextAt = 0;
          }
          updated.set(candidate.id, previous);
        } else updated.set(candidate.id, { candidate, key, done: false, unusable: false, checkedCache: false,
          coveredContent: previous?.coveredContent, failures: 0, nextAt: 0, attempt: 0 });
      }
      candidates = updated;
      if (background && background.state.candidate.id !== selectedId() &&
          (!allowed() || candidates.get(background.state.candidate.id) !== background.state)) cancelBackground(!allowed() && !returnedToList);
      schedule();
    },
    wake(forcePause = false) {
      if (background && (forcePause || !allowed() && background.state.candidate.id !== selectedId())) cancelBackground();
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true; generation++; enabled = false;
      clear(timer); timer = undefined; background?.controller.abort(); candidates.clear();
      for (const entry of flights.values()) {
        for (const consumer of [...entry.consumers]) consumer.cancel();
        entry.controller.abort();
      }
      flights.clear();
    },
  };
}
export type TranscriptReader = ReturnType<typeof createTranscriptReader>;

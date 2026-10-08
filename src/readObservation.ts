import type { Message, SavedTranscript } from "./conversationFeed";
import type { Thread } from "./types";

export type ReadObservation = { token: string; lastVisibleItemId: string; visibleVersion: string };
export type ReadReceipt = { requestId: string; status: "read" | "stale" | "unavailable" | "unknown"; code?: string; thread?: Thread };
export type ReadAttempts = Map<string, { token: string; status: ReadReceipt["status"] | "pending" }>;

// Only a fresh transcript supplies an observation. The desktop/display merge
// may contain newer text or a different turn, so compare the actual last item.
export function displayedReadObservation(fresh: SavedTranscript | null, displayed: Message[]): ReadObservation | null {
  const observation = fresh?.readObservation, saved = fresh?.messages.at(-1), shown = displayed.at(-1);
  if (!observation || !saved || !shown || !observation.token || !observation.visibleVersion ||
      observation.lastVisibleItemId !== saved.id || saved.id !== shown.id || saved.role !== shown.role ||
      saved.text !== shown.text || (saved.phase ?? "") !== (shown.phase ?? "") ||
      (saved.turnId ?? null) !== (shown.turnId ?? null) || !!saved.truncated !== !!shown.truncated) return null;
  return observation;
}

type Options = {
  root: HTMLElement;
  target: HTMLElement;
  observation: ReadObservation;
  attempted: ReadAttempts;
  getObservation?: () => ReadObservation | null;
  submit: (input: { requestId: string; observationToken: string }, signal: AbortSignal) => Promise<ReadReceipt>;
  onResult: (receipt: ReadReceipt) => void;
  onRead?: () => void;
  browser?: Window;
  visibility?: Document;
  Observer?: typeof IntersectionObserver;
};

// Mutations belong to visible reading, never to a feed callback. Replacing the
// observed content or leaving cancels both scheduled work and late UI results.
export function observeVisibleRead(options: Options) {
  const browser = options.browser ?? window, visibility = options.visibility ?? document;
  const Observer = options.Observer ?? globalThis.IntersectionObserver;
  if (!Observer) return () => {};
  const controller = new AbortController();
  let stopped = false, visible = false, submitted = false;
  let firstFrame: number | undefined, secondFrame: number | undefined;
  const clearFrames = () => {
    if (firstFrame !== undefined) browser.cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) browser.cancelAnimationFrame(secondFrame);
    firstFrame = secondFrame = undefined;
  };
  const unobstructed = () => {
    if (visibility.querySelector?.("dialog[open]")) return false;
    if (visibility.querySelector?.("[data-reading-overlay]")) return false;
    const backdrop = visibility.querySelector?.(".sidebar-backdrop.shown")?.getBoundingClientRect();
    return !backdrop || backdrop.width === 0 || backdrop.height === 0;
  };
  const ready = () => !stopped && visible && visibility.visibilityState === "visible" && browser.navigator.onLine !== false && unobstructed();
  const currentObservation = () => options.getObservation ? options.getObservation() : options.observation;
  const canAttempt = () => {
    const current = currentObservation();
    if (!current || current.visibleVersion !== options.observation.visibleVersion) return false;
    const previous = options.attempted.get(current.visibleVersion);
    return !previous || previous.status === "stale" && previous.token !== current.token;
  };
  const shown = () => {
    const root = options.root.getBoundingClientRect(), target = options.target.getBoundingClientRect();
    return root.width > 0 && root.height > 0 && target.width > 0 && target.height > 0 &&
      target.top >= root.top - 1 && target.bottom <= root.bottom + 1;
  };
  const schedule = () => {
    if (!ready()) { clearFrames(); return; }
    if (!canAttempt() || firstFrame !== undefined || secondFrame !== undefined) return;
    firstFrame = browser.requestAnimationFrame(() => {
      firstFrame = undefined;
      if (!ready()) return;
      secondFrame = browser.requestAnimationFrame(() => {
        secondFrame = undefined;
        if (!ready() || !shown() || !canAttempt()) return;
        const observation = currentObservation()!;
        options.attempted.set(observation.visibleVersion, { token: observation.token, status: "pending" });
        const requestId = crypto.randomUUID();
        submitted = true;
        const receive = (result: ReadReceipt) => {
          const attempt = options.attempted.get(observation.visibleVersion);
          if (attempt?.token === observation.token && attempt.status === "pending")
            options.attempted.set(observation.visibleVersion, { token: observation.token, status: result.status });
          // A completed native write still matters after the user returns to the
          // list. Only this global refresh may outlive the reading component.
          if (result.status === "read") options.onRead?.();
          if (stopped || controller.signal.aborted) return;
          options.onResult(result);
        };
        void (async () => {
          try {
            const result = await options.submit({ requestId, observationToken: observation.token }, controller.signal);
            receive(result.requestId === requestId ? result : { requestId, status: "unknown", code: "receipt_mismatch" });
          } catch {
            receive({ requestId, status: "unknown" });
          }
        })();
      });
    });
  };
  const observer = new Observer(entries => {
    for (const entry of entries) if (entry.target === options.target) visible = entry.isIntersecting && entry.intersectionRatio > 0;
    schedule();
  }, { root: options.root, threshold: 1 });
  observer.observe(options.target);
  visibility.addEventListener("visibilitychange", schedule);
  browser.addEventListener("online", schedule);
  browser.addEventListener("offline", schedule);
  browser.addEventListener("pocket-reading-visibility-change", schedule);
  return () => {
    stopped = true;
    clearFrames();
    observer.disconnect();
    if (!submitted) controller.abort();
    visibility.removeEventListener("visibilitychange", schedule);
    browser.removeEventListener("online", schedule);
    browser.removeEventListener("offline", schedule);
    browser.removeEventListener("pocket-reading-visibility-change", schedule);
  };
}

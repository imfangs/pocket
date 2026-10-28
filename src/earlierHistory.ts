import type { Message } from "./conversationFeed";

export const earlierHistoryLimits = { pages: 3, cursorTrail: 64, pageMessages: 80, pageText: 160000, pageJson: 500000 } as const;
export type EarlierHistoryPage = {
  source: "rollout"; messages: Message[]; hasMore: boolean; nextCursor: string | null;
  page: { kind: "recent" | "older" };
};
type LoadedPage = EarlierHistoryPage & { inputCursor: string | null };
type PageReference = { inputCursor: string | null; recent?: LoadedPage };
export type EarlierHistoryChange = "initial" | "older" | "newer" | "restart";
export type EarlierHistoryState = {
  active: boolean; loading: boolean; error: string; expired: boolean;
  messages: Message[]; hasOlder: boolean; hasNewer: boolean; canLoadNewer: boolean;
  ready: EarlierHistoryChange | null; revision: number;
};
type Window = { pages: LoadedPage[]; newer: PageReference[]; newerOmitted: boolean };
const emptyWindow = (): Window => ({ pages: [], newer: [], newerOmitted: false });
const initial = (): EarlierHistoryState => ({ active: false, loading: false, error: "", expired: false,
  messages: [], hasOlder: false, hasNewer: false, canLoadNewer: false, ready: null, revision: 0 });
const invalid = () => new Error("历史分页暂时无法读取，请重试。");
const cursor = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 2048;

export function readEarlierHistoryPage(value: unknown, inputCursor: string | null): LoadedPage {
  const data = value as Partial<EarlierHistoryPage> | null;
  if (!data || data.source !== "rollout" || !Array.isArray(data.messages) || data.messages.length > earlierHistoryLimits.pageMessages ||
      data.page?.kind !== (inputCursor === null ? "recent" : "older") || typeof data.hasMore !== "boolean" ||
      (data.hasMore ? !cursor(data.nextCursor) || data.nextCursor === inputCursor : data.nextCursor !== null)) throw invalid();
  let length = 0;
  const messages = data.messages.map(item => {
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 1024 ||
        !["user", "assistant"].includes(item.role) || typeof item.text !== "string" || item.text.length > 24000) throw invalid();
    length += item.text.length;
    // Old pages carry display data only, even if a future endpoint adds control
    // fields. In particular a saved clientMessageId is never send evidence.
    const { id, role, text, turnId, phase, timestamp, truncated, isQuestion, turnDurationMs, images, files, attachments } = item;
    return { id, role, text, turnId, phase, timestamp, truncated, isQuestion, turnDurationMs, images, files, attachments };
  });
  if (length > earlierHistoryLimits.pageText || JSON.stringify(messages).length > earlierHistoryLimits.pageJson) throw invalid();
  return { source: "rollout", messages, hasMore: data.hasMore, nextCursor: data.nextCursor!, page: { kind: data.page.kind }, inputCursor };
}

function visibleMessages(pages: LoadedPage[]) {
  const seen = new Set<string>();
  return pages.flatMap(page => page.messages).filter(message => {
    if (seen.has(message.id)) return false;
    seen.add(message.id); return true;
  });
}
function prepend(window: Window, page: LoadedPage): Window {
  const pages = [page, ...window.pages], newer = [...window.newer];
  let newerOmitted = window.newerOmitted;
  if (pages.length > earlierHistoryLimits.pages) {
    const dropped = pages.pop()!;
    newer.push({ inputCursor: dropped.inputCursor, ...(dropped.inputCursor === null ? { recent: dropped } : {}) });
  }
  if (newer.length > earlierHistoryLimits.cursorTrail) { newer.shift(); newerOmitted = true; }
  return { pages, newer, newerOmitted };
}

// One reader belongs to one mounted conversation. Neither pages nor cursor
// trails enter the live history cache or browser storage.
export function createEarlierHistoryReader({ read, canApply = () => true, timeoutMs = 50000 }: {
  read: (before: string | null, signal: AbortSignal) => Promise<unknown>;
  canApply?: (messages: Message[], change: EarlierHistoryChange, recentBoundary: string | null) => boolean;
  timeoutMs?: number;
}) {
  let state = initial(), window = emptyWindow(), generation = 0;
  let flight: Promise<void> | null = null, controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let prepared: { window: Window; change: EarlierHistoryChange } | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<EarlierHistoryState>) => {
    state = { ...state, ...patch }; for (const listener of listeners) listener();
  };
  const apply = (next: Window, change: EarlierHistoryChange) => {
    const messages = visibleMessages(next.pages);
    if (!canApply(messages, change, next.pages.at(-1)?.messages[0]?.id ?? null)) {
      prepared = { window: next, change };
      publish({ loading: false, ready: change, error: "", expired: false }); return;
    }
    prepared = null; window = next;
    publish({ active: true, loading: false, error: "", expired: false, ready: null,
      messages, hasOlder: next.pages[0]?.hasMore ?? false,
      hasNewer: next.newer.length > 0 || next.newerOmitted, canLoadNewer: next.newer.length > 0,
      revision: state.revision + 1 });
  };
  const load = (direction: "older" | "newer" | "restart"): Promise<void> => {
    if (flight) return flight;
    if (prepared && (direction === prepared.change || direction === "older" && prepared.change === "initial")) {
      apply(prepared.window, prepared.change); return Promise.resolve();
    }
    if (state.expired && direction !== "restart") return Promise.resolve();
    if (direction === "older" && state.active && !state.hasOlder || direction === "newer" && !state.canLoadNewer) return Promise.resolve();
    prepared = null;
    const ticket = ++generation, current = new AbortController(); controller = current;
    publish({ loading: true, error: "", ready: null });
    timer = setTimeout(() => {
      if (ticket !== generation) return;
      generation++; current.abort(); controller = null; flight = null; timer = undefined;
      publish({ loading: false, error: "读取较慢，请重试。", ready: null });
    }, timeoutMs);
    const page = async (before: string | null) => {
      if (current.signal.aborted) throw new DOMException("Aborted", "AbortError");
      return readEarlierHistoryPage(await read(before, current.signal), before);
    };
    flight = Promise.resolve().then(async () => {
      try {
        let next: Window, change: EarlierHistoryChange;
        if (!state.active || direction === "restart") {
          const recent = await page(null);
          if (ticket !== generation || current.signal.aborted) return;
          if (!recent.messages.length) {
            publish({ loading: false, ready: null, expired: state.active,
              error: state.active ? "历史已更新，可返回最新查看。" : "暂未找到更早消息。" });
            return;
          }
          const older = recent.nextCursor ? await page(recent.nextCursor) : null;
          next = { pages: older ? [older, recent] : [recent], newer: [], newerOmitted: false };
          change = state.active ? "restart" : "initial";
        } else if (direction === "older") {
          next = prepend(window, await page(window.pages[0].nextCursor)); change = "older";
        } else {
          const reference = window.newer.at(-1)!;
          const newer = reference.recent ?? await page(reference.inputCursor);
          const pages = [...window.pages, newer];
          if (pages.length > earlierHistoryLimits.pages) pages.shift();
          next = { pages, newer: window.newer.slice(0, -1), newerOmitted: window.newerOmitted }; change = "newer";
        }
        if (ticket === generation && !current.signal.aborted) apply(next, change);
      } catch (error) {
        if (ticket !== generation || current.signal.aborted) return;
        const status = (error as { status?: number }).status, expired = status === 409;
        publish({ loading: false, ready: null, expired,
          error: expired ? "历史位置已变化，请重新核对。" : status === 413
            ? "这份历史较大，暂时无法继续加载。" : "暂时无法读取更早消息，请重试。" });
      } finally {
        if (ticket === generation) { clearTimeout(timer); timer = undefined; controller = null; flight = null; }
      }
    });
    return flight;
  };
  const stop = () => { generation++; clearTimeout(timer); timer = undefined; controller?.abort(); controller = null; flight = null; prepared = null; };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    older: () => load("older"), newer: () => load("newer"), restart: () => load("restart"),
    applyReady() { if (prepared) apply(prepared.window, prepared.change); },
    leave() { stop(); window = emptyWindow(); const revision = state.revision + 1; state = initial(); publish({ revision }); },
    stop,
  };
}
export type EarlierHistoryReader = ReturnType<typeof createEarlierHistoryReader>;

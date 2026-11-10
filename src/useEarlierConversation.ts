import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { api } from "./api";
import type { Message } from "./conversationFeed";
import { createEarlierHistoryReader, type EarlierHistoryChange } from "./earlierHistory";
import { captureEarlierHistoryAnchor, restoreEarlierHistoryAnchor, type EarlierHistoryAnchor } from "./earlierHistoryAnchor";
import { bindEarlierHistoryScroll } from "./earlierHistoryScroll";
import { hasMessageSelection } from "./useProgressMessages";

type Options = {
  threadId: string;
  root: RefObject<HTMLDivElement | null>;
  conversationRoot: RefObject<HTMLElement | null>;
  online: boolean;
  hasEarlierMessages: boolean | undefined;
  isComposing: () => boolean;
  onAutomaticStart: () => void;
};

// Own the historical window's request, gesture and reading-anchor lifecycle.
// Live messages, receipts and read watermarks remain outside this display path.
export function useEarlierConversation(options: Options) {
  const { threadId, root, conversationRoot } = options;
  const latest = useRef(options); latest.current = options;
  const anchor = useRef<{ value: EarlierHistoryAnchor; scrollTop: number } | null>(null);
  const start = useRef<{ top: number; id: string | null } | null>(null);
  const automatic = useRef<symbol | null>(null);
  const gesture = useRef<ReturnType<typeof bindEarlierHistoryScroll> | null>(null);
  const previousActive = useRef(false);
  const prepare = useRef<(messages: Message[], change: EarlierHistoryChange, boundary: string | null) => boolean>(() => true);
  const reader = useMemo(() => createEarlierHistoryReader({
    read: (before, signal) => api(`/api/tasks/${threadId}/transcript-page${before ? `?before=${encodeURIComponent(before)}` : ""}`,
      "GET", undefined, { signal }),
    canApply: (...args) => prepare.current(...args),
  }), [threadId]);
  const subscribe = useCallback((listener: () => void) => reader.subscribe(() => {
    if (!anchor.current && root.current) {
      const value = captureEarlierHistoryAnchor(root.current);
      if (value) anchor.current = { value, scrollTop: root.current.scrollTop };
    }
    listener();
  }), [reader, root]);
  const state = useSyncExternalStore(subscribe, reader.getSnapshot, reader.getSnapshot);
  const current = useRef(state); current.current = state;
  // A notification can precede its React commit. Reading that happened in the
  // gap takes over from the saved anchor. Check before DOM changes, because a
  // real prepend may itself change scrollTop through native scroll anchoring.
  if (anchor.current && root.current && Math.abs(root.current.scrollTop - anchor.current.scrollTop) > 2)
    anchor.current = null;

  prepare.current = (next, change, boundary) => {
    const element = root.current;
    if (!element || hasMessageSelection(element) || element.querySelector(".outbox-inline-actions textarea") ||
        element.ownerDocument.querySelector("[data-reading-motion], [data-reading-overlay], dialog[open]")) return false;
    const focused = element.ownerDocument.activeElement;
    if (latest.current.isComposing() || focused && conversationRoot.current?.contains(focused) &&
        focused.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return false;
    // A background read cannot replace the live view after the user moved away.
    if (automatic.current && element.scrollTop > 48) return false;
    const visibleAnchor = captureEarlierHistoryAnchor(element);
    const candidateIds = new Set(next.map(message => message.id));
    const keepsAnchor = !!visibleAnchor && candidateIds.has(visibleAnchor.id);
    const sharedAnchor = captureEarlierHistoryAnchor(element, candidateIds);
    // Keep an in-use page instead of evicting the anchor while a read is pending.
    if (current.current.active && change !== "restart" && visibleAnchor && !keepsAnchor) return false;
    if (!current.current.active && change === "initial" && !sharedAnchor && start.current &&
        (Math.abs(element.scrollTop - start.current.top) > 2 || (visibleAnchor?.id ?? null) !== start.current.id)) return false;
    // Native user IDs may differ; prefer an exact shared assistant identity.
    const value = sharedAnchor ?? (boundary ? { id: boundary, offset: visibleAnchor?.offset ?? 0 } : null);
    anchor.current = value ? { value, scrollTop: element.scrollTop } : null;
    return true;
  };

  const rememberStart = useCallback(() => {
    const element = root.current;
    start.current = element ? { top: element.scrollTop, id: captureEarlierHistoryAnchor(element)?.id ?? null } : null;
  }, [root]);
  const loadOlder = useCallback((fromGesture: boolean) => {
    if (!fromGesture) gesture.current?.cancel();
    if (!current.current.active && !current.current.loading) rememberStart();
    return reader.older();
  }, [reader, rememberStart]);
  const older = useCallback(() => loadOlder(false), [loadOlder]);
  const applyReady = useCallback(() => {
    gesture.current?.cancel();
    if (!current.current.active) rememberStart();
    reader.applyReady();
  }, [reader, rememberStart]);
  const newer = useCallback(() => {
    gesture.current?.cancel();
    if (current.current.ready === "newer") reader.applyReady();
    else return reader.newer();
  }, [reader]);
  const restart = useCallback(() => { gesture.current?.cancel(); return reader.restart(); }, [reader]);
  const leave = useCallback(() => {
    gesture.current?.cancel();
    automatic.current = null;
    reader.leave();
  }, [reader]);
  const isActive = useCallback(() => current.current.active, []);
  const isAutomaticLoad = useCallback(() => automatic.current !== null, []);

  useEffect(() => () => reader.stop(), [reader]);
  useLayoutEffect(() => {
    if ((state.active || !previousActive.current) && anchor.current && root.current)
      restoreEarlierHistoryAnchor(root.current, anchor.current.value);
    anchor.current = null;
    previousActive.current = state.active;
  }, [state, root]);

  // The caller registers this effect after messageScrollDismiss so existing
  // touch/keyboard-settling listener order is preserved without deferred work.
  const bindScroll = useCallback(() => {
    const element = root.current;
    if (!element) return;
    const binding = bindEarlierHistoryScroll(element, {
      canLoad: () => {
        const value = current.current;
        const readyOlder = value.ready === "initial" || value.ready === "older";
        return latest.current.online && !value.loading && !value.expired && (!value.ready || readyOlder) &&
          (readyOlder || (value.active ? value.hasOlder : !!latest.current.hasEarlierMessages)) &&
          !latest.current.isComposing() && !hasMessageSelection(element) &&
          !element.querySelector(".outbox-inline-actions textarea");
      },
      load: async () => {
        const focused = element.ownerDocument.activeElement;
        if (focused && conversationRoot.current?.contains(focused) &&
            focused.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
        const operation = Symbol();
        automatic.current = operation;
        // Freeze following before reading: a short live window may be at bottom.
        latest.current.onAutomaticStart();
        try { await loadOlder(true); } finally {
          if (automatic.current === operation) automatic.current = null;
        }
      },
    });
    gesture.current = binding;
    return () => {
      if (gesture.current === binding) gesture.current = null;
      binding();
    };
  }, [root, conversationRoot, loadOlder]);

  return { state, older, newer, restart, applyReady, leave, isActive, isAutomaticLoad, bindScroll };
}

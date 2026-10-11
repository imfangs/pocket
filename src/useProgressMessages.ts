import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { HistoryCache, Message, ProgressViewState } from "./conversationFeed";
import { groupProgressMessages } from "./progressGroups";

export function hasMessageSelection(root: HTMLElement | null) {
  if (!root) return false;
  const selection = root.ownerDocument.getSelection();
  return !!selection && !selection.isCollapsed && selection.rangeCount > 0 &&
    selection.getRangeAt(0).intersectsNode(root);
}

function replacesSelectedText(root: HTMLElement | null, previous: Message[], incoming: Message[]) {
  if (!root || !hasMessageSelection(root)) return false;
  const range = root.ownerDocument.getSelection()?.getRangeAt(0);
  if (!range) return false;
  const oldById = new Map(previous.map(message => [message.id, message]));
  const nextById = new Map(incoming.map(message => [message.id, message]));
  return [...root.querySelectorAll<HTMLElement>("[data-message-id]")].some(node => {
    if (!range.intersectsNode(node)) return false;
    const id = node.dataset.messageId!, before = oldById.get(id), after = nextById.get(id);
    return !!before && (!after || before.text !== after.text || before.phase !== after.phase || before.role !== after.role);
  });
}

// Folding is presentation only. New groups wait while the reader is elsewhere
// so existing text nodes, selection and reading position remain intact.
export function useProgressMessages({ messages, protectedIds, root, nearBottom, away, cache, threadId, onPosition }: {
  messages: Message[];
  protectedIds: ReadonlySet<string>;
  root: RefObject<HTMLDivElement | null>;
  nearBottom: RefObject<boolean>;
  away: boolean;
  cache: HistoryCache;
  threadId: string;
  onPosition: (nearBottom: boolean) => void;
}) {
  const previous = useRef<{ initialized: boolean; view: ProgressViewState; rendered: Message[] }>({
    initialized: !!cache.get(threadId)?.progressView,
    view: cache.get(threadId)?.progressView ?? { expanded: [], deferred: [], seen: [] },
    rendered: messages,
  });
  const [expanded, setExpanded] = useState(() => new Set(previous.current.view.expanded));
  const [readingRevision, setReadingRevision] = useState(0);
  const layoutPending = useRef(false);
  const canonicalVisible = useRef(false);
  const anchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const position = useRef(onPosition); position.current = onPosition;
  const readingProtected = useCallback(() => {
    const element = root.current;
    const focused = element?.ownerDocument.activeElement;
    return hasMessageSelection(element) || !!element && !!focused && focused !== element && element.contains(focused);
  }, [root]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let protectedBefore = readingProtected(), selectedBefore = hasMessageSelection(element), alive = true;
    const check = () => {
      if (!alive) return;
      const next = readingProtected();
      const selected = hasMessageSelection(element);
      if (next !== protectedBefore || selected !== selectedBefore) {
        protectedBefore = next; selectedBefore = selected; layoutPending.current = true;
        setReadingRevision(value => value + 1);
      }
    };
    const afterFocus = () => queueMicrotask(check);
    element.ownerDocument.addEventListener("selectionchange", check);
    element.addEventListener("focusin", afterFocus);
    element.addEventListener("focusout", afterFocus);
    return () => {
      alive = false;
      element.ownerDocument.removeEventListener("selectionchange", check);
      element.removeEventListener("focusin", afterFocus);
      element.removeEventListener("focusout", afterFocus);
    };
  }, [root, readingProtected]);

  const presentation = useMemo(() => {
    // Native/rollout feeds may replace IDs when a recorded final arrives first.
    // Keep selected text nodes until selection ends; canonical messages still
    // reach receipt matching and source validation in Conversation.
    const rendered = replacesSelectedText(root.current, previous.current.rendered, messages)
      ? previous.current.rendered : messages;
    const candidates = groupProgressMessages(rendered, protectedIds);
    const groups = candidates.filter(entry => entry.type === "progress");
    const seen = new Set(previous.current.view.seen);
    const visibleIds = new Set(rendered.map(message => message.id));
    const deferred = new Set(previous.current.view.deferred.filter(id => visibleIds.has(id)));
    if (!nearBottom.current || readingProtected()) {
      if (previous.current.initialized) for (const group of groups)
        if (!seen.has(group.id)) for (const message of group.messages) deferred.add(message.id);
    } else deferred.clear();
    return {
      rendered,
      entries: deferred.size ? groupProgressMessages(rendered, new Set([...protectedIds, ...deferred])) : candidates,
      view: { deferred: [...deferred], seen: groups.map(group => group.id),
        expanded: [...expanded].filter(id => groups.some(group => group.id === id)) },
    };
  }, [messages, protectedIds, expanded, away, readingRevision, nearBottom, readingProtected, root]);

  useLayoutEffect(() => {
    previous.current = { initialized: true, view: presentation.view, rendered: presentation.rendered };
    canonicalVisible.current = presentation.rendered === messages;
    const saved = cache.get(threadId);
    if (saved) saved.progressView = presentation.view;
    const element = root.current, adjustment = anchor.current;
    anchor.current = null;
    if (element && adjustment?.element.isConnected) {
      element.scrollTop += adjustment.element.getBoundingClientRect().top - adjustment.top;
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
      nearBottom.current = atBottom;
      position.current(atBottom);
      if (saved) { saved.scrollTop = element.scrollTop; saved.nearBottom = atBottom; }
    }
    // Read observation resumes after the new layout and its scroll restoration.
    layoutPending.current = true;
    const frame = requestAnimationFrame(() => {
      layoutPending.current = false;
      window.dispatchEvent(new Event("pocket-reading-visibility-change"));
    });
    return () => cancelAnimationFrame(frame);
  }, [presentation, messages, cache, threadId, root, nearBottom]);

  const toggle = useCallback((id: string, open: boolean) => {
    const element = root.current;
    const button = element?.ownerDocument.getElementById(`${id}-toggle`);
    if (button && element?.contains(button)) anchor.current = { element: button, top: button.getBoundingClientRect().top };
    layoutPending.current = true;
    nearBottom.current = false;
    position.current(false);
    setExpanded(current => {
      const next = new Set([...current].filter(key => previous.current.view.seen.includes(key)));
      if (open) next.add(id); else next.delete(id);
      return next;
    });
  }, [root, nearBottom]);
  const canObserve = useCallback(() => canonicalVisible.current && !layoutPending.current && !hasMessageSelection(root.current), [root]);
  return { entries: presentation.entries, expanded, toggle, canObserve, readingProtected };
}

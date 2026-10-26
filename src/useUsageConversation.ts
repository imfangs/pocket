import { useEffect, useRef, type RefObject } from "react";
import { usage } from "./usageAnalytics";
import type { Message } from "./conversationFeed";
import type { SubmittedQuery } from "./submittedQueries";

export function useUsageConversation(threadId: string, root: RefObject<HTMLElement | null>,
  shownMessages: readonly Message[], submissions: readonly SubmittedQuery[], hasDraft: boolean) {
  const draft = useRef(hasDraft);
  draft.current = hasDraft;
  useEffect(() => {
    let visitId: string | null = null;
    // The first StrictMode setup is cancelled before any events are emitted.
    const frame = requestAnimationFrame(() => { visitId = usage.open(threadId); });
    return () => { cancelAnimationFrame(frame); usage.close(visitId, { draft_present: draft.current }); };
  }, [threadId]);
  useEffect(() => { for (const item of submissions) usage.receipt(threadId, item.requestId, item.status); }, [threadId, submissions]);
  useEffect(() => {
    const region = root.current;
    if (!region || typeof IntersectionObserver === "undefined") return;
    const byId = new Map(shownMessages.map(message => [message.id, message]));
    const visible = new Set<Element>();
    const check = () => {
      if (document.visibilityState === "hidden" || !region.isConnected || region.closest('[inert], [aria-hidden="true"]') ||
          document.querySelector('dialog[open], [data-reading-overlay]')) return;
      for (const element of visible) {
        if (!element.isConnected || !element.getClientRects().length) continue;
        usage.contentVisible(threadId, shownMessages.length);
        const message = byId.get(element.getAttribute("data-message-id") || "");
        if (message?.role === "user" && message.clientMessageId && !message.truncated) usage.messageVisible(threadId, message.clientMessageId);
      }
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) { if (entry.isIntersecting && entry.intersectionRatio > 0) visible.add(entry.target); else visible.delete(entry.target); }
      check();
    }, { root: region, threshold: 0 });
    for (const element of region.querySelectorAll("[data-message-id], .conversation-empty, .question-prompts, .progress-disclosure, [data-submission-id], [data-outbox-id]")) observer.observe(element);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pocket-reading-visibility-change", check);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", check); window.removeEventListener("pocket-reading-visibility-change", check); };
  }, [threadId, root, shownMessages]);
}

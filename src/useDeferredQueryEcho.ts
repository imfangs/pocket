import { useLayoutEffect, useRef, useState } from "react";
import type { Message } from "./conversationFeed";
import type { SubmittedQuery } from "./submittedQueries";
import { sameAttachments } from "./attachments.ts";

export const QUERY_ECHO_WAIT_MS = 18000;
const awaitingEcho = new Set(["submitting", "connecting", "pending", "queued", "accepted", "unknown"]);

function candidate(message: Message, entries: readonly SubmittedQuery[]) {
  if (message.role !== "user" || message.clientMessageId || message.truncated) return false;
  return entries.some(entry => !entry.echoed && !entry.dismissed && awaitingEcho.has(entry.status)
    && message.text.trim() === entry.text.trim() && sameAttachments(message.attachments, entry.attachments));
}

// This is a bounded display wait, not an identity match. Original messages and
// receipt/read state remain untouched. Once shown, an ID is never hidden again.
export function createDeferredQueryEcho(now: () => number = () => performance.now()) {
  let initialized = false;
  const shown = new Set<string>();
  const deadlines = new Map<string, number>();
  const view = (messages: readonly Message[], entries: readonly SubmittedQuery[], disabled: boolean) => {
    const hidden = new Set<string>(), time = now();
    if (!initialized || disabled) return hidden;
    for (const message of messages) {
      if (!shown.has(message.id) && (deadlines.get(message.id) ?? Infinity) > time && candidate(message, entries))
        hidden.add(message.id);
    }
    return hidden;
  };
  const release = (ids: Iterable<string>) => {
    let changed = false;
    for (const id of ids) {
      changed = deadlines.delete(id) || changed;
      shown.add(id);
    }
    return changed;
  };
  return {
    view,
    release,
    observe(messages: readonly Message[], entries: readonly SubmittedQuery[], disabled: boolean) {
      const hidden = view(messages, entries, disabled), fresh: string[] = [], time = now();
      const present = new Set(messages.map(message => message.id));
      for (const id of deadlines.keys()) if (!present.has(id) || !hidden.has(id)) release([id]);
      for (const message of messages) {
        if (!hidden.has(message.id)) shown.add(message.id);
        else if (!deadlines.has(message.id)) {
          deadlines.set(message.id, time + QUERY_ECHO_WAIT_MS);
          fresh.push(message.id);
        }
      }
      initialized = true;
      const deadline = deadlines.size ? Math.min(...deadlines.values()) : null;
      return { hidden, fresh, remainingMs: deadline === null ? null : Math.max(0, deadline - now()) };
    },
  };
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  return a.size === b.size && [...a].every(id => b.has(id));
}

export function useDeferredQueryEcho(messages: readonly Message[], entries: readonly SubmittedQuery[],
  options: { disabled: boolean; refresh: () => void | Promise<unknown> }): ReadonlySet<string> {
  const [controller] = useState(createDeferredQueryEcho);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false), refresh = useRef(options.refresh);
  refresh.current = options.refresh;
  const hidden = controller.view(messages, entries, options.disabled);
  useLayoutEffect(() => {
    mounted.current = true;
    // Suspended timers cannot extend the wait when a tab returns to foreground.
    const wake = () => { if (mounted.current) setRevision(value => value + 1); };
    window.addEventListener("pageshow", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      mounted.current = false;
      window.removeEventListener("pageshow", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
  useLayoutEffect(() => {
    const observation = controller.observe(messages, entries, options.disabled);
    // A deadline may pass between render and commit. Do not leave that last
    // hidden render on screen after the observer has already released it.
    if (!sameIds(hidden, observation.hidden)) setRevision(value => value + 1);
    if (observation.fresh.length) {
      void Promise.resolve().then(() => mounted.current ? refresh.current() : undefined).catch(() => {
        if (controller.release(observation.fresh) && mounted.current) setRevision(value => value + 1);
      });
    }
    const timer = observation.remainingMs === null ? undefined : window.setTimeout(() => {
      if (mounted.current) setRevision(value => value + 1);
    }, Math.max(1, observation.remainingMs));
    return () => window.clearTimeout(timer);
  }, [controller, messages, entries, options.disabled, revision]);
  return hidden;
}

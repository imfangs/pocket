import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { api } from "./api";
import type { SavedTranscript } from "./conversationFeed";
import { currentMachineId, type MachineId } from "./machineScope";
import { subscribeReadingCacheInvalidation, type ReadingCache } from "./readingCache";
import { transcriptPrefetchCandidates, type ReadPriorityOptions } from "./prefetchPriority";
import { requestActivity } from "./requestActivity";
import { createTranscriptReader, type TranscriptReader } from "./transcriptReader";
import type { Thread } from "./types";

type Options = {
  machine: MachineId | null; scope?: string; cache: ReadingCache | null;
  readerRef: RefObject<TranscriptReader | null>;
  threads: readonly Thread[]; priority: ReadPriorityOptions;
  enabled: boolean; catalogFresh: () => boolean;
};
const editable = (document: Document) => document.activeElement instanceof HTMLElement &&
  document.activeElement.matches("input,textarea,select,[contenteditable]:not([contenteditable='false'])");
const requestTranscript = (id: string, signal: AbortSignal) => api<SavedTranscript>(`/api/tasks/${id}/transcript`, "GET", undefined, { signal });

export default function useTranscriptPrefetch(options: Options) {
  const { machine, scope, cache, readerRef } = options;
  const latest = useRef(options); latest.current = options;
  const foregroundHolds = useRef(new Set<symbol>());
  const candidates = useMemo(() => scope ? transcriptPrefetchCandidates(options.threads, scope, options.priority) : [],
    [scope, options.threads, options.priority]);
  useLayoutEffect(() => {
    if (!machine || !scope || !cache) return;
    let composing = false, focusTimer: ReturnType<typeof setTimeout> | undefined;
    const reader: TranscriptReader = createTranscriptReader({
      machine, scope, cache, request: requestTranscript,
      getForegroundId: () => latest.current.priority.selectedId ?? null,
      current: () => readerRef.current === reader && currentMachineId() === machine && latest.current.scope === scope && latest.current.cache === cache,
      canPrefetch: () => document.visibilityState === "visible" && navigator.onLine !== false && latest.current.catalogFresh()
        && !foregroundHolds.current.size && !composing && !editable(document)
        && !(latest.current.priority.selectedId && requestActivity.isPending(machine, latest.current.priority.selectedId)),
    });
    readerRef.current = reader;
    const invalidateReader = () => { reader.stop(); if (readerRef.current === reader) readerRef.current = null; };
    const foreground = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => { if (!editable(document)) composing = false; reader.wake(); }, 0);
    };
    const editing = (event: Event) => {
      if (event.type === "compositionstart") composing = true;
      if (event.type === "compositionend") composing = false;
      reader.wake();
      foreground();
    };
    const visible = () => {
      if (document.visibilityState !== "visible" || navigator.onLine === false) { composing = false; reader.wake(true); }
      else foreground();
    };
    const invalidate = (event: Event) => {
      const affected = (event as CustomEvent<{ machine?: string }>).detail?.machine;
      if (!affected || affected === machine) invalidateReader();
    };
    const unsubscribeCache = subscribeReadingCacheInvalidation(event => { if (!event.machine || event.machine === machine) invalidateReader(); });
    const unsubscribeActivity = requestActivity.subscribe(() => reader.wake());
    document.addEventListener("focusin", editing);
    document.addEventListener("focusout", foreground);
    document.addEventListener("input", editing);
    document.addEventListener("compositionstart", editing);
    document.addEventListener("compositionend", editing);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("online", visible);
    window.addEventListener("offline", visible);
    window.addEventListener("pageshow", visible);
    window.addEventListener("navigator-auth-expired", invalidate);
    return () => {
      invalidateReader();
      clearTimeout(focusTimer); unsubscribeCache(); unsubscribeActivity();
      document.removeEventListener("focusin", editing);
      document.removeEventListener("focusout", foreground);
      document.removeEventListener("input", editing);
      document.removeEventListener("compositionstart", editing);
      document.removeEventListener("compositionend", editing);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("online", visible);
      window.removeEventListener("offline", visible);
      window.removeEventListener("pageshow", visible);
      window.removeEventListener("navigator-auth-expired", invalidate);
    };
  }, [machine, scope, cache, readerRef]);
  useLayoutEffect(() => { readerRef.current?.update(candidates, { enabled: options.enabled, foregroundId: options.priority.selectedId ?? null }); },
    [machine, scope, cache, candidates, options.enabled, options.priority.selectedId, readerRef]);
  // Stable across cache/scope setup: mounting the coordinator must not restart
  // an existing foreground feed. Older servers keep their original direct read.
  const readTranscript = useCallback((id: string, signal: AbortSignal) => readerRef.current?.available()
    ? readerRef.current.read(id, signal) : requestTranscript(id, signal), [readerRef]);
  const holdBackground = useCallback(() => {
    const token = Symbol(); foregroundHolds.current.add(token); readerRef.current?.wake();
    return () => { if (foregroundHolds.current.delete(token)) readerRef.current?.wake(); };
  }, [readerRef]);
  return { readTranscript, holdBackground };
}

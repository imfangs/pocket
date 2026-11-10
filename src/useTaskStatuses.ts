import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { initialTaskStatuses, startTaskStatusPolling, type TaskStatusResponse } from "./taskStatuses";
import { createTaskHotset, taskStatusRequestPath, type TaskHotsetContext } from "./taskHotset";
import { createListActivityCache, type NativeListObservation } from "./listActivityCache";

export default function useTaskStatuses(context: TaskHotsetContext & { machine: string | null; readingScope?: string }) {
  const { machine, readingScope } = context;
  const owner = useMemo(() => ({ hotset: createTaskHotset(), listCache: createListActivityCache(machine, readingScope) }), [machine, readingScope]);
  const latestOwner = useRef(owner); latestOwner.current = owner;
  const [observed, setObserved] = useState(() => ({ owner, view: initialTaskStatuses() }));
  // A scope switch must also be safe during render, before passive cleanup.
  const view = observed.owner === owner ? observed.view : initialTaskStatuses();
  const { hotset, listCache } = owner;
  const pollingRef = useRef<ReturnType<typeof startTaskStatusPolling> | null>(null);
  const refresh = useCallback(() => pollingRef.current?.refresh() ?? Promise.resolve(), []);
  const { threads, activity, selectedId, excludedThreadIds, draftIds } = context;
  listCache.update(threads, excludedThreadIds);
  useLayoutEffect(() => { hotset.update({ threads, activity, selectedId, excludedThreadIds, draftIds,
    runtimeStates: view.runtimeLoading || view.runtimeUnavailable ? null : view.runtimeStates }); },
    [hotset, threads, activity, selectedId, excludedThreadIds, draftIds, view.runtimeStates, view.runtimeLoading, view.runtimeUnavailable]);
  useEffect(() => {
    let active = true;
    const polling = startTaskStatusPolling({
      request: signal => api<TaskStatusResponse>(taskStatusRequestPath(hotset.priorityThreadIds()), "GET", undefined, { signal }),
      onObservation: response => { if (active && latestOwner.current === owner) { hotset.observe(response); listCache.observe(response); } },
      onChange: view => { if (active && latestOwner.current === owner) setObserved({ owner, view }); },
    });
    pollingRef.current = polling;
    return () => { active = false; if (pollingRef.current === polling) pollingRef.current = null; polling.stop(); };
  }, [owner, hotset, listCache]);
  const observeNativeHistory = useCallback<NativeListObservation>((id, history, requestedAt) => {
    if (latestOwner.current === owner && listCache.observeNativeHistory(id, history, requestedAt))
      setObserved(previous => previous.owner === owner ? { ...previous } : { owner, view: initialTaskStatuses() });
  }, [owner, listCache]);
  return { ...view, ...listCache.project(view), refresh, observeNativeHistory };
}

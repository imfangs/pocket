import { useEffect, useLayoutEffect, useState } from "react";
import { api } from "./api";
import { initialTaskStatuses, startTaskStatusPolling, type TaskStatusResponse } from "./taskStatuses";
import { createTaskHotset, taskStatusRequestPath, type TaskHotsetContext } from "./taskHotset";

export default function useTaskStatuses(context: TaskHotsetContext) {
  const [view, setView] = useState(initialTaskStatuses);
  const [hotset] = useState(createTaskHotset);
  const { threads, activity, selectedId, excludedThreadIds, draftIds } = context;
  useLayoutEffect(() => { hotset.update({ threads, activity, selectedId, excludedThreadIds, draftIds,
    runtimeStates: view.runtimeLoading || view.runtimeUnavailable ? null : view.runtimeStates }); },
    [hotset, threads, activity, selectedId, excludedThreadIds, draftIds, view.runtimeStates, view.runtimeLoading, view.runtimeUnavailable]);
  useEffect(() => {
    const polling = startTaskStatusPolling({
      request: signal => api<TaskStatusResponse>(taskStatusRequestPath(hotset.priorityThreadIds()), "GET", undefined, { signal }),
      onObservation: response => hotset.observe(response),
      onChange: setView,
    });
    return () => polling.stop();
  }, [hotset]);
  return view;
}

import { useEffect, useState } from "react";
import { api } from "./api";
import { initialTaskStatuses, startTaskStatusPolling, type TaskStatusResponse } from "./taskStatuses";

export default function useTaskStatuses() {
  const [view, setView] = useState(initialTaskStatuses);
  useEffect(() => {
    const polling = startTaskStatusPolling({
      request: signal => api<TaskStatusResponse>("/api/task-statuses", "GET", undefined, { signal }),
      onChange: setView,
    });
    return () => polling.stop();
  }, []);
  return view;
}

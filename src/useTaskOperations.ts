import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { activeOperation, creationRecoveryIds, failedOperation, mergeOperation, operationCheckError, pollOperation, readCreationRecoveryIds, saveCreationRecoveryIds, type TaskOperation } from "./taskOperations";
import { useReloadGuard } from "./updateSafety";
import { createTaskOperationPolling, pendingCreation } from "./taskOperationPolling";

export default function useTaskOperations(onComplete: (operation: TaskOperation) => void) {
  const [restoredCreates] = useState(readCreationRecoveryIds);
  const receipts = useRef(new Map<string, TaskOperation>(restoredCreates.map(requestId => [requestId, { requestId, operation: "create", status: "unknown" }]))), watched = useRef(new Set(restoredCreates));
  const commands = useRef(new Set<string>()), mounted = useRef(true), complete = useRef(onComplete);
  const [operations, setOperations] = useState<TaskOperation[]>(() => [...receipts.current.values()]), [dismissed, setDismissed] = useState(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const polling = useRef<ReturnType<typeof createTaskOperationPolling> | null>(null);
  useLayoutEffect(() => { complete.current = onComplete; }, [onComplete]);
  useReloadGuard(() => {
    const current = [...receipts.current.values()];
    if (current.some(operation => operation.operation === "create" && operation.status === "pending" && !Number.isFinite(operation.createdAt)))
      return "会话正在提交，请稍后更新。";
    return current.some(operation => operation.status === "unknown") ? "会话操作结果尚待核对，请先处理。" : null;
  });
  const receive = useCallback((incoming: TaskOperation) => {
    if (!mounted.current || !incoming?.requestId) return incoming;
    const old = receipts.current.get(incoming.requestId);
    const next = mergeOperation(old, incoming);
    if (next.operation !== "create" && activeOperation(next)) watched.current.add(next.requestId);
    receipts.current.set(next.requestId, next);
    polling.current?.observe(next);
    if (next.operation === "create" && watched.current.has(next.requestId))
      saveCreationRecoveryIds(creationRecoveryIds(receipts.current.values(), watched.current));
    setOperations([...receipts.current.values()].reverse());
    setErrors(previous => { const result = { ...previous }; delete result[next.requestId]; return result; });
    if (watched.current.has(next.requestId) && next.status === "succeeded" && old?.status !== "succeeded") complete.current(next);
    return next;
  }, []);
  const check = useCallback((requestId: string) => polling.current?.check(requestId) ?? Promise.resolve(undefined), []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const reader = createTaskOperationPolling({
      request: (requestId, signal) => api<TaskOperation>(`/api/task-operations/${requestId}`, "GET", undefined, { signal }),
      receive,
      isCreationWatched: requestId => watched.current.has(requestId),
      onError: (requestId, failure) => {
        if (mounted.current && polling.current === reader) setErrors(previous => ({ ...previous, [requestId]: operationCheckError(failure, receipts.current.get(requestId)?.operation) }));
      },
    });
    polling.current = reader;
    let timer: ReturnType<typeof setTimeout> | undefined, pending = false, listRequested = false, listFailures = 0;
    const ready = () => !controller.signal.aborted && document.visibilityState === "visible" && navigator.onLine !== false;
    const read = async (list = false) => {
      if (list) listRequested = true;
      if (!ready() || pending) return;
      clearTimeout(timer); pending = true;
      try {
        if (listRequested) {
          const result = await api<{ operations: TaskOperation[] }>("/api/task-operations", "GET", undefined,
            { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          if (ready()) {
            [...result.operations].reverse().forEach(receive);
            const listed = new Set(result.operations.map(operation => operation.requestId));
            listRequested = false; listFailures = 0;
            await Promise.all([...receipts.current.values()].filter(operation => operation.operation === "create" && watched.current.has(operation.requestId) &&
              operation.status !== "unknown" && !pendingCreation(operation) && !listed.has(operation.requestId))
              .map(operation => reader.check(operation.requestId)));
          }
        }
        if (ready()) await Promise.all([...receipts.current.values()].filter(operation => pollOperation(operation) && !pendingCreation(operation))
          .map(operation => reader.check(operation.requestId)));
      } catch {
        // Retry only the read-only list after weak-network failures. A single
        // unknown-operation GET can trigger recovery, so it stays explicit.
        if (listRequested) listFailures = Math.min(listFailures + 1, 5);
      }
      finally {
        pending = false;
        const delay = listRequested ? Math.min(15000, 1000 * 2 ** Math.max(0, listFailures - 1))
          : [...receipts.current.values()].some(operation => operation.status === "pending") ? 1500 : 4000;
        if (ready()) timer = setTimeout(() => void read(), delay);
      }
    };
    const resume = () => { clearTimeout(timer); reader.setActive(ready()); if (ready()) void read(true); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("pageshow", resume);
    reader.setActive(ready());
    receipts.current.forEach(operation => reader.observe(operation));
    void read(true);
    return () => {
      mounted.current = false; controller.abort(); clearTimeout(timer); reader.stop();
      if (polling.current === reader) polling.current = null;
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      window.removeEventListener("pageshow", resume);
    };
  }, [receive, check]);
  const start = async (operation: TaskOperation["operation"], input: Record<string, unknown>, threadId?: string, requestId = crypto.randomUUID()) => {
    const ongoing = [...receipts.current.values()].find(value => activeOperation(value) && (operation === "create" ? value.operation === "create" : value.threadId === threadId));
    if (ongoing) return ongoing;
    const initial: TaskOperation = { requestId, operation, status: "pending", ...(threadId ? { threadId } : {}) };
    watched.current.add(requestId); receive(initial);
    try {
      const result = await api<TaskOperation>(operation === "create" ? "/api/tasks" : `/api/tasks/${threadId}/archive`, "POST", { requestId, ...input }, { signal: AbortSignal.timeout(18000) });
      if (result.requestId !== requestId || result.operation !== operation) throw new Error("操作回执与本次请求不匹配。");
      return receive(result);
    } catch (error) {
      const failure = error as Error & { status?: number; code?: string };
      return receive(failedOperation(initial, failure));
    }
  };
  const cancel = async (requestId: string) => {
    if (commands.current.has(requestId)) return;
    commands.current.add(requestId);
    try {
      const result = await api<TaskOperation>(`/api/task-operations/${requestId}/cancel`, "POST");
      if (result.requestId !== requestId) throw new Error("操作回执编号不匹配。");
      receive(result);
    }
    catch (error) {
      const operation = receipts.current.get(requestId);
      // The original POST may never have reached the Mac. Explicitly stopping
      // recovery must also work when no server-side operation was reserved.
      // This does not delete or deny the existence of a possible conversation.
      if ((error as Error & { status?: number }).status === 404 && operation?.operation === "create" && operation.status === "unknown")
        receive({ ...operation, status: "cancelled" });
      else if (mounted.current) setErrors(previous => ({ ...previous, [requestId]: (error as Error).message }));
    }
    finally { commands.current.delete(requestId); }
  };
  const notices = operations.filter(operation => !dismissed.has(operation.requestId) && (activeOperation(operation) || watched.current.has(operation.requestId) &&
    (operation.status === "changed" || operation.status === "rejected" || operation.operation === "create" && operation.status === "succeeded")));
  const creations = operations.filter(operation => operation.operation === "create" && watched.current.has(operation.requestId));
  return { operations, creations, notices, errors, start, check, cancel, get: (id: string) => receipts.current.get(id), dismiss: (id: string) => {
    watched.current.delete(id);
    polling.current?.forget(id);
    saveCreationRecoveryIds(creationRecoveryIds(receipts.current.values(), watched.current));
    setDismissed(old => new Set(old).add(id));
  } };
}

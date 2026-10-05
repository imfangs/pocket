import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api";
import { activeOperation, creationRecoveryIds, mergeOperation, pollOperation, readCreationRecoveryIds, saveCreationRecoveryIds, type TaskOperation } from "./taskOperations";
import { useReloadGuard } from "./updateSafety";

export default function useTaskOperations(onComplete: (operation: TaskOperation) => void) {
  const [restoredCreates] = useState(readCreationRecoveryIds);
  const receipts = useRef(new Map<string, TaskOperation>(restoredCreates.map(requestId => [requestId, { requestId, operation: "create", status: "unknown" }]))), watched = useRef(new Set(restoredCreates));
  const commands = useRef(new Set<string>()), mounted = useRef(true), complete = useRef(onComplete);
  const [operations, setOperations] = useState<TaskOperation[]>(() => [...receipts.current.values()]), [dismissed, setDismissed] = useState(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  useLayoutEffect(() => { complete.current = onComplete; }, [onComplete]);
  useReloadGuard(() => operations.some(operation => operation.status === "unknown") ? "会话操作结果尚待核对，请先处理。" : null);
  const receive = useCallback((incoming: TaskOperation) => {
    if (!mounted.current || !incoming?.requestId) return incoming;
    const old = receipts.current.get(incoming.requestId);
    const next = mergeOperation(old, incoming);
    if (activeOperation(next)) watched.current.add(next.requestId);
    receipts.current.set(next.requestId, next);
    if (next.operation === "create" && watched.current.has(next.requestId))
      saveCreationRecoveryIds(creationRecoveryIds(receipts.current.values(), watched.current));
    setOperations([...receipts.current.values()].reverse());
    setErrors(previous => { const result = { ...previous }; delete result[next.requestId]; return result; });
    if (watched.current.has(next.requestId) && next.status === "succeeded" && old?.status !== "succeeded") complete.current(next);
    return next;
  }, []);
  const check = useCallback(async (requestId: string, signal?: AbortSignal) => {
    try {
      const result = await api<TaskOperation>(`/api/task-operations/${requestId}`, "GET", undefined,
        { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      if (result.requestId !== requestId) throw new Error("操作回执编号不匹配。");
      return receive(result);
    } catch {
      if (mounted.current && !signal?.aborted) setErrors(previous => ({ ...previous, [requestId]: "暂时无法核对操作状态，请稍后再试。" }));
    }
  }, [receive]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, pending = false;
    const ready = () => !controller.signal.aborted && document.visibilityState === "visible" && navigator.onLine !== false;
    const read = async (list = false) => {
      if (!ready() || pending) return;
      clearTimeout(timer); pending = true;
      try {
        if (list) {
          const result = await api<{ operations: TaskOperation[] }>("/api/task-operations", "GET", undefined,
            { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
          if (ready()) {
            [...result.operations].reverse().forEach(receive);
            const listed = new Set(result.operations.map(operation => operation.requestId));
            await Promise.all([...receipts.current.values()].filter(operation => operation.operation === "create" && watched.current.has(operation.requestId) && !listed.has(operation.requestId))
              .map(operation => check(operation.requestId, controller.signal)));
          }
        }
        if (ready()) await Promise.all([...receipts.current.values()].filter(pollOperation).map(operation => check(operation.requestId, controller.signal)));
      } catch { /* Keep known operations; an unavailable read never authorizes replay. */ }
      finally {
        pending = false;
        if (ready()) timer = setTimeout(() => void read(), [...receipts.current.values()].some(operation => operation.status === "pending") ? 1500 : 4000);
      }
    };
    const resume = () => { clearTimeout(timer); if (ready()) void read(true); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("pageshow", resume);
    void read(true);
    return () => {
      mounted.current = false; controller.abort(); clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
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
      return receive({ ...initial, status: failure.status && failure.status < 500 ? "rejected" : "unknown", code: failure.code, message: failure.status && failure.status < 500 ? failure.message : undefined });
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
    catch (error) { if (mounted.current) setErrors(previous => ({ ...previous, [requestId]: (error as Error).message })); }
    finally { commands.current.delete(requestId); }
  };
  const notices = operations.filter(operation => !dismissed.has(operation.requestId) && (activeOperation(operation) || watched.current.has(operation.requestId) &&
    (operation.status === "changed" || operation.status === "rejected" || operation.operation === "create" && operation.status === "succeeded")));
  return { operations, notices, errors, start, check, cancel, dismiss: (id: string) => {
    watched.current.delete(id);
    saveCreationRecoveryIds(creationRecoveryIds(receipts.current.values(), watched.current));
    setDismissed(old => new Set(old).add(id));
  } };
}

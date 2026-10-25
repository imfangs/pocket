import type { TaskOperation } from "./taskOperations";

type Timer = ReturnType<typeof setTimeout>;
type Options = {
  request: (requestId: string, signal: AbortSignal) => Promise<TaskOperation>;
  receive: (operation: TaskOperation) => TaskOperation;
  onError: (requestId: string, error: Error) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
};
type Creation = { startedAt: number; failures: number; running: boolean; resumeRequested?: boolean; timer?: Timer };

// A local optimistic pending operation has no createdAt. Only the Mac's
// durable receipt authorizes polling, avoiding a premature not-found error.
export const pendingCreation = (operation: TaskOperation) => operation.operation === "create" && operation.status === "pending";
const confirmedCreation = (operation: TaskOperation) => pendingCreation(operation) && Number.isFinite(operation.createdAt);

export function createTaskOperationPolling(options: Options) {
  const now = options.now ?? Date.now, setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout;
  const requests = new Map<string, { promise: Promise<TaskOperation | undefined>; controller: AbortController }>();
  const creations = new Map<string, Creation>();
  let active = false, stopped = false;
  const unschedule = (entry: Creation) => {
    if (entry.timer !== undefined) clearTimer(entry.timer);
    entry.timer = undefined;
  };
  const check = (requestId: string): Promise<TaskOperation | undefined> => {
    if (stopped) return Promise.resolve(undefined);
    const existing = requests.get(requestId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const promise = Promise.resolve().then(async () => {
      try {
        if (signal.aborted) return undefined;
        const incoming = await options.request(requestId, signal);
        if (stopped || signal.aborted) return undefined;
        if (incoming.requestId !== requestId) throw new Error("操作回执编号不匹配。");
        const operation = options.receive(incoming);
        observe(operation);
        return operation;
      } catch (failure) {
        if (!stopped && !controller.signal.aborted) options.onError(requestId, failure as Error);
        return undefined;
      }
    }).finally(() => {
      if (requests.get(requestId)?.promise === promise) requests.delete(requestId);
    });
    requests.set(requestId, { promise, controller });
    return promise;
  };
  const schedule = (requestId: string, entry: Creation, delay: number) => {
    if (stopped || !active || entry.running || entry.timer !== undefined) return;
    entry.timer = setTimer(() => {
      entry.timer = undefined;
      void poll(requestId, entry);
    }, delay);
  };
  const poll = async (requestId: string, entry: Creation) => {
    if (stopped || !active || creations.get(requestId) !== entry || entry.running) return;
    entry.running = true;
    const result = await check(requestId);
    entry.running = false;
    if (stopped || !active || creations.get(requestId) !== entry) return;
    if (entry.resumeRequested) {
      entry.resumeRequested = false;
      schedule(requestId, entry, 0);
      return;
    }
    entry.failures = result ? 0 : entry.failures + 1;
    const elapsed = now() - entry.startedAt;
    const interval = elapsed < 10000 ? 500 : elapsed < 30000 ? 1500 : 4000;
    schedule(requestId, entry, Math.max(interval, entry.failures ? Math.min(8000, 500 * 2 ** entry.failures) : 0));
  };
  const observe = (operation: TaskOperation) => {
    if (stopped) return;
    const existing = creations.get(operation.requestId);
    if (!confirmedCreation(operation)) {
      if (existing) unschedule(existing);
      creations.delete(operation.requestId);
      return;
    }
    if (existing) return;
    const entry: Creation = { startedAt: now(), failures: 0, running: false };
    creations.set(operation.requestId, entry);
    schedule(operation.requestId, entry, 0);
  };
  return {
    check,
    observe,
    setActive(value: boolean) {
      if (stopped) return;
      active = value;
      if (!active) {
        for (const entry of creations.values()) unschedule(entry);
        for (const entry of requests.values()) entry.controller.abort();
      } else {
        for (const [requestId, entry] of creations) {
          unschedule(entry); entry.failures = 0;
          if (entry.running) entry.resumeRequested = true;
          else schedule(requestId, entry, 0);
        }
      }
    },
    stop() {
      stopped = true;
      for (const entry of creations.values()) unschedule(entry);
      creations.clear();
      for (const entry of requests.values()) entry.controller.abort();
    },
  };
}

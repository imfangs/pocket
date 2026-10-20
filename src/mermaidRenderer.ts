import { sourceWithinLimits, validDiagramResult, type DiagramResult } from "./mermaidPolicy";

type Listener = { done: (result: DiagramResult) => void; cancel: () => void };
type Job = { id: number; key: string; source: string; width: number; listeners: Set<Listener> };
type WorkerLike = Pick<Worker, "postMessage" | "terminate" | "onmessage" | "onerror">;

export function createDiagramRenderer(factory: () => WorkerLike, limits = { loadingMs: 15_000, renderingMs: 1500, idleMs: 60_000 }) {
  let worker: WorkerLike | null = null, active: Job | undefined, sequence = 0, bytes = 0;
  let deadline: ReturnType<typeof setTimeout> | undefined, idle: ReturnType<typeof setTimeout> | undefined;
  const jobs = new Map<string, Job>(), cache = new Map<string, DiagramResult>();
  const stopWorker = () => { clearTimeout(deadline); worker?.terminate(); worker = null; };
  const weight = (key: string, result: DiagramResult) => 2 * (key.length + (result.ok ? result.svg.length : 32));
  const remember = (key: string, result: DiagramResult) => {
    if (cache.has(key)) bytes -= weight(key, cache.get(key)!);
    cache.delete(key); cache.set(key, result); bytes += weight(key, result);
    while (cache.size > 24 || bytes > 2_000_000) {
      const oldest = cache.keys().next().value!;
      bytes -= weight(oldest, cache.get(oldest)!); cache.delete(oldest);
    }
  };
  const finish = (result: DiagramResult) => {
    if (!active) return;
    clearTimeout(deadline);
    const job = active; active = undefined; jobs.delete(job.key);
    if (result.ok || result.reason !== "unavailable") remember(job.key, result);
    for (const listener of job.listeners) { listener.cancel(); listener.done(result); }
    pump();
  };
  const timeout = (duration: number) => {
    clearTimeout(deadline);
    deadline = setTimeout(() => { stopWorker(); finish({ ok: false, reason: "timeout" }); }, duration);
  };
  const pump = () => {
    if (active) return;
    clearTimeout(idle);
    active = jobs.values().next().value;
    if (!active) { idle = setTimeout(() => { stopWorker(); cache.clear(); bytes = 0; }, limits.idleMs); return; }
    try {
      if (!worker) {
        worker = factory();
        const owner = worker;
        worker.onmessage = event => {
          if (worker !== owner || !active || event.data?.id !== active.id) return;
          if (event.data.phase === "rendering") { timeout(limits.renderingMs); return; }
          const result = event.data.result;
          // A failed diagram import stays rejected in this worker's module map.
          // Release that realm so the next render can fetch it again.
          if (result?.ok === false && result.reason === "unavailable") stopWorker();
          finish(validDiagramResult(result) ? result : result?.ok === false && ["unsupported", "limit", "invalid", "unavailable", "timeout"].includes(result.reason)
            ? result : { ok: false, reason: "invalid" });
        };
        worker.onerror = event => { event.preventDefault(); if (worker !== owner) return; stopWorker(); finish({ ok: false, reason: "unavailable" }); };
      }
      timeout(limits.loadingMs);
      worker.postMessage({ id: active.id, source: active.source, width: active.width });
    } catch { stopWorker(); finish({ ok: false, reason: "unavailable" }); }
  };
  const render = (source: string, width: number, signal: AbortSignal, retry = false): Promise<DiagramResult> => {
    if (signal.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
    if (!sourceWithinLimits(source)) return Promise.resolve({ ok: false, reason: "limit" });
    width = Math.max(280, Math.min(720, Math.round(width / 40) * 40));
    const key = width + "\n" + source;
    const saved = cache.get(key);
    if (saved && !retry) { remember(key, saved); return Promise.resolve(saved); }
    let job = jobs.get(key);
    if (!job) {
      if (jobs.size >= 12) return Promise.resolve({ ok: false, reason: "unavailable" });
      job = { id: ++sequence, key, source, width, listeners: new Set() }; jobs.set(key, job);
    }
    const target = job;
    return new Promise((resolve, reject) => {
      const abort = () => {
        target.listeners.delete(listener);
        if (!target.listeners.size && jobs.has(target.key)) {
          jobs.delete(target.key);
          if (active === target) { stopWorker(); active = undefined; }
          pump();
        }
        reject(new DOMException("Cancelled", "AbortError"));
      };
      const listener = { done: resolve, cancel: () => signal.removeEventListener("abort", abort) };
      target.listeners.add(listener); signal.addEventListener("abort", abort, { once: true }); pump();
    });
  };
  const clear = () => {
    stopWorker(); clearTimeout(idle); active = undefined; cache.clear(); bytes = 0;
    const pending = [...jobs.values()]; jobs.clear();
    for (const job of pending) for (const listener of job.listeners) { listener.cancel(); listener.done({ ok: false, reason: "unavailable" }); }
  };
  return { render, clear };
}

const renderer = createDiagramRenderer(() => new Worker(new URL("./mermaid.worker.ts", import.meta.url), { type: "module" }));
if (typeof window !== "undefined") {
  window.addEventListener("pocket-diagram-scope-change", renderer.clear);
  window.addEventListener("pagehide", renderer.clear);
}
export const renderDiagram = renderer.render;

import { Worker } from 'node:worker_threads';
import { AppError } from './store.mjs';
import { POCKET_CONTENT, contentEvidence } from './pocket-content.mjs';

const cancelled = () => Object.assign(new AppError('会话历史读取已取消', 499), { name: 'AbortError', code: 'HISTORY_SOURCE_ABORTED' });

// Pagination is an independent, read-only projection. In particular it never
// enters DesktopService, updates a read watermark, or reconciles a send receipt.
export class HistoryPageReader {
  constructor({ timeoutMs = 30000, maxPending = 8, limits, createWorker = (url, options) => new Worker(url, options) } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.limits = limits;
    this.pending = new Map();
    this.flights = new Map();
    this.sequence = 0;
    this.worker = null;
    this.closed = false;
    this.createWorker = createWorker;
  }

  read(codexHome, threadId, { before = null, limit = 80, signal } = {}) {
    if (this.closed) return Promise.reject(new AppError('历史分页读取已关闭', 503));
    if (before != null && (typeof before !== 'string' || !before.length || before.length > 2048))
      return Promise.reject(new AppError('历史分页位置无效', 400));
    if (!Number.isInteger(limit) || limit < 1 || limit > 80)
      return Promise.reject(new AppError('历史分页条数必须在 1 到 80 之间', 400));
    return this.request('page', codexHome, threadId, { before, limit }, signal);
  }

  recent(codexHome, threadId, { signal } = {}) {
    return this.request('recent', codexHome, threadId, {}, signal);
  }

  request(kind, codexHome, threadId, options = {}, signal) {
    if (this.closed) return Promise.reject(new AppError('历史分页读取已关闭', 503));
    if (signal?.aborted) return Promise.reject(cancelled());
    const key = JSON.stringify([kind, codexHome, threadId, options]);
    const existing = this.flights.get(key);
    if (existing) return this.consume(existing, signal);
    if (this.pending.size >= this.maxPending)
      return Promise.reject(new AppError('历史读取繁忙，请稍后重试', 503));
    this.start();
    const id = ++this.sequence;
    // Reserve observation order before asynchronous work starts. A slow old
    // source must not outrank a newer synchronous read merely by finishing last.
    const observation = kind === 'recent' ? contentEvidence({}, null, null) : null;
    const job = { id, key, kind, observation, consumers: new Set(), unabortable: false };
    job.promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new AppError('历史读取超时，请重试', 503)), this.timeoutMs);
      Object.assign(job, { resolve, reject, timer });
    });
    // Every subscriber has its own cancellation. A dropped last subscriber
    // withdraws only this read, leaving unrelated reads and signed cursors alive.
    void job.promise.catch(() => {});
    this.pending.set(id, job); this.flights.set(key, job);
    const result = this.consume(job, signal);
    if (this.pending.get(id) !== job) return result;
    this.worker.ref();
    try { this.worker.postMessage({ id, kind, codexHome, threadId, ...options }); }
    catch (error) { this.settle(job, undefined, error); }
    return result;
  }

  consume(job, signal) {
    if (!signal) { job.unabortable = true; return job.promise; }
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (value, error) => {
        if (done) return;
        done = true; signal.removeEventListener('abort', abort); job.consumers.delete(abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => {
        finish(undefined, cancelled());
        if (!job.unabortable && !job.consumers.size && this.pending.get(job.id) === job) {
          this.settle(job, undefined, cancelled());
          this.worker?.postMessage({ kind: 'cancel', id: job.id });
        }
      };
      job.consumers.add(abort); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else job.promise.then(value => finish(value), error => finish(undefined, error));
    });
  }

  settle(job, data, error) {
    if (this.pending.get(job.id) !== job) return;
    clearTimeout(job.timer); this.pending.delete(job.id);
    if (this.flights.get(job.key) === job) this.flights.delete(job.key);
    if (error) job.reject(error); else job.resolve(data);
    if (!this.pending.size) this.worker?.unref();
  }

  start() {
    if (this.worker) return;
    const worker = this.createWorker(new URL('./history-page-worker.mjs', import.meta.url), {
      workerData: { limits: this.limits },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16 },
    });
    this.worker = worker;
    worker.on('message', ({ id, data, error, evidence }) => {
      if (this.worker !== worker) return;
      const job = this.pending.get(id);
      if (!job) return;
      if (!error) {
        // Worker transports cannot carry Symbol keys. Rebuild fresh evidence
        // here, keeping the file path outside all JSON responses and caches.
        if (job.kind === 'recent' && evidence)
          data[POCKET_CONTENT] = { ...evidence.candidate,
            source: { ...job.observation.source, file: evidence.file, version: evidence.version } };
      }
      this.settle(job, data, error ? new AppError(error.message, error.status) : undefined);
    });
    worker.on('error', () => {
      if (this.worker === worker) this.fail(new AppError('历史读取暂时不可用，请重试', 503));
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.fail(new AppError('历史读取已重置，请重新载入', 503));
    });
    worker.unref();
  }

  fail(error) {
    const worker = this.worker;
    this.worker = null;
    for (const job of this.pending.values()) this.settle(job, undefined, error);
    void worker?.terminate();
  }

  close() {
    this.closed = true;
    this.fail(new AppError('历史分页读取已关闭', 503));
  }
}

let defaultReader;
export function readPersistedHistoryPage(codexHome, threadId, options) {
  defaultReader ||= new HistoryPageReader();
  return defaultReader.read(codexHome, threadId, options);
}

export function readPersistedHistoryRecent(codexHome, threadId, options) {
  defaultReader ||= new HistoryPageReader();
  return defaultReader.recent(codexHome, threadId, options);
}

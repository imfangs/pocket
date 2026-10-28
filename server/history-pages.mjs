import { Worker } from 'node:worker_threads';
import { AppError } from './store.mjs';
import { POCKET_CONTENT, contentEvidence } from './pocket-content.mjs';

// Pagination is an independent, read-only projection. In particular it never
// enters DesktopService, updates a read watermark, or reconciles a send receipt.
export class HistoryPageReader {
  constructor({ timeoutMs = 30000, maxPending = 8, limits } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.limits = limits;
    this.pending = new Map();
    this.flights = new Map();
    this.sequence = 0;
    this.worker = null;
    this.closed = false;
  }

  read(codexHome, threadId, { before = null, limit = 80 } = {}) {
    if (this.closed) return Promise.reject(new AppError('历史分页读取已关闭', 503));
    if (before != null && (typeof before !== 'string' || !before.length || before.length > 2048))
      return Promise.reject(new AppError('历史分页位置无效', 400));
    if (!Number.isInteger(limit) || limit < 1 || limit > 80)
      return Promise.reject(new AppError('历史分页条数必须在 1 到 80 之间', 400));
    return this.request('page', codexHome, threadId, { before, limit });
  }

  recent(codexHome, threadId) {
    return this.request('recent', codexHome, threadId);
  }

  request(kind, codexHome, threadId, options = {}) {
    if (this.closed) return Promise.reject(new AppError('历史分页读取已关闭', 503));
    const key = JSON.stringify([kind, codexHome, threadId, options]);
    if (this.flights.has(key)) return this.flights.get(key);
    if (this.pending.size >= this.maxPending)
      return Promise.reject(new AppError('历史读取繁忙，请稍后重试', 503));
    this.start();
    const id = ++this.sequence;
    // Reserve observation order before asynchronous work starts. A slow old
    // source must not outrank a newer synchronous read merely by finishing last.
    const observation = kind === 'recent' ? contentEvidence({}, null, null) : null;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new AppError('历史读取超时，请重试', 503)), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, kind, observation });
      this.worker.ref();
      this.worker.postMessage({ id, kind, codexHome, threadId, ...options });
    });
    const flight = promise.finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return flight;
  }

  start() {
    if (this.worker) return;
    const worker = new Worker(new URL('./history-page-worker.mjs', import.meta.url), {
      workerData: { limits: this.limits },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16 },
    });
    this.worker = worker;
    worker.on('message', ({ id, data, error, evidence }) => {
      const job = this.pending.get(id);
      if (!job) return;
      clearTimeout(job.timer);
      this.pending.delete(id);
      if (error) job.reject(new AppError(error.message, error.status));
      else {
        // Worker transports cannot carry Symbol keys. Rebuild fresh evidence
        // here, keeping the file path outside all JSON responses and caches.
        if (job.kind === 'recent' && evidence)
          data[POCKET_CONTENT] = { ...evidence.candidate,
            source: { ...job.observation.source, file: evidence.file, version: evidence.version } };
        job.resolve(data);
      }
      if (!this.pending.size) worker.unref();
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
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    this.pending.clear();
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

export function readPersistedHistoryRecent(codexHome, threadId) {
  defaultReader ||= new HistoryPageReader();
  return defaultReader.recent(codexHome, threadId);
}

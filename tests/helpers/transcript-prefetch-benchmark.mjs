import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createTranscriptReader } from '../../src/transcriptReader.ts';

export const id = n => `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`;
export const candidate = (n, revision = 1, refresh) => ({ id: id(n), content: {
  known: true, scope: 'scope', revision, version: String(revision % 10).repeat(64), messageId: `synthetic-${n}-${revision}`,
}, ...(refresh ? { refresh } : {}) });
export const response = item => ({ source: 'rollout', checkedAt: 1000000,
  messages: [{ id: item.content.messageId, role: 'assistant', text: 'Synthetic body' }], pocketContent: { ...item.content } });
export const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); await setImmediate(); };

// A virtual clock runs the real reader; only network delay and cache storage are
// synthetic. This records request starts/completions, rather than inferring speed
// from the configured number of lanes.
export function controlledFixture({ createReader = createTranscriptReader, latency = () => 1000, load = () => null,
  timeoutMs = 12000, gapMs = 750 } = {}) {
  let now = 1000000, sequence = 0, enabled = true, identity = true, selected = null;
  let active = 0, peak = 0;
  const timers = new Map(), requests = [], writes = [], loads = [];
  const later = (callback, delay) => { const key = ++sequence; timers.set(key, { callback, at: now + delay }); return key; };
  const clear = key => timers.delete(key);
  const reader = createReader({ machine: 'ged', scope: 'scope', now: () => now, current: () => identity,
    canPrefetch: () => enabled, getForegroundId: () => selected, timeoutMs, gapMs, setTimeout: later, clearTimeout: clear,
    cache: { loadTranscript: async (_machine, _scope, threadId) => { loads.push(threadId); return load(threadId); },
      rememberTranscript: (_machine, _scope, threadId, data) => { writes.push({ threadId, data, at: now }); return true; } },
    request: (threadId, signal) => new Promise((resolve, reject) => {
      const entry = { threadId, signal, at: now, completedAt: null, aborted: false }; requests.push(entry);
      active++; peak = Math.max(peak, active); let settled = false;
      const finish = (data, error) => {
        if (settled) return; settled = true; active--; clear(timer); signal.removeEventListener('abort', abort);
        if (error) reject(error); else { entry.completedAt = now; resolve(data); }
      };
      const abort = () => { entry.aborted = true; finish(null, new DOMException('cancelled', 'AbortError')); };
      const timer = later(() => finish(response(candidate(Number(threadId.slice(-12))))), latency(threadId));
      entry.resolve = data => finish(data); entry.reject = error => finish(null, error);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    }),
  });
  const advance = async ms => {
    const end = now + ms; await flush(); let steps = 0;
    for (;;) {
      const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++steps < 10000, 'virtual timers remain bounded'); timers.delete(next[0]); now = next[1].at; next[1].callback(); await flush();
    }
    now = end; await flush();
  };
  return { reader, requests, writes, loads, timers, advance, now: () => now, active: () => active, peak: () => peak,
    enabled: value => { enabled = value; }, identity: value => { identity = value; }, selected: value => { selected = value; },
    update: (items, state = {}) => reader.update(items, { enabled: true, foregroundId: selected, ...state }) };
}

export async function controlledBenchmark(createReader) {
  const items = Array.from({ length: 16 }, (_, n) => candidate(n + 1));
  const f = controlledFixture({ createReader, latency: threadId => Number(threadId.slice(-12)) % 4 === 1 ? 3000 : 500 });
  f.update(items); await f.advance(30000);
  const last = Math.max(...f.writes.map(item => item.at));
  const result = { synthetic: true, candidatesOffered: 16, candidatesRead: f.writes.length,
    backgroundPeak: f.peak(), warmWorkingSetMs: last - 1000000, requests: f.requests.map(item => ({
      thread: Number(item.threadId.slice(-12)), startMs: item.at - 1000000, completionMs: item.completedAt - 1000000,
    })) };
  f.reader.stop(); return result;
}

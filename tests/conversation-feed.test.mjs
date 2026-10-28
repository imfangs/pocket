import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { rememberHistory, rememberTranscript, startConversationFeed, startTranscriptFeed } from "../src/conversationFeed.ts";

const history = (runtime = "active") => ({ runtime, source: "desktop", messages: [], canSend: runtime === "idle", hint: "", checkedAt: 0 });
function fixture(request, createFeed = startConversationFeed) {
  const browser = new EventTarget(), visibility = new EventTarget();
  const tasks = new Map();
  let now = 0, nextId = 0;
  Object.assign(browser, {
    navigator: { onLine: true },
    setTimeout: (fn, delay) => { tasks.set(++nextId, { fn, at: now + delay }); return nextId; },
    clearTimeout: id => tasks.delete(id),
  });
  visibility.visibilityState = "visible";
  const data = [], errors = [];
  const feed = createFeed({ browser, visibility, request, onData: value => data.push(value), onError: error => errors.push(error) });
  async function advance(ms) {
    const until = now + ms;
    await setImmediate();
    while (true) {
      const next = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; tasks.delete(next[0]); next[1].fn();
      await setImmediate();
    }
    now = until;
  }
  return { browser, visibility, tasks, feed, data, errors, advance };
}

test("active conversation refreshes promptly, pauses in background, and resumes on return", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return history(); });
  await f.advance(0);
  assert.equal(calls, 1);
  await f.advance(1999); assert.equal(calls, 1);
  await f.advance(1); assert.equal(calls, 2);
  f.visibility.visibilityState = "hidden";
  f.visibility.dispatchEvent(new Event("visibilitychange"));
  await f.advance(30000); assert.equal(calls, 2);
  f.visibility.visibilityState = "visible";
  f.visibility.dispatchEvent(new Event("visibilitychange"));
  await f.advance(0); assert.equal(calls, 3);
  f.feed.stop(); await f.advance(30000); assert.equal(calls, 3);
  assert.equal(f.tasks.size, 0);
});

test("desktop fallback retries promptly then backs off, without pretending cached history is live", async () => {
  let calls=0;
  const f=fixture(async()=>{calls++;return {...history('unavailable'),source:'rollout',canSend:false};});
  await f.advance(0); assert.equal(calls,1);
  await f.advance(2000); assert.equal(calls,2);
  await f.advance(2000); assert.equal(calls,3);
  await f.advance(2000); assert.equal(calls,4);
  await f.advance(7999); assert.equal(calls,4);
  await f.advance(1); assert.equal(calls,5);
  assert.ok(f.data.every(h=>h.source==='rollout'&&!h.canSend));
  f.feed.stop();
});

test("idle conversations poll less often and reconnect immediately after offline", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return history("idle"); });
  await f.advance(7999); assert.equal(calls, 1);
  await f.advance(1); assert.equal(calls, 2);
  f.browser.navigator.onLine = false;
  f.browser.dispatchEvent(new Event("offline"));
  await f.advance(30000); assert.equal(calls, 2);
  assert.match(f.errors[0].message, /离线/);
  f.browser.navigator.onLine = true;
  f.browser.dispatchEvent(new Event("online"));
  await f.advance(0); assert.equal(calls, 3);
  f.feed.stop();
});

test("a stalled read times out and retries without wedging refresh forever", async () => {
  let calls = 0, signal;
  const f = fixture(s => {
    signal = s;
    if (++calls > 1) return Promise.resolve(history());
    return new Promise((resolve, reject) => s.addEventListener("abort", () => reject(s.reason), { once: true }));
  });
  await f.advance(18000);
  assert.equal(signal.aborted, true);
  assert.match(f.errors[0].message, /较慢/);
  await f.advance(2000);
  assert.equal(calls, 2);
  assert.equal(f.data.length, 1);
  f.feed.stop();
});

test("repeated refreshes coalesce; leaving cancels reads and late results", async () => {
  let finish, calls = 0, firstSignal;
  const f = fixture(signal => {
    calls++;
    if (calls === 1) { firstSignal = signal; return new Promise(resolve => { finish = resolve; }); }
    return Promise.resolve(history());
  });
  void f.feed.refresh(); void f.feed.refresh();
  assert.equal(calls, 1);
  finish(history()); await f.advance(0);
  assert.equal(calls, 2);
  f.feed.stop();
  const abandoned = fixture(signal => { firstSignal = signal; return new Promise(resolve => { finish = resolve; }); });
  abandoned.feed.stop();
  assert.equal(firstSignal.aborted, true);
  finish(history()); await abandoned.advance(0);
  assert.equal(abandoned.data.length, 0);
  assert.equal(abandoned.tasks.size, 0);
});

test("history and transcript cache preserve reading position and progress display choices within the same eviction boundary", () => {
  const cache = new Map();
  for (let i = 0; i < 22; i++) rememberHistory(cache, String(i), history());
  assert.equal(cache.size, 20);
  assert.equal(cache.has("0"), false);
  cache.get("5").scrollTop = 420;
  cache.get("5").nearBottom = false;
  const progressView = { expanded: ["expanded-group"], deferred: ["reading-group"], seen: ["older-group", "reading-group"] };
  cache.get("5").progressView = progressView;
  const expandedQueries = ["expanded-query"];
  cache.get("5").expandedQueries = expandedQueries;
  rememberHistory(cache, "5", history("idle"));
  assert.equal(cache.get("5").scrollTop, 420);
  assert.equal(cache.get("5").nearBottom, false);
  assert.equal(cache.get("5").history.runtime, "idle");
  assert.equal(cache.get("5").progressView, progressView);
  assert.equal(cache.get("5").expandedQueries, expandedQueries);
  const transcript = { source: "rollout", messages: [], checkedAt: 10 };
  rememberTranscript(cache, "5", transcript);
  assert.equal(cache.get("5").expandedQueries, expandedQueries);
  assert.equal(cache.get("5").progressView, progressView);
  assert.equal(cache.get("5").history.runtime, "idle");
  assert.equal(cache.get("5").transcript, transcript);
  assert.equal(cache.get("5").scrollTop, 420);
  assert.equal(cache.get("5").nearBottom, false);
  for (let i = 22; i < 42; i++) {
    if (i % 2) rememberHistory(cache, String(i), history());
    else rememberTranscript(cache, String(i), transcript);
  }
  assert.equal(cache.size, 20);
  assert.equal(cache.has("5"), false);
  rememberHistory(cache, "5", history());
  assert.equal(cache.get("5").progressView, undefined, "evicted presentation state does not outlive its history entry");
  assert.equal(cache.get("5").expandedQueries, undefined);
  assert.equal(cache.get("5").scrollTop, 0);
  assert.equal(cache.get("5").nearBottom, true);
  cache.clear(); assert.equal(cache.size, 0);
});

test("transcript reads use recorded activity only for pacing and stop while hidden", async () => {
  let calls=0, status='inProgress';
  const f=fixture(async()=>{calls++;return{source:'rollout',messages:[],turnTiming:{status},checkedAt:0};},startTranscriptFeed);
  await f.advance(2000);assert.equal(calls,2);
  f.visibility.visibilityState='hidden';f.visibility.dispatchEvent(new Event('visibilitychange'));
  await f.advance(30000);assert.equal(calls,2);
  status='completed';f.visibility.visibilityState='visible';f.visibility.dispatchEvent(new Event('visibilitychange'));
  await f.advance(7999);assert.equal(calls,3);await f.advance(1);assert.equal(calls,4);
  assert.ok(f.data.every(d=>d.canSend===undefined));f.feed.stop();assert.equal(f.tasks.size,0);
});

test('history cache evicts older large bodies before its byte budget is exceeded', () => {
  const cache = new Map();
  for (let i = 0; i < 5; i++) rememberHistory(cache, String(i), { ...history(), messages: [{ id: String(i), role: 'assistant', text: 'x'.repeat(1024 * 1024) }] });
  assert.ok(cache.size < 5);
  assert.equal(cache.has('0'), false);
  assert.equal(cache.has('4'), true);
  assert.ok([...cache.values()].reduce((bytes, entry) => bytes + entry.payloadBytes, 0) <= 8 * 1024 * 1024);
});

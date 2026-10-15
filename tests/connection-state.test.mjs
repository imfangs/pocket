import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { connectionFailureHint, connectionFromHistory, isConnectionCompatibilityFailure, newerConnection } from '../src/threadConnection.ts';
import { startConnectionFeed } from '../src/conversationFeed.ts';

const connection = (status, overrides = {}) => ({ status, requestId: 'one', startedAt: 10, checkedAt: 20, ...overrides });
function fixture(request) {
  const browser = new EventTarget(), visibility = new EventTarget();
  const timers = new Map();
  let nextId = 0, now = 0;
  Object.assign(browser, { navigator: { onLine: true }, setTimeout: (fn, delay) => { timers.set(++nextId, { fn, at: now + delay }); return nextId; }, clearTimeout: id => timers.delete(id) });
  visibility.visibilityState = 'visible';
  const data = [], errors = [];
  const feed = startConnectionFeed({ browser, visibility, request, onData: value => data.push(value), onError: error => errors.push(error) });
  async function advance(ms) {
    const until = now + ms;
    await setImmediate();
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
      await setImmediate();
    }
    now = until;
  }
  return { browser, visibility, data, errors, timers, feed, advance };
}

test('a late connecting history cannot overwrite a terminal or newer connection attempt', () => {
  const verified = connection('connected');
  assert.equal(newerConnection(verified, connection('connecting')), verified);
  const failed = connection('failed', { checkedAt: 40 });
  assert.equal(newerConnection(failed, connection('connecting', { checkedAt: 41 })), failed);
  const newer = connection('connecting', { requestId: 'two', startedAt: 50, checkedAt: 50 });
  assert.equal(newerConnection(newer, failed), newer);
  assert.equal(newerConnection(verified, { status: 'idle' }), verified);
  assert.equal(newerConnection(failed, newer), newer);
});

test('only a sufficiently fresh resumed desktop can override a previous failure', () => {
  for (const code of ['connection_timeout', 'desktop_protocol_incompatible', 'unsupported_app_identity', 'app_version_changed']) {
    const failed = connection('failed', { code });
    assert.equal(connectionFromHistory(failed, { source: 'desktop', resumeState: 'resuming', checkedAt: 30 }), failed);
    assert.equal(connectionFromHistory(failed, { source: 'rollout', resumeState: 'resumed', checkedAt: 30 }), failed);
    assert.equal(connectionFromHistory(failed, { source: 'desktop', resumeState: 'resumed', checkedAt: 15 }), failed);
    const recovered = connectionFromHistory(failed, { source: 'desktop', resumeState: 'resumed', checkedAt: 30 });
    assert.equal(recovered.status, 'connected');
    assert.equal(recovered.checkedAt, 30);
    assert.equal(recovered.code, undefined);
  }
});

test('interface and identity errors are distinguished from retryable owner timeouts and old version receipts remain readable', () => {
  for (const code of ['desktop_protocol_incompatible', 'desktop_protocol_error', 'unsupported_app_identity', 'app_version_changed']) {
    assert.equal(isConnectionCompatibilityFailure(code), true);
    assert.ok(connectionFailureHint(code).length < 20);
    assert.doesNotMatch(connectionFailureHint(code), /原任务|版本已变化|请重试连接/);
  }
  assert.match(connectionFailureHint('desktop_protocol_incompatible'), /Codex 接口暂不兼容/);
  assert.match(connectionFailureHint('unsupported_app_identity'), /暂不支持此桌面应用/);
  assert.equal(isConnectionCompatibilityFailure('owner_lookup_timeout'), false);
  assert.match(connectionFailureHint('owner_lookup_timeout'), /连接超时/);
});

test('connection observation polls until verified or failed and stops without reopening', async () => {
  for (const terminal of ['connected', 'failed']) {
    let reads = 0;
    const f = fixture(async () => connection(++reads === 3 ? terminal : 'connecting'));
    await f.advance(2000);
    assert.equal(reads, 3);
    assert.equal(f.data.at(-1).status, terminal);
    await f.advance(30000);
    assert.equal(reads, 3);
    assert.equal(f.timers.size, 0);
    f.feed.stop();
  }
});

test('leaving a conversation ignores even a terminal connection result received later', async () => {
  let finish, signal;
  const f = fixture(value => { signal = value; return new Promise(resolve => { finish = resolve; }); });
  f.feed.stop();
  assert.equal(signal.aborted, true);
  finish(connection('connected'));
  await f.advance(30000);
  assert.equal(f.data.length, 0);
  assert.equal(f.timers.size, 0);
});

test('offline observation pauses and resumes with a status read, preserving the same request', async () => {
  let reads = 0;
  const f = fixture(async () => { reads++; return connection('connecting'); });
  await f.advance(0);
  f.browser.navigator.onLine = false; f.browser.dispatchEvent(new Event('offline'));
  await f.advance(30000);
  assert.equal(reads, 1);
  f.browser.navigator.onLine = true; f.browser.dispatchEvent(new Event('online'));
  await f.advance(0);
  assert.equal(reads, 2);
  assert.ok(f.data.every(value => value.requestId === 'one'));
  f.feed.stop();
});

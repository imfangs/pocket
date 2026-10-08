import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { displayedReadObservation, observeVisibleRead } from '../src/readObservation.ts';

const message = { id: 'last', role: 'assistant', text: 'Latest complete visible reply', phase: 'final', turnId: 'turn-one' };
const observation = { token: 'signed-observation', lastVisibleItemId: 'last', visibleVersion: 'visible-one' };
const transcript = { source: 'rollout', messages: [message], checkedAt: 100, readObservation: observation };

test('only a freshly fetched transcript whose last message is actually displayed grants a read observation', () => {
  assert.equal(displayedReadObservation(null, [message]), null, 'cached messages alone must not mark read');
  assert.equal(displayedReadObservation(transcript, [message]), observation);
  for (const changed of [{ id: 'different' }, { text: message.text + ' New text' }, { role: 'user' }, { phase: 'commentary' }, { turnId: 'new-turn' }]) {
    assert.equal(displayedReadObservation(transcript, [{ ...message, ...changed }]), null);
  }
  assert.equal(displayedReadObservation(transcript, [message, { ...message, id: 'new-message' }]), null);
  assert.equal(displayedReadObservation({ ...transcript, readObservation: null }, [message]), null);
  assert.equal(displayedReadObservation({ ...transcript, readObservation: { ...observation, lastVisibleItemId: 'old' } }, [message]), null);
});

function fixture({ receipt = 'read', attempted = new Map(), delayResponse = false, observed = observation, getObservation } = {}) {
  const browser = new EventTarget(), visibility = new EventTarget();
  const frames = new Map();
  let frameId = 0, notifyIntersection, finish;
  Object.assign(browser, { navigator: { onLine: true }, requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id) });
  visibility.visibilityState = 'visible';
  visibility.querySelector = () => null;
  const root = { getBoundingClientRect: () => ({ width: 390, height: 500, top: 0, bottom: 500 }) };
  const target = { getBoundingClientRect: () => ({ width: 1, height: 1, top: 499, bottom: 500 }) };
  class Observer {
    constructor(callback) { notifyIntersection = callback; }
    observe() {}
    disconnect() { notifyIntersection = null; }
  }
  const posts = [], results = [], readNotifications = [];
  const stop = observeVisibleRead({ browser, visibility, root, target, observation: observed, getObservation, attempted, Observer,
    submit: (input, signal) => {
      posts.push({ input, signal });
      if (delayResponse) return new Promise(resolve => { finish = resolve; });
      return Promise.resolve({ requestId: input.requestId, status: receipt });
    }, onRead: () => readNotifications.push('refresh'), onResult: result => results.push(result) });
  const intersect = value => notifyIntersection?.([{ target, isIntersecting: value, intersectionRatio: value ? 1 : 0 }]);
  async function paint() {
    const queue = [...frames]; frames.clear();
    for (const [, callback] of queue) callback();
    await setImmediate();
  }
  return { browser, visibility, root, target, posts, results, readNotifications, attempted, stop, intersect, paint, finish: status => finish({ requestId: posts[0].input.requestId, status }) };
}

test('a visible latest item is acknowledged once after rendering, never by background or offscreen observation', async () => {
  const f = fixture();
  await f.paint(); await f.paint(); assert.equal(f.posts.length, 0);
  f.intersect(true);
  assert.equal(f.posts.length, 0);
  await f.paint(); assert.equal(f.posts.length, 0);
  await f.paint(); assert.equal(f.posts.length, 1);
  f.intersect(true); await f.paint(); await f.paint();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].input.observationToken, observation.token);
  assert.equal(f.results[0].status, 'read');
  f.stop();

  const background = fixture();
  background.visibility.visibilityState = 'hidden';
  background.intersect(true); await background.paint(); await background.paint();
  assert.equal(background.posts.length, 0);
  background.visibility.visibilityState = 'visible'; background.visibility.dispatchEvent(new Event('visibilitychange'));
  await background.paint(); await background.paint();
  assert.equal(background.posts.length, 1);
  background.stop();
});

test('leaving, scrolling away or hiding before the content is shown cancels the read', async () => {
  for (const cancel of [f => f.stop(), f => f.intersect(false), f => { f.visibility.visibilityState = 'hidden'; f.visibility.dispatchEvent(new Event('visibilitychange')); }]) {
    const f = fixture(); f.intersect(true); await f.paint(); cancel(f); await f.paint();
    assert.equal(f.posts.length, 0);
    assert.equal(f.attempted.size, 0);
    f.stop();
  }
});

test('leaving preserves a submitted receipt: late success refreshes the catalog without changing the new view', async () => {
  const f = fixture({ delayResponse: true });
  f.intersect(true); await f.paint(); await f.paint();
  f.stop(); assert.equal(f.posts[0].signal.aborted, false);
  f.finish('read'); await setImmediate();
  assert.deepEqual(f.results, []);
  assert.deepEqual(f.readNotifications, ['refresh']);
});

test('unknown and unavailable results are not retried for the same visible content by rerendering', async () => {
  for (const receipt of ['unknown', 'unavailable', 'stale']) {
    const attempted = new Map();
    const first = fixture({ receipt, attempted });
    first.intersect(true); await first.paint(); await first.paint(); first.stop();
    assert.equal(first.posts.length, 1);
    const next = fixture({ attempted });
    next.intersect(true); await next.paint(); await next.paint();
    assert.equal(next.posts.length, 0);
    next.stop();
  }
});

test('a definitely stale observation can retry with a new token for unchanged visible text', async () => {
  const attempted = new Map();
  const first = fixture({ receipt: 'stale', attempted });
  first.intersect(true); await first.paint(); await first.paint(); first.stop();
  const next = fixture({ attempted, observed: { ...observation, token: 'new-stable-token' } });
  next.intersect(true); await next.paint(); await next.paint();
  assert.equal(next.posts.length, 1);
  assert.equal(next.posts[0].input.observationToken, 'new-stable-token');
  next.stop();
});

test('same-content refresh uses the latest token without cancelling its pending receipt', async () => {
  let current = observation;
  const f = fixture({ delayResponse: true, getObservation: () => current });
  f.intersect(true); await f.paint();
  current = { ...observation, token: 'refreshed-token' };
  await f.paint();
  assert.equal(f.posts[0].input.observationToken, 'refreshed-token');
  current = { ...observation, token: 'another-token' };
  f.intersect(true); await f.paint(); await f.paint();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].signal.aborted, false);
  f.finish('read'); await setImmediate();
  assert.equal(f.results[0].status, 'read');
  f.stop();
});

test('a modal prevents acknowledging obscured content and closing it resumes visible reading', async () => {
  const f = fixture();
  let open = true;
  f.visibility.querySelector = selector => selector === 'dialog[open]' && open ? {} : null;
  f.intersect(true); await f.paint(); await f.paint();
  assert.equal(f.posts.length, 0);
  open = false; f.browser.dispatchEvent(new Event('pocket-reading-visibility-change'));
  await f.paint(); await f.paint();
  assert.equal(f.posts.length, 1);
  f.stop();
});

test('a portal menu blocks a late visible reply until the menu has closed', async () => {
  const f = fixture();
  let open = true;
  f.visibility.querySelector = selector => selector === '[data-reading-overlay]' && open ? {} : null;
  f.intersect(true); await f.paint(); await f.paint();
  assert.equal(f.posts.length, 0);
  open = false; f.browser.dispatchEvent(new Event('pocket-reading-visibility-change'));
  await f.paint(); await f.paint();
  assert.equal(f.posts.length, 1);
  f.stop();
});

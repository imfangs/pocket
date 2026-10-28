import test from 'node:test';
import assert from 'node:assert/strict';
import { bindConversationDwellConnection } from '../src/conversationDwell.ts';
import { createComposerConnectionIntent } from '../src/composerConnection.ts';
import { newerConnection } from '../src/threadConnection.ts';

class Target {
  listeners = new Map();
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
  emit(type) { for (const fn of this.listeners.get(type) || []) fn(); }
  get listenerCount() { return [...this.listeners.values()].reduce((n, list) => n + list.length, 0); }
}
function fixture(connect = async () => {}) {
  const document = new Target(), browser = new Target(), timers = new Map();
  let now = 0, sequence = 0, allowed = true, calls = 0, overlay = false;
  document.defaultView = browser; document.visibilityState = 'visible'; browser.navigator = { onLine: true };
  document.querySelector = () => overlay ? {} : null;
  browser.setTimeout = (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: now + ms }); return id; };
  browser.clearTimeout = id => timers.delete(id);
  const dispose = bindConversationDwellConnection(document, {
    available: () => allowed,
    connect: async () => { calls++; await connect(); },
  });
  return { document, browser, timers, dispose, calls: () => calls, allow: value => { allowed = value; },
    overlay(value) { overlay = value; browser.emit('pocket-reading-visibility-change'); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = end;
    },
  };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('five visible seconds spend one passive attempt, never on initial open or repeated resume', async () => {
  const f = fixture();
  f.advance(4999); assert.equal(f.calls(), 0);
  f.advance(1); await flush(); assert.equal(f.calls(), 1);
  f.browser.emit('pageshow'); f.browser.emit('online'); f.advance(30000);
  assert.equal(f.calls(), 1); f.dispose();
});

test('leaving early cancels the timer and all listeners', () => {
  const f = fixture(); f.advance(4900); f.dispose(); f.advance(10000);
  assert.equal(f.calls(), 0); assert.equal(f.timers.size, 0);
  assert.equal(f.document.listenerCount + f.browser.listenerCount, 0);
});

test('hidden and offline time never counts; the next visible online visit starts five seconds again', () => {
  const f = fixture(); f.advance(4000);
  f.document.visibilityState = 'hidden'; f.document.emit('visibilitychange'); f.advance(10000);
  assert.equal(f.calls(), 0);
  f.document.visibilityState = 'visible'; f.document.emit('visibilitychange'); f.advance(4000);
  f.browser.navigator.onLine = false; f.browser.emit('offline'); f.advance(10000); assert.equal(f.calls(), 0);
  f.browser.navigator.onLine = true; f.browser.emit('online'); f.advance(4999); assert.equal(f.calls(), 0);
  f.advance(1); assert.equal(f.calls(), 1); f.dispose();
});

test('pagehide cancels even before visibility catches up; pageshow can start a fresh visible interval', () => {
  const f = fixture(); f.advance(4000); f.browser.emit('pagehide'); f.advance(10000); assert.equal(f.calls(), 0);
  f.browser.emit('pageshow'); f.advance(5000); assert.equal(f.calls(), 1); f.dispose();
});

test('a dialog or reader overlay pauses exposure and requires a new five-second interval after closing', () => {
  const f = fixture(); f.advance(4900); f.overlay(true); f.advance(10000); assert.equal(f.calls(), 0);
  f.overlay(false); f.advance(4999); assert.equal(f.calls(), 0);
  f.advance(1); assert.equal(f.calls(), 1); f.dispose();
});

test('ordinary reading visibility updates do not keep postponing an unobscured visit', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) { f.advance(1000); f.browser.emit('pocket-reading-visibility-change'); }
  f.advance(1000); assert.equal(f.calls(), 1); f.dispose();
});

test('eligibility is checked at the deadline, so a new queue or management blocker skips passive opening', () => {
  const f = fixture(); f.advance(4000); f.allow(false); f.advance(1000); assert.equal(f.calls(), 0);
  f.allow(true); f.advance(60000); assert.equal(f.calls(), 0, 'a skipped visit does not start an invisible retry loop');
  f.dispose();
});

test('passive failure stays quiet and does not spend the genuine input attempt', async () => {
  const f = fixture(async () => { throw new Error('offline'); });
  f.advance(5000); await flush(); assert.equal(f.calls(), 1);
  let inputCalls = 0;
  const input = createComposerConnectionIntent({ available: () => true, connect: async () => { inputCalls++; } });
  await input.request(); assert.equal(inputCalls, 1);
  f.browser.emit('online'); f.advance(10000); assert.equal(f.calls(), 1);
  input.dispose(); f.dispose();
});

test('a connection started by input before the deadline prevents a second passive operation', () => {
  const f = fixture(); f.advance(4000); f.allow(false); f.advance(1000);
  assert.equal(f.calls(), 0); f.dispose();
});

test('skipped is a terminal observation and cannot be overwritten by a late connecting snapshot', () => {
  const initial = { requestId: 'reading', status: 'connecting', startedAt: 1, checkedAt: 1 };
  const skipped = newerConnection(initial, { ...initial, status: 'skipped', checkedAt: 2 });
  assert.equal(skipped.status, 'skipped');
  assert.equal(newerConnection(skipped, { ...initial, checkedAt: 3 }).status, 'skipped');
  assert.equal(newerConnection(skipped, { ...initial, requestId: 'input', startedAt: 4, checkedAt: 4 }).status, 'connecting');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { bindShakeFeedback, observeShakeReadiness, requestShakePermission } from '../packages/feedback-kit/browser/shake.ts';

class Target {
  listeners = new Map();
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
  emit(type, value = {}) { for (const fn of this.listeners.get(type) || []) fn(value); }
  get count() { return [...this.listeners.values()].reduce((n, values) => n + values.length, 0); }
}
function fixture(permission = 'granted') {
  const browser = new Target(), document = new Target();
  document.visibilityState = 'visible'; browser.document = document;
  let time = 0, allowed = true, calls = 0;
  const dispose = bindShakeFeedback({ permission, browser, document, now: () => time, enabled: () => allowed, onShake: () => { calls++; } });
  return { browser, document, dispose, calls: () => calls, enabled: value => { allowed = value; },
    move(x, dt = 150, overrides = {}) { time += dt; browser.emit('devicemotion', { isTrusted: true, acceleration: { x, y: 0, z: 0 }, accelerationIncludingGravity: null, ...overrides }); },
    advance(ms) { time += ms; },
    gesture() { for (const x of [25, -25, 25]) this.move(x); },
  };
}

test('motion listeners require an explicit granted permission', () => {
  for (const permission of ['denied', 'unsupported']) {
    const f = fixture(permission); f.gesture(); assert.equal(f.calls(), 0); assert.equal(f.browser.count, 0); f.dispose();
  }
});
test('permission is requested only by the explicit function and denied/unsupported remain distinct', async () => {
  let requests = 0;
  const browser = { isSecureContext: true, DeviceMotionEvent: { requestPermission: async () => { requests++; return 'granted'; } } };
  assert.equal(requests, 0); assert.equal(await requestShakePermission(browser), 'granted'); assert.equal(requests, 1);
  assert.equal(await requestShakePermission({ isSecureContext: false, DeviceMotionEvent: browser.DeviceMotionEvent }), 'unsupported');
  assert.equal(await requestShakePermission({ isSecureContext: true }), 'unsupported');
  assert.equal(await requestShakePermission({ isSecureContext: true, DeviceMotionEvent: { requestPermission: async () => { throw new Error('needs user activation'); } } }), 'denied');
});
test('three deliberate alternating peaks trigger once and respect cooldown', () => {
  const f = fixture(); f.move(25); f.move(-25); assert.equal(f.calls(), 0); f.move(25); assert.equal(f.calls(), 1);
  f.gesture(); assert.equal(f.calls(), 1); f.advance(5000); f.gesture(); assert.equal(f.calls(), 2); f.dispose();
});
test('walking, stale sequences, sustained acceleration and synthetic events do not trigger', () => {
  const f = fixture(); for (const x of [2, -3, 6, 2, -4]) f.move(x);
  for (let i = 0; i < 6; i++) f.move(30);
  assert.equal(f.calls(), 0);
  f.move(0); f.move(25); f.move(-25, 1000); f.move(25, 1000); assert.equal(f.calls(), 0);
  for (const x of [25, -25, 25]) f.move(x, 150, { isTrusted: false }); assert.equal(f.calls(), 0); f.dispose();
});
test('hidden, modal-disabled and page exit sequences are cleared rather than replayed', () => {
  const f = fixture(); f.move(25); f.move(-25); f.document.visibilityState = 'hidden'; f.document.emit('visibilitychange'); f.move(25);
  f.document.visibilityState = 'visible'; f.move(-25); assert.equal(f.calls(), 0);
  f.enabled(false); f.gesture(); f.enabled(true); f.move(25); assert.equal(f.calls(), 0);
  f.browser.emit('pagehide'); f.move(-25); assert.equal(f.calls(), 0);
  f.browser.emit('blur'); f.gesture(); assert.equal(f.calls(), 1); f.dispose();
});
test('gravity fallback requires a prior fresh sample and preserves the same deliberate gesture rule', () => {
  const f = fixture();
  const gravity = x => f.move(0, 150, { acceleration: null, accelerationIncludingGravity: { x, y: 0, z: 9.8 } });
  gravity(0); gravity(25); gravity(-25); assert.equal(f.calls(), 0); gravity(25); assert.equal(f.calls(), 1); f.dispose();
});
test('invalid sensor values and disposal do not leave an active trigger or listener', () => {
  const f = fixture(); f.move(NaN); f.move(Infinity); f.move(0, 150, { acceleration: null }); assert.equal(f.calls(), 0);
  f.dispose(); assert.equal(f.browser.count + f.document.count, 0); f.gesture(); assert.equal(f.calls(), 0);
});

test('readiness observes usable native data without requesting permission or treating missing data as denial', () => {
  const browser = new Target(), document = new Target(); document.visibilityState = 'visible'; browser.document = document;
  let ready = 0, resets = 0, requests = 0;
  browser.DeviceMotionEvent = { requestPermission: () => { requests++; } };
  const dispose = observeShakeReadiness({ browser, document, onReady: () => ready++, onReset: () => resets++ });
  for (const value of [{ isTrusted:false,acceleration:{x:0,y:0,z:0} },{ isTrusted:true,acceleration:null },{ isTrusted:true,acceleration:{x:NaN,y:0,z:0} }])browser.emit('devicemotion',value);
  assert.equal(ready,0);assert.equal(requests,0);
  browser.emit('devicemotion',{isTrusted:true,acceleration:null,accelerationIncludingGravity:{x:0,y:0,z:9.8}});
  browser.emit('devicemotion',{isTrusted:true,acceleration:{x:0,y:0,z:0}});assert.equal(ready,1);
  document.visibilityState='hidden';document.emit('visibilitychange');browser.emit('devicemotion',{isTrusted:true,acceleration:{x:0,y:0,z:0}});
  assert.equal(ready,1);document.visibilityState='visible';document.emit('visibilitychange');browser.emit('devicemotion',{isTrusted:true,acceleration:{x:0,y:0,z:0}});
  assert.equal(ready,2);assert.equal(resets,2);assert.equal(requests,0);
  dispose();assert.equal(browser.count+document.count,0);
});

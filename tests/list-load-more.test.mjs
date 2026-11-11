import test from 'node:test';
import assert from 'node:assert/strict';
import { bindListLoadMore } from '../src/listLoadMore.ts';

function fixture() {
  const panel = new EventTarget(), doc = new EventTarget(), browser = new EventTarget(), timers = new Map();
  let clock = 0, next = 1, key = 'all:80', count = 0, ready = true, hidden = false, selected = false, held = false, moving = false;
  Object.assign(panel, { ownerDocument: doc, isConnected: true, scrollTop: 1500, scrollHeight: 2000, clientHeight: 500,
    closest: () => hidden ? panel : null, contains: target => target === panel,
    getClientRects: () => [{ width: 390, height: 500 }], querySelector: () => held ? {} : null });
  Object.assign(doc, { visibilityState: 'visible', querySelector: () => null, getSelection: () => ({ isCollapsed: !selected }) });
  Object.assign(browser, { performance: { now: () => clock },
    setTimeout: (fn, delay) => { const id = next++; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id) });
  const binding = bindListLoadMore(panel, { pageKey: () => key, canLoad: () => ready, waitForLayout: () => moving,
    load: () => { count++; key = 'all:' + (80 + count * 80); } }, browser);
  const fire = (target, type, props = {}) => {
    const e = new Event(type, { cancelable: true }); Object.assign(e, props); target.dispatchEvent(e); return e;
  };
  const advance = ms => {
    const end = clock + ms;
    while (true) {
      const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      clock = first[1].at; timers.delete(first[0]); first[1].fn();
    }
    clock = end;
  };
  const touch = (type, x, y, count = 1) => fire(type === 'touchend' || type === 'touchcancel' ? doc : panel, type,
    { touches: Array.from({ length: count }, (_, identifier) => ({ identifier, clientX: x, clientY: y })) });
  const wheel = (dy = 100, dx = 0, props = {}) => fire(panel, 'wheel', { deltaY: dy, deltaX: dx, ...props });
  return { panel, doc, browser, binding, fire, touch, wheel, advance, timers,
    get count() { return count; }, hidden: v => { hidden = v; }, selected: v => { selected = v; },
    held: v => { held = v; }, moving: v => { moving = v; }, ready: v => { ready = v; }, key: v => { key = v; } };
}

test('an upward touch at bottom appends one batch after release without intercepting scrolling', () => {
  const f = fixture();
  assert.equal(f.touch('touchstart', 200, 500).defaultPrevented, false);
  assert.equal(f.touch('touchmove', 200, 430).defaultPrevented, false);
  f.advance(500); assert.equal(f.count, 0);
  f.touch('touchend', 200, 430, 0); f.advance(120); assert.equal(f.count, 1);
  f.fire(f.panel, 'scroll'); f.advance(2000); assert.equal(f.count, 1);
  f.binding(); assert.equal(f.timers.size, 0);
});

test('pressed row and layout motion defer the same gesture until it settles', () => {
  const f = fixture(); f.held(true); f.moving(true);
  f.touch('touchstart', 200, 500); f.touch('touchmove', 200, 430); f.touch('touchend', 200, 430, 0);
  f.advance(400); assert.equal(f.count, 0);
  f.held(false); f.advance(200); assert.equal(f.count, 0);
  f.moving(false); f.advance(60); assert.equal(f.count, 1);
  f.binding();
});

test('wheel bursts load once even when no native scroll event is emitted at the bottom', () => {
  const f = fixture(); f.wheel(); f.advance(120); assert.equal(f.count, 1);
  f.wheel(); f.advance(120); assert.equal(f.count, 1);
  f.advance(240); f.wheel(); f.advance(120); assert.equal(f.count, 2);
  f.binding();
});

test('programmatic scroll, mount and restored positions have no paging intent', () => {
  const f = fixture(); f.fire(f.panel, 'scroll'); f.advance(6000); assert.equal(f.count, 0);
  f.panel.scrollTop = 1100; f.wheel(); f.advance(120); assert.equal(f.count, 0);
  f.panel.scrollTop = 1500; f.fire(f.panel, 'scroll'); f.advance(120); assert.equal(f.count, 0);
  f.binding();
});

test('slow wheel ticks can reach bottom within one burst before it is consumed', () => {
  const f = fixture();
  f.panel.scrollTop = 1100;
  for (const top of [1200, 1300, 1400, 1500]) {
    f.wheel(); f.panel.scrollTop = top; f.fire(f.panel, 'scroll'); f.advance(150);
  }
  assert.equal(f.count, 1);
  f.wheel(); f.advance(150); assert.equal(f.count, 1, 'ticks after the successful append still belong to the consumed burst');
  f.binding();
});

test('horizontal/downward/cancelled/multitouch gestures do not load', () => {
  for (const kind of ['horizontal', 'downward', 'cancelled', 'multitouch']) {
    const f = fixture(); f.touch('touchstart', 200, 500);
    if (kind === 'horizontal') f.touch('touchmove', 130, 480);
    else if (kind === 'downward') f.touch('touchmove', 200, 570);
    else f.touch('touchmove', 200, 430, kind === 'multitouch' ? 2 : 1);
    f.touch(kind === 'cancelled' ? 'touchcancel' : 'touchend', 200, 430, 0); f.advance(600); assert.equal(f.count, 0, kind);
    f.binding();
  }
});

test('scope replacement, selection, inert state and pending actions revoke intent', () => {
  for (const kind of ['scope', 'selection', 'hidden', 'busy']) {
    const f = fixture(); f.wheel();
    if (kind === 'scope') f.key('other:80');
    else if (kind === 'selection') f.selected(true);
    else if (kind === 'hidden') f.hidden(true);
    else f.ready(false);
    f.advance(120); assert.equal(f.count, 0, kind);
    f.hidden(false); f.selected(false); f.ready(true); f.advance(1000); assert.equal(f.count, 0, 'old intent cannot revive'); f.binding();
  }
});

test('keyboard scrolling qualifies but layout waits and disposal cannot retain a delayed load', () => {
  const f = fixture(); f.fire(f.panel, 'keydown', { key: 'End' }); f.advance(120); assert.equal(f.count, 1);
  f.held(true); f.wheel(); f.advance(6001); assert.equal(f.count, 1, 'layout wait is bounded');
  f.advance(240); f.held(false); f.wheel(); f.binding(); f.advance(120); assert.equal(f.count, 1);
});

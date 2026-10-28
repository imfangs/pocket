import test from 'node:test';
import assert from 'node:assert/strict';
import { bindMessageScrollDismiss } from '../src/messageScrollDismiss.ts';

class Target extends EventTarget {
  listeners = [];
  addEventListener(type, callback, options) { super.addEventListener(type, callback, options); this.listeners.push({ type, callback, options }); }
  removeEventListener(type, callback, options) { super.removeEventListener(type, callback, options); this.listeners = this.listeners.filter(item => item.type !== type || item.callback !== callback); }
  fire(type, fields = {}) {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
    this.dispatchEvent(event); return event;
  }
}
function fixture() {
  const root = new Target(), doc = new Target(), browser = new Target(), viewport = new Target();
  let focused = true, selected = false, overlay = false, keyboard = false, now = 0, sequence = 0;
  let dismissals = 0, settlements = 0;
  const timers = new Map(), markers = new Set();
  const panel = { getBoundingClientRect: () => ({ left: 0 }), hasAttribute: () => keyboard };
  Object.assign(doc, {
    visibilityState: 'visible', defaultView: browser, body: { append: node => markers.add(node) },
    getSelection: () => ({ isCollapsed: !selected }), querySelector: () => overlay || markers.size ? {} : null,
    createElement: () => { const node = { setAttribute() {}, remove: () => markers.delete(node) }; return node; },
    createEvent: () => Object.assign(new Event('pocket-reading-visibility-change'), { initEvent() {} }),
  });
  Object.assign(root, { ownerDocument: doc, closest: () => panel });
  Object.assign(browser, { visualViewport: viewport, performance: { now: () => now },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const dispose = bindMessageScrollDismiss(root, {
    canDismiss: () => focused,
    dismiss: () => { assert.equal(markers.size, 1, 'reading is protected before blur/layout changes'); focused = false; dismissals++; },
    settled: () => { assert.equal(markers.size, 1, 'position is reconciled before follow resumes'); settlements++; },
  }, browser);
  const target = { closest: () => null };
  const touch = (type, x, y, time, { fingers = type === 'touchend' || type === 'touchcancel' ? 0 : 1, id = 1, at = target, prevented = false } = {}) => {
    const point = { clientX: x, clientY: y, identifier: id };
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries({ touches: Array.from({ length: fingers }, () => point), timeStamp: time, target: at }))
      Object.defineProperty(event, key, { value });
    if (prevented) event.preventDefault();
    root.dispatchEvent(event);
    if (type === 'touchend' || type === 'touchcancel') doc.dispatchEvent(event);
    return event;
  };
  return { root, doc, browser, viewport, dispose, touch, target, timers, markers,
    focused: value => { focused = value; }, select: value => { selected = value; }, overlay: value => { overlay = value; }, keyboard: value => { keyboard = value; },
    counts: () => ({ dismissals, settlements }),
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = until;
    },
  };
}
const swipe = f => { f.touch('touchstart', 150, 200, 0); return f.touch('touchmove', 152, 170, 50); };

test('vertical reading touch dismisses once without consuming native scrolling', () => {
  for (const direction of [-1, 1]) {
    const f = fixture();
    f.touch('touchstart', 150, 200, 0);
    assert.equal(f.touch('touchmove', 152, 200 + direction * 11, 20).defaultPrevented, false);
    assert.equal(f.counts().dismissals, 0);
    assert.equal(f.touch('touchmove', 152, 200 + direction * 20, 40).defaultPrevented, false);
    f.touch('touchmove', 152, 200 + direction * 60, 60);
    assert.equal(f.counts().dismissals, 1);
    assert.ok(f.root.listeners.filter(item => item.type.startsWith('touch')).every(item => item.options.passive));
    f.touch('touchend', 152, 140, 80); f.advance(250);
    assert.deepEqual(f.counts(), { dismissals: 1, settlements: 1 }); assert.equal(f.markers.size, 0); f.dispose();
  }
});

test('tap, long press, horizontal scroll, edge navigation, selection, controls and multi-touch remain untouched', () => {
  for (const kind of ['tap', 'long', 'horizontal', 'diagonal', 'edge', 'selection', 'control', 'multi', 'identity', 'prevented', 'overlay', 'unfocused']) {
    const f = fixture();
    if (kind === 'selection') f.select(true);
    if (kind === 'overlay') f.overlay(true);
    if (kind === 'unfocused') f.focused(false);
    const at = kind === 'control' ? { closest: () => ({}) } : f.target;
    const x = kind === 'edge' ? 25 : 150;
    f.touch('touchstart', x, 200, 0, { at, fingers: kind === 'multi' ? 2 : 1 });
    f.touch('touchmove', x + (['horizontal', 'diagonal'].includes(kind) ? 35 : 2),
      200 + (kind === 'tap' ? 5 : kind === 'diagonal' ? 28 : -40), kind === 'long' ? 401 : 40,
      { at, id: kind === 'identity' ? 2 : 1, prevented: kind === 'prevented' });
    f.touch('touchend', x, 160, 80); f.advance(1000);
    assert.deepEqual(f.counts(), { dismissals: 0, settlements: 0 }, kind); assert.equal(f.markers.size, 0, kind); f.dispose();
  }
});

test('composition or selection beginning during the gesture cancels the entire gesture', () => {
  for (const kind of ['composition', 'selection', 'contextmenu', 'multi']) {
    const f = fixture(); f.touch('touchstart', 150, 200, 0);
    if (kind === 'composition') f.focused(false);
    if (kind === 'selection') { f.select(true); f.doc.fire('selectionchange'); }
    if (kind === 'contextmenu') f.root.fire('contextmenu');
    f.touch('touchmove', 152, 170, 50, { fingers: kind === 'multi' ? 2 : 1 });
    f.focused(true); f.select(false); f.touch('touchmove', 152, 140, 80);
    assert.equal(f.counts().dismissals, 0, kind); f.dispose();
  }
});

test('streaming and textarea-generated scroll events cannot dismiss input', () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) { f.root.fire('scroll'); f.viewport.fire('resize'); f.advance(100); }
  assert.deepEqual(f.counts(), { dismissals: 0, settlements: 0 }); f.dispose();
});

test('reading remains protected through touch, momentum and the closing keyboard', () => {
  const f = fixture(); f.keyboard(true); swipe(f);
  f.advance(1000); assert.equal(f.markers.size, 1, 'finger still down');
  f.touch('touchend', 152, 170, 80); f.advance(200); f.root.fire('scroll');
  f.advance(200); f.keyboard(false); f.viewport.fire('resize');
  f.advance(200); f.viewport.fire('scroll');
  f.advance(249); assert.equal(f.counts().settlements, 0);
  f.advance(1); assert.equal(f.counts().settlements, 1); f.dispose();
});

test('keyboard metadata cannot keep the reading hold forever; refocus and unmount release it', () => {
  const f = fixture(); f.keyboard(true); swipe(f); f.touch('touchend', 152, 170, 80); f.advance(1250);
  assert.equal(f.markers.size, 0); assert.equal(f.counts().settlements, 1); f.dispose();
  const again = fixture(); swipe(again); again.focused(true); again.doc.fire('focusin');
  assert.equal(again.markers.size, 0); assert.equal(again.counts().settlements, 1); again.dispose();
  const disposed = fixture(); swipe(disposed); disposed.touch('touchend', 152, 170, 80); disposed.dispose(); disposed.advance(2000);
  assert.equal(disposed.markers.size, 0); assert.equal(disposed.counts().settlements, 0);
  for (const target of [disposed.root, disposed.doc, disposed.browser, disposed.viewport]) assert.equal(target.listeners.length, 0);
  assert.equal(disposed.timers.size, 0);
});

test('the last finger ending outside the message list releases a multi-touch reading hold', () => {
  const f = fixture(); swipe(f);
  f.touch('touchend', 152, 170, 80, { fingers: 1 }); f.advance(1000);
  assert.equal(f.markers.size, 1, 'another finger remains down outside the message region');
  f.doc.fire('touchend', { touches: [] }); f.advance(250);
  assert.equal(f.markers.size, 0); assert.equal(f.counts().settlements, 1); f.dispose();
});

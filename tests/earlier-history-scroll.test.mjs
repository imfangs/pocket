import test from 'node:test';
import assert from 'node:assert/strict';
import { bindEarlierHistoryScroll } from '../src/earlierHistoryScroll.ts';

class Target extends EventTarget {
  listeners = [];
  addEventListener(type, listener, options) { super.addEventListener(type, listener, options); this.listeners.push({ type, listener, options }); }
  removeEventListener(type, listener, options) { super.removeEventListener(type, listener, options); this.listeners = this.listeners.filter(value => value.type !== type || value.listener !== listener); }
  fire(type, values = {}, prevented = false) {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
    if (prevented) event.preventDefault(); this.dispatchEvent(event); return event;
  }
}
function fixture() {
  const root = new Target(), doc = new Target(), browser = new Target(), timers = new Map(), observers = new Set(), loads = [];
  let clock = 0, sequence = 0, available = true, selected = false, overlay = false, motion = false, hidden = false, shown = true, geometryReads = 0;
  let behavior = () => Promise.resolve();
  const panel = { getBoundingClientRect: () => ({ left: 100 }) };
  const target = { inside: true, closest: () => null };
  Object.assign(doc, { visibilityState: 'visible', documentElement: {}, activeElement: null,
    getSelection: () => ({ isCollapsed: !selected }),
    querySelector: selector => selector === '[data-reading-motion]' ? motion ? {} : null : overlay ? {} : null,
  });
  Object.assign(root, { ownerDocument: doc, scrollTop: 500, isConnected: true,
    contains: node => node === root || node?.inside === true,
    closest: selector => selector === '.inspector' ? panel : selector.includes('[hidden]') && hidden ? {} : null,
    getBoundingClientRect: () => ({ left: 100 }),
    getClientRects: () => { geometryReads++; return shown ? [{}] : []; },
  });
  Object.assign(browser, { performance: { now: () => clock },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
  });
  const dispose = bindEarlierHistoryScroll(root, { canLoad: () => available, load: () => { loads.push({ at: clock, top: root.scrollTop }); return behavior(); } }, browser);
  const mutation = () => { for (const observer of observers) observer.callback([]); };
  const touch = (type, x = 200, y = 100, { fingers = ['touchend', 'touchcancel'].includes(type) ? 0 : 1, id = 1, at = target, prevented = false } = {}) => {
    const point = { clientX: x, clientY: y, identifier: id };
    const fields = { touches: Array.from({ length: fingers }, (_, index) => ({ ...point, identifier: id + index })), changedTouches: [point], target: at };
    if (type === 'touchstart') {
      doc.fire(type, fields, prevented);
      if (root.contains(at)) return root.fire(type, fields, prevented);
      return;
    }
    return ['touchend', 'touchcancel'].includes(type) ? doc.fire(type, fields, prevented) : root.fire(type, fields, prevented);
  };
  const advance = ms => {
    const end = clock + ms; let steps = 0;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      assert.ok(++steps < 1000, 'timer must not hot-loop');
      clock = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    clock = end;
  };
  return { root, doc, browser, loads, timers, observers, dispose, target, touch, advance,
    async tick(ms = 0) { advance(ms); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); },
    scroll(top = root.scrollTop) { root.scrollTop = top; return root.fire('scroll', { target: root }); },
    wheel(deltaY = -20, { deltaX = 0, at = target, prevented = false, ...extra } = {}) {
      return root.fire('wheel', { target: at, deltaY, deltaX, clientX: 200, ...extra }, prevented);
    },
    available(value) { available = value; }, behavior(value) { behavior = value; },
    selected(value) { selected = value; doc.fire('selectionchange'); },
    overlay(value) { overlay = value; mutation(); browser.fire('pocket-reading-visibility-change'); },
    motion(value) { motion = value; mutation(); browser.fire('pocket-reading-visibility-change'); },
    hidden(value) { hidden = value; mutation(); }, shown(value) { shown = value; mutation(); },
    mutation, geometryReads: () => geometryReads,
  };
}
function gesture(f, { top = 0, end = true } = {}) {
  f.root.scrollTop = top; f.touch('touchstart', 200, 100); f.touch('touchmove', 201, 112);
  if (end) f.touch('touchend', 201, 112);
}

test('a real downwards reading gesture waits for release and settled momentum near the top', async () => {
  const f = fixture();
  f.touch('touchstart', 200, 100); f.touch('touchmove', 201, 160); f.scroll(40);
  await f.tick(500); assert.equal(f.loads.length, 0, 'holding the finger never loads');
  f.touch('touchend', 201, 160); await f.tick(80); f.scroll(0);
  await f.tick(119); assert.equal(f.loads.length, 0); await f.tick(1);
  assert.equal(f.loads.length, 1); assert.equal(f.loads[0].top, 0); f.dispose();
});

test('already at the top, 12px is sufficient without another scroll event or an 80px pull', async () => {
  const f = fixture(); gesture(f); await f.tick(120);
  assert.equal(f.loads.length, 1);
  for (let index = 0; index < 10; index++) { f.scroll(0); await f.tick(150); }
  assert.equal(f.loads.length, 1, 'programmatic anchor restoration never rearms the consumed gesture');
  gesture(f); await f.tick(120); assert.equal(f.loads.length, 2); f.dispose();
});

test('mount, programmatic scrolling, page restoration and idle mutations never create intent', async () => {
  const f = fixture(); const initialReads = f.geometryReads();
  for (let index = 0; index < 15; index++) { f.scroll(0); f.mutation(); f.browser.fire('pageshow'); await f.tick(200); }
  assert.equal(f.loads.length, 0); assert.equal(f.geometryReads(), initialReads, 'idle mutation observation does not force layout');
  assert.ok([...f.root.listeners, ...f.doc.listeners, ...f.browser.listeners].every(value => value.options.passive));
  f.dispose();
});

test('top threshold, actual direction, return edge, controls and cancellation are respected', async () => {
  for (const kind of ['below', 'tap', 'up', 'horizontal', 'diagonal', 'edge', 'identity', 'multi-start', 'multi-move', 'prevent-start', 'prevent-move', 'prevent-end', 'cancel', 'reversed']) {
    const f = fixture(); f.root.scrollTop = kind === 'below' ? 49 : 0;
    const x = kind === 'edge' ? 132 : 200;
    f.touch('touchstart', x, 100, { fingers: kind === 'multi-start' ? 2 : 1, prevented: kind === 'prevent-start' });
    f.touch('touchmove', x + (['horizontal', 'diagonal'].includes(kind) ? 30 : 1),
      kind === 'tap' ? 111 : kind === 'up' ? 80 : kind === 'horizontal' ? 102 : kind === 'diagonal' ? 125 : 130,
      { fingers: kind === 'multi-move' ? 2 : 1, id: kind === 'identity' ? 2 : 1, prevented: kind === 'prevent-move' });
    if (kind === 'reversed') f.touch('touchmove', x + 1, 115);
    f.touch(kind === 'cancel' ? 'touchcancel' : 'touchend', x + 1, 130, { prevented: kind === 'prevent-end' });
    await f.tick(2000); assert.equal(f.loads.length, 0, kind); f.dispose();
  }
  for (const tag of ['input', 'textarea', 'select', 'button', 'a', 'pre', 'table', 'video', 'audio', 'canvas', 'iframe', '.markdown-table', "[role='button']", "[contenteditable]:not([contenteditable='false'])"]) {
    const f = fixture(), at = { inside: true, closest: selector => selector.split(',').map(part => part.trim()).includes(tag) ? {} : null };
    f.root.scrollTop = 0; f.touch('touchstart', 200, 100, { at }); f.touch('touchmove', 201, 140, { at }); f.touch('touchend');
    await f.tick(120); assert.equal(f.loads.length, 0, tag); f.dispose();
  }
});

test('selection, input, composition, overlays, hidden regions and outside touches permanently cancel the candidate', async () => {
  for (const kind of ['selection', 'input', 'beforeinput', 'compositionstart', 'focus', 'contextmenu', 'overlay', 'inert', 'hidden-layout', 'visibility', 'pagehide', 'outside']) {
    const f = fixture(); gesture(f);
    if (kind === 'selection') { f.selected(true); f.selected(false); }
    else if (['input', 'beforeinput', 'compositionstart'].includes(kind)) f.doc.fire(kind);
    else if (kind === 'focus') f.doc.fire('focusin', { target: { closest: () => ({}) } });
    else if (kind === 'contextmenu') f.root.fire('contextmenu');
    else if (kind === 'overlay') { f.overlay(true); f.overlay(false); }
    else if (kind === 'inert') { f.hidden(true); f.hidden(false); }
    else if (kind === 'hidden-layout') { f.shown(false); f.shown(true); }
    else if (kind === 'visibility') { f.doc.visibilityState = 'hidden'; f.doc.fire('visibilitychange'); f.doc.visibilityState = 'visible'; f.doc.fire('visibilitychange'); }
    else if (kind === 'pagehide') { f.browser.fire('pagehide'); f.browser.fire('pageshow'); }
    else f.touch('touchstart', 200, 100, { at: { inside: false } });
    f.scroll(0); await f.tick(2000); assert.equal(f.loads.length, 0, kind); f.dispose();
  }
});

test('an existing composer focus may start the gesture and keyboard motion may settle after 1300ms', async () => {
  const f = fixture(); f.doc.activeElement = { tagName: 'TEXTAREA' }; f.root.scrollTop = 0;
  f.touch('touchstart', 200, 100); f.motion(true); f.doc.activeElement = null;
  f.touch('touchmove', 201, 120); f.touch('touchend', 201, 120);
  await f.tick(1300); assert.equal(f.loads.length, 0);
  f.motion(false); await f.tick(0); assert.equal(f.loads.length, 1);
  await f.tick(2000); assert.equal(f.loads.length, 1); f.dispose();
});

test('motion waiting expires after 1500ms even if scroll, notifications or duplicate end events continue', async () => {
  const f = fixture(); f.motion(true); gesture(f);
  for (let index = 0; index < 15; index++) {
    await f.tick(100); f.scroll(0); f.browser.fire('pocket-reading-visibility-change'); f.touch('touchend');
  }
  f.motion(false); await f.tick(1000);
  assert.equal(f.loads.length, 0); assert.equal(f.timers.size, 0); f.dispose();
});

test('real overlay or renewed editing during keyboard-motion wait never loads when the hold later clears', async () => {
  for (const action of ['overlay', 'input', 'selection', 'cancel']) {
    const f = fixture(); f.motion(true); gesture(f); await f.tick(200);
    if (action === 'overlay') { f.overlay(true); f.overlay(false); }
    else if (action === 'input') f.doc.fire('input');
    else if (action === 'selection') { f.selected(true); f.selected(false); }
    else f.touch('touchcancel');
    f.motion(false); await f.tick(2000); assert.equal(f.loads.length, 0, action); f.dispose();
  }
});

test('wheel bursts consume once, while direction changes, modifiers and nested controls cancel them', async () => {
  const f = fixture(); f.wheel(-30); f.scroll(0); await f.tick(120); assert.equal(f.loads.length, 1);
  await f.tick(60); f.wheel(-20); f.scroll(0); await f.tick(120); assert.equal(f.loads.length, 1);
  await f.tick(250); f.wheel(-20); await f.tick(120); assert.equal(f.loads.length, 2); f.dispose();
  for (const kind of ['down', 'horizontal', 'reversal', 'prevented', 'modified', 'control']) {
    const x = fixture(); x.root.scrollTop = 0;
    if (kind === 'reversal') x.wheel(-30);
    x.wheel(['down', 'reversal'].includes(kind) ? 20 : -20,
      { deltaX: kind === 'horizontal' ? 40 : 0, prevented: kind === 'prevented', ctrlKey: kind === 'modified',
        at: kind === 'control' ? { closest: () => ({}) } : x.target });
    await x.tick(120); assert.equal(x.loads.length, 0, kind); x.dispose();
  }
});

test('busy or unavailable at gesture start cannot queue work, and final availability is rechecked', async () => {
  const f = fixture(); let release;
  f.behavior(() => new Promise(resolve => { release = resolve; })); gesture(f); await f.tick(120); assert.equal(f.loads.length, 1);
  f.dispose.cancel(); gesture(f, { end: false }); release(); await f.tick(0); f.touch('touchend'); await f.tick(120);
  assert.equal(f.loads.length, 1, 'cancel must not clear the in-flight busy latch');
  f.behavior(() => Promise.resolve()); gesture(f); await f.tick(120); assert.equal(f.loads.length, 2);
  f.available(false); gesture(f, { end: false }); f.available(true); f.touch('touchend'); await f.tick(120); assert.equal(f.loads.length, 2);
  gesture(f); f.available(false); await f.tick(120); f.available(true); f.scroll(0); await f.tick(1000);
  assert.equal(f.loads.length, 2); f.dispose();
});

test('load rejection and synchronous failure do not cause an unhandled rejection or retry loop', async () => {
  for (const fail of [() => Promise.reject(new Error('reader handled it')), () => { throw new Error('synchronous reader failure'); }]) {
    const f = fixture(); f.behavior(fail); gesture(f); await f.tick(120);
    for (let index = 0; index < 10; index++) { f.scroll(0); await f.tick(200); }
    assert.equal(f.loads.length, 1); gesture(f); await f.tick(120); assert.equal(f.loads.length, 2); f.dispose();
  }
});

test('explicit cancel and disposal clear pending work and all observers without interfering with a started load', async () => {
  const f = fixture(); gesture(f); f.dispose.cancel(); f.scroll(0); await f.tick(2000); assert.equal(f.loads.length, 0);
  gesture(f); f.dispose(); await f.tick(2000); assert.equal(f.loads.length, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.observers.size, 0);
  for (const value of [f.root, f.doc, f.browser]) assert.equal(value.listeners.length, 0);
  gesture(f); await f.tick(2000); assert.equal(f.loads.length, 0);
});

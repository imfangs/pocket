import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { createDisclosureMotion } = await vite.ssrLoadModule('/src/useDisclosureMotion.ts');
after(() => vite.close());

function fixture({ height = 100, reduced = false, selected = false } = {}) {
  const frames = new Map(), listeners = new Map(), markers = new Set(), markerCounts = [], animations = [];
  let rafId = 0, naturalHeight = height, animationHeight = null;
  const mediaListeners = new Set();
  const media = { matches: reduced, addEventListener(_, fn) { mediaListeners.add(fn); }, removeEventListener(_, fn) { mediaListeners.delete(fn); } };
  const browser = {
    innerHeight: 800,
    getComputedStyle: () => ({ overflowY: 'auto' }),
    matchMedia: () => media,
    requestAnimationFrame(fn) { frames.set(++rafId, fn); return rafId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    dispatchEvent() { markerCounts.push(markers.size); },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const doc = {
    defaultView: browser,
    activeElement: null,
    createElement: () => ({ hidden: false, setAttribute() {}, remove() { markers.delete(this); } }),
    createEvent: () => ({ initEvent() {} }),
    body: { append(marker) { markers.add(marker); } },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    getSelection: () => selected ? { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ intersectsNode: () => true }) } : null,
  };
  const root = { scrollTop: 0, parentElement: null };
  const attrs = new Map();
  const element = {
    style: { height: '', maxBlockSize: '', overflow: '' }, hidden: false, inert: false,
    ownerDocument: doc, parentElement: root, isConnected: true,
    getBoundingClientRect: () => ({ height: element.hidden ? 0 : animationHeight ?? naturalHeight, top: 100 - root.scrollTop }),
    setAttribute(key, value) { attrs.set(key, value); }, removeAttribute(key) { attrs.delete(key); },
    animate(keyframes, options) {
      animationHeight = parseFloat(keyframes[0].height);
      const animation = { keyframes, options, onfinish: null, oncancel: null, cancelled: false,
        cancel() { this.cancelled = true; animationHeight = null; this.oncancel?.(); },
        finish() { animationHeight = parseFloat(keyframes.at(-1).height); this.onfinish?.(); },
      };
      animations.push(animation); return animation;
    },
  };
  const anchor = { isConnected: true, getBoundingClientRect: () => ({ top: 100 + element.getBoundingClientRect().height - root.scrollTop }) };
  const motion = createDisclosureMotion(element);
  return { motion, element, anchor, root, frames, markers, markerCounts, animations, attrs,
    height(value) { naturalHeight = value; }, frame(value) { animationHeight = value; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    event(type) { listeners.get(type)?.(); }, reduce() { media.matches = true; mediaListeners.forEach(fn => fn()); }, listeners, mediaListeners,
  };
}

test('a user disclosure keeps one reading gate and its trigger anchor throughout the bounded transition', () => {
  const f = fixture();
  f.motion.prepare(f.anchor); f.height(300); f.motion.commit();
  assert.equal(f.animations.length, 1);
  assert.equal(f.animations[0].options.duration, 180);
  assert.equal(f.markers.size, 1);
  f.frame(200);
  assert.equal(f.root.scrollTop, 100);
  assert.equal(f.anchor.getBoundingClientRect().top, 200);
  assert.equal(f.markers.size, 1, 'reading remains blocked after a layout frame');
  f.animations[0].finish();
  assert.equal(f.root.scrollTop, 200);
  assert.equal(f.markers.size, 0);
  assert.equal(f.attrs.has('data-disclosure-motion'), false);
  assert.deepEqual(f.element.style, { height: '', maxBlockSize: '', overflow: '' });
  f.motion.dispose();
});

test('closing process content keeps the same node visible and inert until its height reaches zero', () => {
  const f = fixture({ height: 240 });
  f.motion.prepare(f.element); f.element.hidden = true; f.motion.commit(true);
  assert.equal(f.element.hidden, false);
  assert.equal(f.element.inert, true);
  assert.deepEqual(f.animations[0].keyframes, [{ height: '240px' }, { height: '0px' }]);
  f.animations[0].finish();
  assert.equal(f.element.hidden, true);
  assert.equal(f.element.inert, false);
  assert.equal(f.markers.size, 0);
  f.motion.dispose();
});

test('a rapid reversal starts at the current visual height without opening a reading gap', () => {
  const f = fixture({ height: 100 });
  f.motion.prepare(f.anchor); f.height(300); f.motion.commit(); f.frame(180);
  f.motion.prepare(f.anchor); f.height(100); f.motion.commit();
  assert.equal(f.animations[0].cancelled, true);
  assert.deepEqual(f.animations[1].keyframes, [{ height: '180px' }, { height: '100px' }]);
  assert.ok(f.markerCounts.every(count => count > 0), 'replacement hold precedes releasing the old hold');
  f.animations[1].finish();
  assert.equal(f.markers.size, 0);
  f.motion.dispose();
});

test('polling, oversized documents, selection and reduced motion do not start disclosure animation', () => {
  for (const options of [{}, { reduced: true }, { selected: true }]) {
    const f = fixture(options);
    f.height(250); f.motion.commit();
    assert.equal(f.animations.length, 0, 'automatic layout is immediate');
    f.motion.prepare(f.anchor); f.height(options.reduced || options.selected ? 300 : 2000); f.motion.commit();
    assert.equal(f.animations.length, 0);
    assert.equal(f.markers.size, 0);
    f.motion.dispose();
  }
});

test('external open changes cancel a running collapse without restoring its stale hidden state', () => {
  const f = fixture({ height: 240 });
  f.motion.prepare(f.element); f.motion.commit(true);
  f.motion.commit(false);
  assert.equal(f.element.hidden, false);
  assert.equal(f.element.inert, false);
  assert.equal(f.markers.size, 0);
  assert.equal(f.animations.length, 1);
  f.motion.dispose();
});

test('scroll takeover, animation cancellation, reduced motion and unmount always release protection', () => {
  for (const interrupt of [f => f.event('wheel'), f => f.event('touchmove'), f => f.event('resize'), f => f.animations[0].cancel(), f => f.reduce(), f => f.motion.dispose()]) {
    const f = fixture(); f.motion.prepare(f.anchor); f.height(260); f.motion.commit();
    interrupt(f);
    assert.equal(f.markers.size, 0);
    assert.equal(f.frames.size, 0);
    assert.equal(f.attrs.has('data-disclosure-motion'), false);
    f.motion.dispose();
    assert.equal(f.listeners.size, 0);
    assert.equal(f.mediaListeners.size, 0);
  }
});

test('a controlled parent that declines the requested toggle cannot leave reading suspended', () => {
  const f = fixture(); f.motion.prepare(f.anchor);
  assert.equal(f.markers.size, 1);
  f.frame(100);
  assert.equal(f.markers.size, 0);
  assert.equal(f.animations.length, 0);
  f.motion.dispose();
});

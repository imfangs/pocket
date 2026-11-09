import test from 'node:test';
import assert from 'node:assert/strict';
import { bindQuestionInputVisibility } from '../src/questionInputVisibility.ts';

function fixture() {
  const root = new EventTarget(), document = new EventTarget(), browser = new EventTarget(), scroller = new EventTarget();
  const viewport = Object.assign(new EventTarget(), { height: 420, offsetTop: 70, scale: 1 });
  let offset = 620, inputHeight = 64, now = 0, next = 0;
  const frames = new Map(), timers = new Map();
  Object.assign(scroller, { scrollTop: 0, clientTop: 1, clientHeight: 240,
    getBoundingClientRect: () => ({ top: 130, bottom: 372 }) });
  const input = { matches: () => true, closest: () => scroller, scrollTop: 17,
    getBoundingClientRect: () => ({ top: offset - scroller.scrollTop, bottom: offset + inputHeight - scroller.scrollTop, height: inputHeight }) };
  Object.assign(document, { activeElement: input, visibilityState: 'visible' });
  Object.assign(root, { ownerDocument: document, contains: node => node === input, closest: () => scroller });
  Object.assign(browser, { document, visualViewport: viewport, innerHeight: 844, matchMedia: () => ({ matches: true }),
    requestAnimationFrame: callback => { frames.set(++next, callback); return next; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (callback, delay) => { timers.set(++next, { callback, at: now + delay }); return next; }, clearTimeout: id => timers.delete(id) });
  const emit = (type, target = input, source = root) => { const event = new Event(type); Object.defineProperty(event, 'target', { value: target }); source.dispatchEvent(event); };
  const paint = () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } };
  const settle = () => { paint(); paint(); };
  const advance = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } settle(); };
  return { root, document, browser, scroller, viewport, input, frames, timers, emit, settle, advance,
    position(top, height = 64) { offset = top; inputHeight = height; } };
}

test('editor focus reveals the answer only in its owned scroll container after layout settles', () => {
  const f = fixture(), cleanup = bindQuestionInputVisibility(f.root, f.browser);
  assert.equal(f.scroller.scrollTop, 0, 'Mounting never changes reading position');
  f.emit('focusin'); assert.equal(f.scroller.scrollTop, 0);
  f.settle(); assert.equal(f.scroller.scrollTop, 321);
  assert.equal(f.input.scrollTop, 17, 'Internal textarea scrolling is untouched');
  assert.equal(f.document.activeElement, f.input, 'Focus is not reassigned');
  cleanup();
});

test('viewport movement clips visibility at its actual offset instead of panning the document', () => {
  const f = fixture(), cleanup = bindQuestionInputVisibility(f.root, f.browser);
  f.position(350); f.scroller.scrollTop = 200; f.viewport.offsetTop = 200;
  f.viewport.dispatchEvent(new Event('scroll')); f.settle();
  assert.equal(f.scroller.scrollTop, 142, 'Input is aligned with the visible top plus breathing room');
  cleanup();
});

test('late keyboard geometry is sampled for one bounded recovery window', () => {
  const f = fixture(), cleanup = bindQuestionInputVisibility(f.root, f.browser);
  f.emit('focusin'); f.settle();
  f.viewport.height = 210; f.viewport.offsetTop = 70; f.advance(480);
  assert.equal(f.scroller.scrollTop, 412);
  f.advance(1100); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  const top = f.scroller.scrollTop; f.position(800); f.advance(2000);
  assert.equal(f.scroller.scrollTop, top, 'Content changes alone never schedule a reveal');
  cleanup();
});

test('new answer text rechecks growth without replacing focus or manipulating IME state', () => {
  const f = fixture(), cleanup = bindQuestionInputVisibility(f.root, f.browser);
  f.position(280, 64); f.emit('focusin'); f.settle(); assert.equal(f.scroller.scrollTop, 0);
  f.position(280, 110); f.emit('input'); f.settle(); assert.equal(f.scroller.scrollTop, 27);
  assert.equal(f.document.activeElement, f.input); assert.equal(f.input.scrollTop, 17);
  cleanup();
});

test('another input, radio focus, hidden pages and page zoom do not scroll stale answers', () => {
  for (const state of ['outside', 'radio', 'hidden', 'zoom', 'invalid']) {
    const f = fixture(), cleanup = bindQuestionInputVisibility(f.root, f.browser);
    if (state === 'outside') f.document.activeElement = {};
    if (state === 'radio') f.input.matches = () => false;
    if (state === 'hidden') f.document.visibilityState = 'hidden';
    if (state === 'zoom') f.viewport.scale = 1.2;
    if (state === 'invalid') f.viewport.height = NaN;
    f.emit('focusin'); f.viewport.dispatchEvent(new Event('resize')); f.settle(); f.advance(1200);
    assert.equal(f.scroller.scrollTop, 0, state);
    cleanup();
  }
});

test('a deliberate reading gesture cancels late samples while retained input focus stays intact', () => {
  for (const type of ['touchstart', 'wheel']) {
    const f = fixture(), cleanup = bindQuestionInputVisibility(f.root, f.browser);
    f.emit('focusin'); f.settle(); const top = f.scroller.scrollTop;
    f.emit(type, { matches: () => false }, f.scroller); f.position(900); f.advance(1200);
    assert.equal(f.scroller.scrollTop, top); assert.equal(f.document.activeElement, f.input);
    f.viewport.dispatchEvent(new Event('scroll')); f.settle(); f.advance(1200);
    assert.equal(f.scroller.scrollTop, top, 'Keyboard dismissal tail events do not restart revealing');
    f.emit('click'); f.settle(); assert.ok(f.scroller.scrollTop > top, 'A fresh editor tap restores visibility');
    cleanup();
  }
});

test('focus handoff and disposal cancel every frame, timer and event binding', () => {
  const f = fixture(), cleanup = bindQuestionInputVisibility(f.root, f.browser);
  f.emit('focusin'); f.document.activeElement = {}; f.document.dispatchEvent(new Event('focusin'));
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  f.document.activeElement = f.input; f.emit('focusin'); cleanup();
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  f.emit('input'); f.viewport.dispatchEvent(new Event('resize')); f.settle();
  assert.equal(f.scroller.scrollTop, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { bindMessageRegionFocus } from '../src/messageRegionFocus.ts';

function fixture() {
  const document = new EventTarget(); document.activeElement = null;
  const root = new EventTarget(), child = new EventTarget(), attributes = new Map(), timers = new Map();
  root.ownerDocument = document; root.contains = node => node === root || node === child;
  root.getAttribute = name => attributes.get(name) ?? null;
  root.setAttribute = (name, value) => attributes.set(name, value);
  root.removeAttribute = name => attributes.delete(name);
  let timer = 0;
  const browser = { setTimeout: callback => { timers.set(++timer, callback); return timer; }, clearTimeout: id => timers.delete(id) };
  const dispatch = (target, name, fields = {}) => {
    const event = new Event(name, { cancelable: true });
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event); return event;
  };
  const focus = () => { document.activeElement = root; dispatch(root, 'focusin'); };
  const blur = () => { document.activeElement = child; dispatch(root, 'focusout'); };
  const key = (value, fields) => dispatch(document, 'keydown', { key: value, ...fields });
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); };
  return { root, child, document, browser, dispatch, key, focus, blur, flush, timers,
    origin: () => root.getAttribute('data-message-focus-origin') };
}

test('programmatic reading focus stays neutral and a real Tab transfer owns keyboard visibility', () => {
  const f = fixture(), stop = bindMessageRegionFocus(f.root, f.browser);
  assert.equal(f.origin(), 'programmatic'); f.focus(); assert.equal(f.origin(), 'programmatic');
  f.blur(); f.key('Tab'); f.focus(); assert.equal(f.origin(), 'keyboard'); f.flush(); assert.equal(f.origin(), 'keyboard');
  f.blur(); f.key('Tab'); f.flush(); f.focus(); assert.equal(f.origin(), 'programmatic'); stop();
});

test('pointer and touch intent clear a latched region outline without blurring or consuming input', () => {
  const f = fixture(), stop = bindMessageRegionFocus(f.root, f.browser);
  f.key('Tab'); f.focus(); assert.equal(f.origin(), 'keyboard');
  const down = f.dispatch(f.document, 'pointerdown', { target: f.child });
  assert.equal(down.defaultPrevented, false); assert.equal(f.document.activeElement, f.root); assert.equal(f.origin(), 'pointer');
  f.key('ArrowUp'); assert.equal(f.origin(), 'keyboard');
  const touch = f.dispatch(f.root, 'touchstart');
  assert.equal(touch.defaultPrevented, false); assert.equal(f.document.activeElement, f.root); assert.equal(f.origin(), 'pointer'); stop();
});

test('keyboard scrolling restores the region boundary while keys in child controls do not take over', () => {
  const f = fixture(), stop = bindMessageRegionFocus(f.root, f.browser);
  f.focus(); f.dispatch(f.root, 'touchstart');
  for (const key of ['ArrowDown', 'PageUp', 'Home', 'End', ' ']) { f.key(key); assert.equal(f.origin(), 'keyboard'); }
  f.dispatch(f.root, 'touchstart'); f.key('Home', { ctrlKey: true }); assert.equal(f.origin(), 'keyboard');
  f.blur(); f.key('ArrowDown'); assert.equal(f.origin(), 'programmatic');
  f.dispatch(f.root, 'focusin', { target: f.child }); assert.equal(f.origin(), 'programmatic'); stop();
});

test('IME and browser-shortcut Tab do not claim later programmatic focus', () => {
  for (const fields of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    const f = fixture(), stop = bindMessageRegionFocus(f.root, f.browser);
    f.key('Tab', fields); f.focus(); assert.equal(f.origin(), 'programmatic'); stop();
  }
});

test('dispose cancels the keyboard candidate and restores only this root attribute', () => {
  const f = fixture(); f.root.setAttribute('data-message-focus-origin', 'previous');
  const stop = bindMessageRegionFocus(f.root, f.browser); f.key('Tab'); assert.equal(f.timers.size, 1);
  stop(); assert.equal(f.timers.size, 0); assert.equal(f.origin(), 'previous');
  f.dispatch(f.root, 'touchstart'); f.key('ArrowDown'); assert.equal(f.origin(), 'previous');
});

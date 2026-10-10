import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRowSwipe, ROW_ACTION_WIDTH } from '../src/rowSwipe.ts';

class ListenerTarget extends EventTarget {
  listeners = [];
  addEventListener(type, callback, options) {
    super.addEventListener(type, callback, options);
    this.listeners.push({ type, callback, options, capture: options === true || !!options?.capture });
  }
  removeEventListener(type, callback, options) {
    super.removeEventListener(type, callback, options);
    const capture = options === true || !!options?.capture;
    this.listeners = this.listeners.filter(item => item.type !== type || item.callback !== callback || item.capture !== capture);
  }
}
class ElementFixture {
  constructor(tag, { parent = null, className = '', editable } = {}) {
    Object.assign(this, { tag, parent, className, editable });
  }
  closest(selectors) {
    for (let current = this; current; current = current.parent) {
      if (selectors.split(',').some(selector => {
        selector = selector.trim();
        if (selector === "[contenteditable]:not([contenteditable='false'])") return current.editable !== undefined && current.editable !== 'false';
        const [tag, className] = selector.split('.');
        return current.tag === tag && (!className || current.className.split(' ').includes(className));
      })) return current;
    }
    return null;
  }
}
function fixture({ initiallyOpen = false } = {}) {
  const row = new ListenerTarget(), document = new ListenerTarget();
  const main = new ElementFixture('button', { className: 'task-select' });
  const title = new ElementFixture('strong', { parent: main });
  const action = new ElementFixture('button', { className: 'row-swipe-action' });
  row.querySelector = selector => selector === 'button.task-select' ? main : null;
  let open = initiallyOpen, enabled = true, selection = false, claims = 0, clock = 1000;
  const translations = [], changes = [];
  const cleanup = bindRowSwipe(row, {
    enabled: () => enabled, isOpen: () => open, onClaim: () => { claims++; },
    onOpenChange: next => { open = next; changes.push(next); },
    onTranslate: (offset, dragging) => translations.push({ offset, dragging }),
  }, { document, getSelection: () => ({ isCollapsed: !selection }) });
  function touch(type, x = 200, y = 200, { target = title, fingers = type === 'touchend' || type === 'touchcancel' ? 0 : 1, id = 1, elapsed = 10, cancelable = true } = {}) {
    clock += elapsed;
    const event = new Event(type, { cancelable });
    Object.defineProperties(event, {
      touches: { value: Array.from({ length: fingers }, (_, index) => ({ identifier: id + index, clientX: x, clientY: y })) },
      changedTouches: { value: [{ identifier: id, clientX: x, clientY: y }] },
      target: { value: target }, timeStamp: { value: clock },
    });
    row.dispatchEvent(event);
    return event;
  }
  function click({ target = title, detail = 1, elapsed = 10, ...source } = {}) {
    clock += elapsed;
    const event = new Event('click', { cancelable: true });
    Object.defineProperties(event, { target: { value: target }, detail: { value: detail }, timeStamp: { value: clock } });
    Object.assign(event, source);
    row.dispatchEvent(event);
    return event;
  }
  const swipe = () => { touch('touchstart'); touch('touchmove', 140, 204); touch('touchend', 140, 204); };
  return { row, document, main, title, action, translations, changes, cleanup, touch, click, swipe,
    claims: () => claims, isOpen: () => open, enable: value => { enabled = value; },
    select: value => { selection = value; }, setOpen: value => { open = value; } };
}

test('a clear left swipe claims once, follows the finger within 84px, and opens on release', () => {
  const f = fixture();
  assert.equal(ROW_ACTION_WIDTH, 84);
  f.touch('touchstart');
  assert.equal(f.touch('touchmove', 189, 202).defaultPrevented, false);
  assert.equal(f.claims(), 0);
  assert.equal(f.touch('touchmove', 175, 203).defaultPrevented, true);
  assert.deepEqual(f.translations.at(-1), { offset: -25, dragging: true });
  assert.equal(f.touch('touchmove', 70, 206).defaultPrevented, true);
  assert.deepEqual(f.translations.at(-1), { offset: -84, dragging: true });
  f.touch('touchend', 70, 206);
  assert.equal(f.claims(), 1); assert.deepEqual(f.changes, [true]);
  assert.deepEqual(f.translations.at(-1), { offset: -84, dragging: false });
  f.cleanup();
});

test('release position determines the half-width threshold, including a short swipe and reversal', () => {
  const f = fixture();
  f.touch('touchstart'); f.touch('touchmove', 180); f.touch('touchend', 158);
  assert.equal(f.isOpen(), true);
  f.touch('touchstart'); f.touch('touchmove', 225); f.touch('touchend', 230);
  assert.equal(f.isOpen(), true);
  f.touch('touchstart'); f.touch('touchmove', 250); f.touch('touchend', 250);
  assert.equal(f.isOpen(), false);
  f.touch('touchstart'); f.touch('touchmove', 170); f.touch('touchend', 170);
  assert.equal(f.isOpen(), false);
  f.touch('touchstart'); f.touch('touchmove', 140); f.touch('touchmove', 210); f.touch('touchend', 210);
  assert.deepEqual(f.translations.at(-2), { offset: 0, dragging: true });
  assert.deepEqual(f.translations.at(-1), { offset: 0, dragging: false });
  f.cleanup();
});

test('a right swipe closes an open row without exceeding its closed edge', () => {
  const f = fixture({ initiallyOpen: true });
  f.touch('touchstart');
  assert.equal(f.touch('touchmove', 225, 203).defaultPrevented, true);
  assert.deepEqual(f.translations.at(-1), { offset: -59, dragging: true });
  f.touch('touchmove', 400); f.touch('touchend', 400);
  assert.deepEqual(f.changes, [false]);
  assert.deepEqual(f.translations.at(-1), { offset: 0, dragging: false });
  f.cleanup();
});

test('vertical, diagonal, outward, and tiny gestures preserve native scrolling and ordinary taps', () => {
  for (const { x, y, open = false } of [{ x: 203, y: 225 }, { x: 180, y: 218 }, { x: 209, y: 205 }, { x: 230, y: 200 }, { x: 170, y: 200, open: true }]) {
    const f = fixture({ initiallyOpen: open });
    assert.equal(f.touch('touchstart').defaultPrevented, false);
    assert.equal(f.touch('touchmove', x, y).defaultPrevented, false);
    f.touch('touchend', x, y);
    assert.equal(f.claims(), 0); assert.deepEqual(f.changes, []);
    assert.equal(f.click().defaultPrevented, false);
    f.cleanup();
  }
  const f = fixture();
  f.touch('touchstart'); f.touch('touchmove', 203, 225);
  assert.equal(f.touch('touchmove', 130, 227).defaultPrevented, false);
  assert.equal(f.claims(), 0, 'vertical scroll cannot turn into a claimed horizontal swipe');
  f.cleanup();
});

test('multitouch, a changed touch identity, and uncancelable native movement never claim', () => {
  const f = fixture();
  f.touch('touchstart', 200, 200, { fingers: 2 }); f.touch('touchmove', 140); f.touch('touchend', 140);
  f.touch('touchstart'); f.touch('touchmove', 190, 200, { fingers: 2 });
  assert.equal(f.touch('touchmove', 140).defaultPrevented, false);
  f.touch('touchstart'); assert.equal(f.touch('touchmove', 140, 200, { id: 2 }).defaultPrevented, false);
  f.touch('touchstart'); assert.equal(f.touch('touchmove', 140, 200, { cancelable: false }).defaultPrevented, false);
  assert.equal(f.claims(), 0); assert.deepEqual(f.changes, []);
  f.cleanup();
});

test('form fields, links, editable content, and other buttons are excluded, including descendants', () => {
  for (const control of [
    ...['form', 'input', 'textarea', 'select', 'a', 'button'].map(tag => new ElementFixture(tag)),
    ...['', 'true', 'plaintext-only'].map(editable => new ElementFixture('div', { editable })),
  ]) {
    const f = fixture(), target = new ElementFixture('span', { parent: control });
    f.touch('touchstart', 200, 200, { target });
    assert.equal(f.touch('touchmove', 140, 200, { target }).defaultPrevented, false);
    assert.equal(f.claims(), 0); f.cleanup();
  }
  const f = fixture(), impostor = new ElementFixture('button', { className: 'task-select' });
  f.touch('touchstart', 200, 200, { target: impostor }); f.touch('touchmove', 140);
  assert.equal(f.claims(), 0, 'only this row\'s actual primary button is allowed');
  f.cleanup();
});

test('existing text selection and long presses stay native before the gesture is claimed', () => {
  const f = fixture();
  f.select(true); f.swipe(); assert.equal(f.claims(), 0);
  f.select(false); f.touch('touchstart');
  assert.equal(f.touch('touchmove', 180, 200, { elapsed: 400 }).defaultPrevented, false);
  assert.equal(f.touch('touchmove', 140).defaultPrevented, false);
  f.touch('touchstart');
  const menu = new Event('contextmenu', { cancelable: true }); f.row.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, false);
  assert.equal(f.touch('touchmove', 140).defaultPrevented, false);
  assert.equal(f.claims(), 0); assert.deepEqual(f.changes, []);
  f.cleanup();
});

test('selection changes, pinch, and touchcancel restore the current stable offset after a claim', () => {
  for (const cancel of [
    f => f.document.dispatchEvent(new Event('selectionchange')),
    f => f.touch('touchcancel'),
    f => f.touch('touchmove', 210, 200, { fingers: 2 }),
  ]) {
    const f = fixture({ initiallyOpen: true });
    f.touch('touchstart'); f.touch('touchmove', 225);
    cancel(f);
    assert.deepEqual(f.translations.at(-1), { offset: -84, dragging: false });
    f.touch('touchend', 260); assert.deepEqual(f.changes, []);
    f.cleanup();
  }
  const f = fixture({ initiallyOpen: true });
  f.touch('touchstart'); f.touch('touchmove', 225); f.setOpen(false);
  f.touch('touchcancel');
  assert.deepEqual(f.translations.at(-1), { offset: 0, dragging: false });
  f.cleanup();
});

test('batch selection disables swiping and a mid-gesture disable cancels without opening a row', () => {
  const f = fixture();
  f.enable(false); f.swipe(); assert.equal(f.claims(), 0);
  f.enable(true); f.touch('touchstart'); f.touch('touchmove', 150); f.enable(false);
  assert.equal(f.touch('touchmove', 140).defaultPrevented, false);
  f.touch('touchend', 140);
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.translations.at(-1), { offset: 0, dragging: false });
  f.cleanup();
});

test('only one synthesized primary-row click is suppressed; keyboard, action, and real mouse clicks survive', () => {
  const f = fixture(); f.swipe();
  assert.equal(f.click({ detail: 0 }).defaultPrevented, false);
  assert.equal(f.click({ target: f.action }).defaultPrevented, false);
  assert.equal(f.click({ sourceCapabilities: { firesTouchEvents: false } }).defaultPrevented, false);
  assert.equal(f.click({ pointerType: 'mouse' }).defaultPrevented, false);
  assert.equal(f.click({ pointerType: 'touch' }).defaultPrevented, true);
  assert.equal(f.click().defaultPrevented, false);
  f.cleanup();
});

test('a following ordinary touch resets click suppression, and unused suppression expires', () => {
  const f = fixture(); f.swipe();
  f.touch('touchstart'); f.touch('touchend');
  assert.equal(f.click().defaultPrevented, false);
  f.setOpen(false); f.swipe();
  assert.equal(f.click({ elapsed: 501 }).defaultPrevented, false);
  f.cleanup();
});

test('cleanup restores any drag and removes every row and document listener', () => {
  const f = fixture();
  assert.equal(f.row.listeners.find(item => item.type === 'touchmove').options.passive, false);
  for (const type of ['touchstart', 'touchend', 'touchcancel']) assert.equal(f.row.listeners.find(item => item.type === type).options.passive, true);
  f.touch('touchstart'); f.touch('touchmove', 150); f.cleanup(); f.cleanup();
  assert.deepEqual(f.translations.at(-1), { offset: 0, dragging: false });
  assert.equal(f.row.listeners.length, 0); assert.equal(f.document.listeners.length, 0);
  const claims = f.claims(), count = f.translations.length;
  f.swipe(); f.document.dispatchEvent(new Event('selectionchange'));
  assert.equal(f.claims(), claims); assert.equal(f.translations.length, count);
  assert.equal(f.click().defaultPrevented, false);
});

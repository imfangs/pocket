import test from 'node:test';
import assert from 'node:assert/strict';
import { creationRecoveryIds, mergeOperation, observeCreationNotice, readCreationRecoveryIds, saveCreationRecoveryIds } from '../src/taskOperations.ts';

const requestId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const creation = { requestId, operation: 'create', status: 'succeeded', threadId: 'created-thread' };

function fixture({ operation = creation, enabled = true, hidden = false, focused = false, hovered = false } = {}) {
  const browser = new EventTarget(), visibility = new EventTarget(), target = new EventTarget();
  const firstButton = {}, secondButton = {}, children = new Set([target, firstButton, secondButton]);
  const timers = new Map();
  let time = 0, timerId = 0, intersection, dismissals = 0, disconnected = false;
  const blocked = { modal: false, menu: false, sidebar: false, inert: false };
  Object.assign(browser, {
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, at: time + delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    matchMedia: () => ({ matches: true }),
  });
  Object.assign(visibility, {
    visibilityState: hidden ? 'hidden' : 'visible', activeElement: focused ? firstButton : null,
    querySelector: selector => selector === 'dialog[open], [data-reading-overlay]' ? blocked.modal || blocked.menu ? {} : null
      : selector === '.sidebar-backdrop.shown' && blocked.sidebar ? { getBoundingClientRect: () => ({ width: 390, height: 844 }) } : null,
  });
  Object.assign(target, { contains: value => children.has(value), closest: () => blocked.inert ? {} : null, matches: () => hovered });
  class Observer {
    constructor(callback) { intersection = callback; }
    observe(value) { assert.equal(value, target); }
    disconnect() { disconnected = true; intersection = null; }
  }
  const observer = observeCreationNotice({ requestId, target, browser, visibility, Observer, now: () => time, onDismiss: () => dismissals++ });
  observer.update(operation, enabled);
  const update = (next = operation, allowed = enabled) => { operation = next; enabled = allowed; observer.update(next, allowed); };
  const event = (destination, type, properties = {}) => destination.dispatchEvent(Object.assign(new Event(type), properties));
  return {
    browser, visibility, target, blocked, firstButton, secondButton, observer, update,
    get dismissals() { return dismissals; }, get pendingTimers() { return timers.size; }, get disconnected() { return disconnected; },
    intersect: (ratio = 1) => intersection?.([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]),
    event,
    advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].fn();
      }
      time = end;
    },
  };
}

test('successful creation dismisses once after eight fully visible seconds', () => {
  const f = fixture();
  f.advance(20000); assert.equal(f.dismissals, 0, 'not yet observed on screen');
  f.intersect(0.5); f.advance(20000); assert.equal(f.dismissals, 0, 'the open action may still be clipped');
  f.intersect(); f.advance(7999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1); assert.equal(f.disconnected, true);
  f.update({ ...creation, updatedAt: 123 }); f.advance(20000);
  assert.equal(f.dismissals, 1); assert.equal(f.pendingTimers, 0);
});

test('pending, waiting, unknown, errors and other terminal outcomes never use a dismissal timer', () => {
  const f = fixture({ operation: { ...creation, status: 'pending' } }); f.intersect();
  for (const status of ['pending', 'waiting', 'unknown', 'rejected', 'changed', 'cancelled']) {
    f.update({ ...creation, status }); f.advance(20000);
    assert.equal(f.dismissals, 0, status); assert.equal(f.pendingTimers, 0, status);
  }
  for (const operation of ['archive', 'restore']) {
    f.update({ ...creation, operation }); f.advance(20000); assert.equal(f.dismissals, 0);
  }
  f.update(creation, false); f.advance(20000); assert.equal(f.dismissals, 0, 'an error or unavailable open/dismiss action disables auto-dismiss');
  f.update(creation, true); f.advance(7999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('unknown creation resolving later retains a full window to open its recovered conversation', () => {
  const f = fixture({ operation: { requestId, operation: 'create', status: 'unknown' } }); f.intersect();
  f.advance(60000); assert.equal(f.dismissals, 0);
  f.update(mergeOperation({ requestId, operation: 'create', status: 'unknown' }, creation));
  f.advance(7999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('background time is excluded before and during the visible countdown', () => {
  const f = fixture({ hidden: true }); f.intersect(); f.advance(20000);
  f.visibility.visibilityState = 'visible'; f.event(f.visibility, 'visibilitychange');
  f.advance(3000);
  f.visibility.visibilityState = 'hidden'; f.event(f.visibility, 'visibilitychange'); f.advance(20000);
  assert.equal(f.dismissals, 0);
  f.visibility.visibilityState = 'visible'; f.event(f.visibility, 'visibilitychange');
  f.advance(4999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('mobile detail coverage and offscreen scrolling pause instead of resetting or consuming time', () => {
  const f = fixture(); f.intersect(); f.advance(2000);
  f.update(creation, false); f.advance(20000); assert.equal(f.dismissals, 0);
  f.update(creation, true); f.advance(2000);
  f.intersect(0); f.advance(20000); assert.equal(f.dismissals, 0);
  f.intersect(); f.advance(3999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('mouse hover pauses, while touch pointer events cannot leave a successful notice stuck', () => {
  const f = fixture(); f.intersect(); f.advance(3000);
  f.event(f.target, 'pointerenter', { pointerType: 'mouse' }); f.advance(20000); assert.equal(f.dismissals, 0);
  f.event(f.target, 'pointerleave', { pointerType: 'mouse' });
  f.event(f.target, 'pointerenter', { pointerType: 'touch' });
  f.advance(4999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('keyboard focus within either notice action preserves the remaining opportunity', () => {
  const f = fixture({ focused: true }); f.intersect(); f.advance(20000);
  f.event(f.target, 'focusout', { relatedTarget: null }); f.advance(3000);
  f.event(f.target, 'focusin'); f.advance(20000);
  f.event(f.target, 'focusout', { relatedTarget: f.secondButton }); f.advance(20000);
  assert.equal(f.dismissals, 0, 'moving between notice buttons does not resume');
  f.event(f.target, 'focusout', { relatedTarget: null });
  f.advance(4999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('a notice mounted under a hovering pointer waits until the pointer leaves', () => {
  const f = fixture({ hovered: true }); f.intersect(); f.advance(20000); assert.equal(f.dismissals, 0);
  f.event(f.target, 'pointerleave', { pointerType: 'mouse' });
  f.advance(7999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('dialogs, menus, mobile navigation and inert ancestors pause the countdown', () => {
  for (const obstruction of ['modal', 'menu', 'sidebar', 'inert']) {
    const f = fixture(); f.intersect(); f.advance(3000);
    f.blocked[obstruction] = true; f.event(f.browser, 'pocket-reading-visibility-change'); f.advance(20000);
    assert.equal(f.dismissals, 0, obstruction);
    f.blocked[obstruction] = false; f.event(f.browser, 'pocket-reading-visibility-change');
    f.advance(4999); assert.equal(f.dismissals, 0, obstruction);
    f.advance(1); assert.equal(f.dismissals, 1, obstruction);
  }
});

test('page lifecycle suspension preserves the remaining visible time', () => {
  const f = fixture(); f.intersect(); f.advance(3000);
  f.event(f.browser, 'pagehide'); f.advance(20000); assert.equal(f.dismissals, 0);
  f.event(f.browser, 'pageshow'); f.advance(4999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('an unfocused browser window does not consume the remaining interaction time', () => {
  const f = fixture(); f.intersect(); f.advance(3000);
  f.event(f.browser, 'blur'); f.advance(20000); assert.equal(f.dismissals, 0);
  f.event(f.browser, 'focus'); f.advance(4999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('returning from background refreshes hover and focus missed while the page was inactive', () => {
  for (const type of ['focus', 'pageshow', 'visibilitychange']) {
    const f = fixture(); f.intersect(); f.advance(3000);
    f.event(f.target, 'pointerenter', { pointerType: 'mouse' }); f.event(f.target, 'focusin');
    f.event(f.browser, 'blur'); f.advance(20000);
    f.event(type === 'visibilitychange' ? f.visibility : f.browser, type);
    f.advance(4999); assert.equal(f.dismissals, 0, type);
    f.advance(1); assert.equal(f.dismissals, 1, type);
  }
});

test('fresh poll objects and repeated eligibility checks do not renew the deadline', () => {
  const f = fixture(); f.intersect();
  for (let i = 0; i < 3; i++) {
    f.advance(2000); f.update({ ...creation, updatedAt: i + 1 }); f.intersect();
    assert.equal(f.pendingTimers, 1);
  }
  f.advance(1999); assert.equal(f.dismissals, 0);
  f.advance(1); assert.equal(f.dismissals, 1);
});

test('manual close, open or unmount stops the observer without a later automatic callback', () => {
  const f = fixture(); f.intersect(); f.advance(3000); f.observer.stop();
  f.update(creation); f.intersect(); f.event(f.target, 'focusout', { relatedTarget: null });
  f.event(f.browser, 'pageshow'); f.advance(20000);
  assert.equal(f.dismissals, 0); assert.equal(f.pendingTimers, 0); assert.equal(f.disconnected, true);
});

test('dismissing success clears reload recovery and stale polling cannot restore its request ID', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const watched = new Set([requestId]);
  const succeeded = mergeOperation({ requestId, operation: 'create', status: 'unknown' }, creation);
  saveCreationRecoveryIds(creationRecoveryIds([succeeded], watched), storage);
  assert.deepEqual(readCreationRecoveryIds(storage), [requestId], 'keep recovery while open remains available');
  watched.delete(requestId);
  saveCreationRecoveryIds(creationRecoveryIds([succeeded], watched), storage);
  for (const status of ['pending', 'unknown', 'succeeded']) {
    const late = mergeOperation(succeeded, { ...creation, status });
    saveCreationRecoveryIds(creationRecoveryIds([late], watched), storage);
    assert.deepEqual(readCreationRecoveryIds(storage), []);
    assert.equal(late.status, 'succeeded');
  }
});

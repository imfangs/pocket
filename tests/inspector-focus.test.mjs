import test from 'node:test';
import assert from 'node:assert/strict';
import { focusInspectorEntry, inspectorEntryFromClick, scheduleInspectorReturnFocus } from '../src/inspectorFocus.ts';

function fixture() {
  const calls = [];
  let modal = false;
  const back = { focus: options => calls.push({ target: 'back', options }) };
  const panel = { ownerDocument: { querySelector: () => modal }, querySelector: () => back,
    focus: options => calls.push({ target: 'panel', options }) };
  return { panel, calls, modal: value => { modal = value; } };
}

test('pointer and keyboard entry use actual activation instead of animation preferences', () => {
  assert.equal(inspectorEntryFromClick({ detail: 1 }), 'pointer');
  assert.equal(inspectorEntryFromClick({ detail: 2 }), 'pointer');
  assert.equal(inspectorEntryFromClick({ detail: 0 }), 'keyboard');
});
test('pointer entry focuses the reading container without selecting the back button', () => {
  const f = fixture(); focusInspectorEntry(f.panel, 'pointer');
  assert.deepEqual(f.calls, [{ target: 'panel', options: { preventScroll: true } }]);
});
test('keyboard entry keeps an actionable focus target', () => {
  const f = fixture(); focusInspectorEntry(f.panel, 'keyboard');
  assert.deepEqual(f.calls, [{ target: 'back', options: { preventScroll: true } }]);
});
test('notifications, deep links and unspecified entry focus neutral content', () => {
  const f = fixture(); focusInspectorEntry(f.panel, 'programmatic'); focusInspectorEntry(f.panel);
  assert.deepEqual(f.calls.map(call => call.target), ['panel', 'panel']);
});
test('entry focus cannot steal focus from an open modal and can resume after it closes', () => {
  const f = fixture(); f.modal(true); focusInspectorEntry(f.panel, 'pointer');
  assert.deepEqual(f.calls, []);
  f.modal(false); focusInspectorEntry(f.panel, 'pointer'); assert.equal(f.calls[0].target, 'panel');
});

function returnFixture() {
  const calls = [], frames = new Map(), document = new EventTarget();
  const listeners = new Set(), add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
  document.addEventListener = (type, callback, options) => { listeners.add(type); add(type, callback, options); };
  document.removeEventListener = (type, callback, options) => { listeners.delete(type); remove(type, callback, options); };
  const body = {}, editor = {}, back = {}, outside = {};
  let modal = false, inert = false, current = true, hasRow = true;
  const focus = name => ({ focus: options => { calls.push({ target: name, options }); document.activeElement = outside; } });
  const row = { ...focus('row'), dataset: { threadId: 'one' }, disabled: false, closest: () => null };
  const surface = focus('surface');
  document.body = body; document.documentElement = {}; document.activeElement = editor;
  document.querySelector = () => modal ? {} : null;
  const panel = { ownerDocument: document, contains: node => node === editor || node === back };
  const list = { isConnected: true, closest: () => inert ? {} : null,
    querySelectorAll: () => hasRow ? [row] : [], querySelector: () => surface };
  const browser = { requestAnimationFrame: callback => { frames.set(1, callback); return 1; }, cancelAnimationFrame: id => frames.delete(id) };
  const schedule = (origin, signal) => scheduleInspectorReturnFocus(panel, list, 'one', origin, () => current, browser, signal);
  const frame = () => { const callback = frames.get(1); frames.clear(); callback?.(); };
  const signal = (type, target) => { const event = new Event(type); Object.defineProperty(event, 'target', { value: target }); document.dispatchEvent(event); };
  return { calls, document, body, editor, back, outside, list, row, schedule, frame, signal, listeners, frames,
    modal: value => { modal = value; }, inert: value => { inert = value; }, current: value => { current = value; }, hasRow: value => { hasRow = value; } };
}

test('touch return after editing focuses neutral list content instead of a row outline', () => {
  const f = returnFixture(); f.schedule('pointer'); f.document.activeElement = f.body; f.frame();
  assert.deepEqual(f.calls, [{ target: 'surface', options: { preventScroll: true } }]);
});

test('keyboard and assistive return restore the original actionable row, with neutral fallback', () => {
  for (const missing of [false, true]) {
    const f = returnFixture(); f.hasRow(!missing); f.document.activeElement = f.back; f.schedule('keyboard');
    f.document.activeElement = f.body; f.frame();
    assert.equal(f.calls[0].target, missing ? 'surface' : 'row');
  }
  const f = returnFixture(); f.schedule('programmatic'); f.frame(); assert.equal(f.calls[0].target, 'surface');
});

test('late return focus respects reopened detail, modal, inert navigation and unmounted list', () => {
  for (const state of ['reopened', 'modal', 'menu', 'unmounted', 'new-focus']) {
    const f = returnFixture(); f.schedule('keyboard'); f.document.activeElement = f.body;
    if (state === 'reopened') f.current(false);
    if (state === 'modal') f.modal(true);
    if (state === 'menu') f.inert(true);
    if (state === 'unmounted') f.list.isConnected = false;
    if (state === 'new-focus') f.document.activeElement = f.outside;
    f.frame(); assert.deepEqual(f.calls, [], state);
  }
});

test('new search or navigation intent wins even if its focus is cleared before the frame', () => {
  for (const type of ['focusin', 'pointerdown', 'keydown']) {
    const f = returnFixture(); f.schedule('keyboard'); f.signal(type, f.outside); f.document.activeElement = f.body;
    f.frame(); assert.deepEqual(f.calls, [], type);
  }
});

test('cancelling a scheduled return removes its callback and never steals focus', () => {
  const f = returnFixture(); const cancel = f.schedule('pointer'); cancel(); f.frame(); assert.deepEqual(f.calls, []);
});

test('new selection or App unmount aborts a suspended return frame and removes every listener', () => {
  const f = returnFixture(), controller = new AbortController();
  f.schedule('pointer', controller.signal); assert.equal(f.listeners.size, 3); assert.equal(f.frames.size, 1);
  controller.abort(); assert.equal(f.listeners.size, 0); assert.equal(f.frames.size, 0);
  f.frame(); assert.deepEqual(f.calls, []);
  f.schedule('keyboard', controller.signal); assert.equal(f.listeners.size, 0); assert.equal(f.frames.size, 0);
});

test('completed return removes its abort listener so later cleanup cannot affect a newer frame', () => {
  const f = returnFixture(), controller = new AbortController();
  f.schedule('pointer', controller.signal); f.frame(); assert.equal(f.listeners.size, 0);
  f.schedule('keyboard'); controller.abort(); assert.equal(f.frames.size, 1);
  f.document.activeElement = f.body; f.frame(); assert.equal(f.calls.at(-1).target, 'row');
});

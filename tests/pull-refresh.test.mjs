import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { bindPullToRefresh } from "../src/pullToRefresh.ts";
function fixture() {
  const panel = Object.assign(new EventTarget(), { scrollTop: 0 });
  const states = []; let calls = 0, release, allowed = true;
  const cleanup = bindPullToRefresh(panel, { canRefresh: () => allowed,
    refresh: () => { calls++; return new Promise(r => { release = r; }); }, onChange: s => states.push(s) },
    { matchMedia: () => ({ matches: true }), getSelection: () => ({ isCollapsed: true }) });
  function event(type, x, y, ignored = false, fingers = 1, claimed = false) {
    const e = new Event(type, { cancelable: true });
    Object.defineProperties(e, { touches: { value: Array(fingers).fill({ clientX:x, clientY:y }) }, target: { value: { closest: () => ignored ? {} : null } } });
    if (claimed) e.preventDefault();
    panel.dispatchEvent(e); assert.equal(e.defaultPrevented, claimed);
  }
  function click(action = false, detail = 1) {
    const e = new Event('click', { cancelable: true });
    Object.defineProperties(e, { detail: { value: detail }, target: { value: { closest: selector => !action && selector === 'button.task-select' ? {} : null } } });
    panel.dispatchEvent(e); return e;
  }
  return { panel, states, cleanup, event, click, calls:()=>calls, release:()=>release?.(), block:()=>allowed=false };
}
test("pull from the top refreshes once on release and returns after completion", async () => {
  const f = fixture(); f.event("touchstart", 100, 200); f.event("touchmove", 102, 300);
  assert.equal(f.states.at(-1).armed, true); assert.equal(f.calls(), 0);
  f.event("touchend", 102, 300); await setImmediate();
  assert.equal(f.calls(), 1); assert.equal(f.states.at(-1).refreshing, true);
  f.event("touchstart",100,200); f.event("touchmove",100,310); f.event("touchend",100,310);
  assert.equal(f.calls(), 1);
  f.release(); await setImmediate(); assert.equal(f.states.at(-1).distance, 0); f.cleanup();
});
test("ordinary scroll, horizontal gestures, short pulls and controls do not refresh", async () => {
  const f = fixture();
  f.panel.scrollTop=20; f.event("touchstart",100,200);f.event("touchmove",100,350);f.event("touchend",100,350);
  f.panel.scrollTop=0; f.event("touchstart",100,200);f.event("touchmove",200,205);f.event("touchend",200,205);
  f.event("touchstart",100,200);f.event("touchmove",100,230);f.event("touchend",100,230);
  f.event("touchstart",100,200,true);f.event("touchmove",100,350);f.event("touchend",100,350);
  f.event("touchstart",100,200);f.event("touchmove",100,350,false,2);f.event("touchend",100,350);
  f.block();f.event("touchstart",100,200);f.event("touchmove",100,350);f.event("touchend",100,350);
  await setImmediate();assert.equal(f.calls(),0);f.cleanup();
});
test("a drag cannot open its task row, while the following tap still works", () => {
  const f = fixture();
  f.event("touchstart",100,200);f.event("touchmove",100,230);f.event("touchend",100,230);
  const dragClick = f.click();
  assert.equal(dragClick.defaultPrevented, true);
  f.event("touchstart",100,200);f.event("touchend",100,200);
  const tap = f.click();
  assert.equal(tap.defaultPrevented, false);f.cleanup();
});

test('horizontal and already claimed row gestures do not make the pull layer block a pin action', () => {
  for (const claimed of [false, true]) {
    const f = fixture();
    f.event('touchstart', 200, 200); f.event('touchmove', 140, 202, false, 1, claimed); f.event('touchend', 140, 202);
    assert.equal(f.click(true).defaultPrevented, false);
    assert.equal(f.click().defaultPrevented, false, 'the row gesture owns any ghost-click suppression');
    assert.equal(f.calls(), 0); f.cleanup();
  }
});

test('after a vertical pull, action buttons and keyboard clicks still work while one row ghost click is suppressed', () => {
  const f = fixture();
  f.event('touchstart', 100, 200); f.event('touchmove', 100, 230); f.event('touchend', 100, 230);
  assert.equal(f.click(true).defaultPrevented, false);
  assert.equal(f.click(false, 0).defaultPrevented, false);
  assert.equal(f.click().defaultPrevented, true);
  assert.equal(f.click().defaultPrevented, false);
  f.cleanup();
});

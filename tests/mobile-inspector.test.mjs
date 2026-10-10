import test from "node:test";
import assert from "node:assert/strict";
import { bindInspectorSwipe, bindInspectorViewport } from "../src/mobileInspector.ts";

function fixture() {
  const panel = new EventTarget(), browser = new EventTarget();
  const viewport = Object.assign(new EventTarget(), { height: 780, offsetTop: 0, scale: 1 });
  const narrow = Object.assign(new EventTarget(), { matches: true });
  const document = Object.assign(new EventTarget(), { activeElement: null, visibilityState: 'visible', documentElement: { clientHeight: 780 } });
  const properties = new Map(), attributes = new Set(), frames = new Map(), timers = new Map();
  let nextFrame = 0, nextTimer = 0, now = 0;
  panel.style = { getPropertyValue: key => properties.get(key) || '', setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) };
  panel.toggleAttribute = (key, value) => value ? attributes.add(key) : attributes.delete(key);
  panel.removeAttribute = key => attributes.delete(key);
  panel.getBoundingClientRect = () => ({ left: 0 });
  const input = { matches: () => true };
  panel.contains = target => target === input;
  Object.assign(browser, {
    document, visualViewport: viewport, innerHeight: 780, innerWidth: 390,
    matchMedia: () => narrow, getSelection: () => ({ isCollapsed: true }),
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
    performance: { now: () => now },
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const flush = () => { for (const [id, callback] of frames) { frames.delete(id); callback(); } };
  const advance = ms => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); } flush(); };
  return { panel, browser, viewport, document, narrow, properties, attributes, frames, timers, input, flush, advance };
}

test('late keyboard-close metrics recover without a second viewport event', () => {
  const f=fixture(), cleanup=bindInspectorViewport(f.panel,f.browser);
  f.document.activeElement=f.input;f.viewport.height=390;f.document.dispatchEvent(new Event('focusin'));f.flush();
  f.document.activeElement=null;f.document.dispatchEvent(new Event('focusout'));f.flush();
  f.viewport.height=780;f.advance(1100);
  assert.equal(f.properties.has('--inspector-viewport-height'),false);
  assert.equal(f.attributes.has('data-keyboard-open'),false);cleanup();
});

test('returning from background or the page cache discards the old keyboard frame', () => {
  for(const event of ['pageshow','visibilitychange']) {
    const f=fixture(), cleanup=bindInspectorViewport(f.panel,f.browser);
    f.document.activeElement=f.input;f.viewport.height=390;f.document.dispatchEvent(new Event('focusin'));f.flush();
    f.viewport.height=780;
    (event==='pageshow'?f.browser:f.document).dispatchEvent(new Event(event));f.flush();
    assert.equal(f.properties.has('--inspector-viewport-height'),false,event);cleanup();
  }
});

test('no editor or invalid viewport metrics cannot leave a shortened inspector', () => {
  for(const metrics of [{height:390,offsetTop:158},{height:0,offsetTop:NaN},{height:NaN,offsetTop:0}]) {
    const f=fixture();Object.assign(f.viewport,metrics);const cleanup=bindInspectorViewport(f.panel,f.browser);
    assert.equal(f.properties.size,0);cleanup();
  }
});

test('blur releases permanently stale short metrics after a bounded closing grace period', () => {
  const f=fixture(), cleanup=bindInspectorViewport(f.panel,f.browser);
  f.document.activeElement=f.input;f.viewport.height=390;f.document.dispatchEvent(new Event('focusin'));f.flush();
  f.document.activeElement=null;f.document.dispatchEvent(new Event('focusout'));f.flush();
  assert.equal(f.properties.get('--inspector-viewport-height'),'390px');
  f.advance(1100);assert.equal(f.properties.size,0);assert.equal(f.timers.size,0);cleanup();
});

test('a delayed first frame cannot start a new closing grace after all samples have elapsed', () => {
  const f=fixture(), cleanup=bindInspectorViewport(f.panel,f.browser);
  f.document.activeElement=f.input;f.viewport.height=390;f.document.dispatchEvent(new Event('focusin'));f.flush();
  f.document.activeElement=null;f.document.dispatchEvent(new Event('focusout'));
  f.advance(1500);assert.equal(f.properties.size,0);assert.equal(f.attributes.has('data-keyboard-open'),false);
  f.advance(1100);assert.equal(f.properties.size,0);assert.equal(f.timers.size,0);cleanup();
});

test('overlapping resume events preserve fresh input evidence within the same recovery', () => {
  const f=fixture(), cleanup=bindInspectorViewport(f.panel,f.browser);
  f.document.activeElement=f.input;f.viewport.height=390;f.document.dispatchEvent(new Event('focusin'));f.flush();
  f.browser.dispatchEvent(new Event('pageshow'));
  f.document.dispatchEvent(new Event('focusin'));
  f.browser.dispatchEvent(new Event('focus'));f.flush();
  assert.equal(f.properties.get('--inspector-viewport-height'),'390px');assert.equal(f.attributes.has('data-keyboard-open'),true);
  f.advance(1100);assert.equal(f.properties.get('--inspector-viewport-height'),'390px');cleanup();
});

test('retained input focus after app return does not revive old keyboard dimensions', () => {
  const f=fixture(), cleanup=bindInspectorViewport(f.panel,f.browser);
  f.document.activeElement=f.input;f.viewport.height=390;f.document.dispatchEvent(new Event('focusin'));f.flush();
  f.document.visibilityState='hidden';f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.properties.size,0);assert.equal(f.frames.size,0);assert.equal(f.timers.size,0);
  f.document.visibilityState='visible';f.document.dispatchEvent(new Event('visibilitychange'));f.advance(1100);
  assert.equal(f.properties.size,0);
  f.viewport.dispatchEvent(new Event('resize'));f.flush();
  assert.equal(f.properties.get('--inspector-viewport-height'),'390px','fresh viewport event confirms the current keyboard');
  cleanup();f.advance(2000);assert.equal(f.frames.size,0);assert.equal(f.timers.size,0);assert.equal(f.properties.size,0);
});

test('a keyboard that resizes both viewports uses the prior closed baseline, while rotation clears it', () => {
  const f=fixture(), cleanup=bindInspectorViewport(f.panel,f.browser);
  f.document.activeElement=f.input;f.browser.innerHeight=390;f.document.documentElement.clientHeight=390;f.viewport.height=390;
  f.viewport.dispatchEvent(new Event('resize'));f.flush();assert.equal(f.attributes.has('data-keyboard-open'),true);
  f.browser.innerWidth=640;f.browser.innerHeight=360;f.document.documentElement.clientHeight=360;f.viewport.height=360;
  f.browser.dispatchEvent(new Event('orientationchange'));f.advance(1100);
  assert.equal(f.properties.size,0,'a short landscape screen with focus is not itself a keyboard');cleanup();
});

test('a recovered full height discards leftover viewport pan and a keyboard pan stays within the layout', () => {
  const f=fixture(), cleanup=bindInspectorViewport(f.panel,f.browser);
  f.document.activeElement=f.input;Object.assign(f.viewport,{height:390,offsetTop:600});f.viewport.dispatchEvent(new Event('resize'));f.flush();
  assert.equal(f.properties.get('--inspector-viewport-top'),'390px');
  f.viewport.height=780;f.viewport.dispatchEvent(new Event('resize'));f.flush();assert.equal(f.properties.size,0);cleanup();
});

test("first focus follows the later keyboard resize and Safari viewport pan", () => {
  const f = fixture();
  const cleanup = bindInspectorViewport(f.panel, f.browser);
  assert.equal(f.properties.has("--inspector-viewport-height"), false);
  f.document.activeElement = f.input;
  f.document.dispatchEvent(new Event("focusin"));
  f.flush();
  assert.equal(f.attributes.has("data-keyboard-open"), false);
  Object.assign(f.viewport, { height: 390, offsetTop: 158 });
  f.viewport.dispatchEvent(new Event("resize"));
  f.flush();
  assert.equal(f.properties.get("--inspector-viewport-height"), "390px");
  assert.equal(f.properties.get("--inspector-viewport-top"), "158px");
  assert.equal(f.attributes.has("data-keyboard-open"), true);
  f.viewport.offsetTop = 120;
  f.viewport.dispatchEvent(new Event("scroll"));
  f.flush();
  assert.equal(f.properties.get("--inspector-viewport-top"), "120px");
  Object.assign(f.viewport, { height: 780, offsetTop: 0 });
  f.document.activeElement = null;
  f.document.dispatchEvent(new Event("focusout"));
  f.viewport.dispatchEvent(new Event("resize"));
  f.flush();
  assert.equal(f.attributes.has("data-keyboard-open"), false);
  assert.equal(f.properties.has("--inspector-viewport-height"), false);
  cleanup();
  assert.equal(f.properties.size, 0);
});

test("viewport handling preserves pinch zoom, desktop layout, and cleanup", () => {
  const f = fixture();
  const cleanup = bindInspectorViewport(f.panel, f.browser);
  f.viewport.scale = 1.5;
  f.viewport.dispatchEvent(new Event("resize"));
  f.flush();
  assert.equal(f.properties.size, 0);
  f.viewport.scale = 1;
  f.narrow.matches = false;
  f.narrow.dispatchEvent(new Event("change"));
  f.flush();
  assert.equal(f.properties.size, 0);
  f.narrow.matches = true;
  f.viewport.dispatchEvent(new Event("resize"));
  assert.equal(f.frames.size, 1);
  cleanup();
  f.flush();
  f.viewport.dispatchEvent(new Event("resize"));
  assert.equal(f.frames.size, 0);
  assert.equal(f.properties.size, 0);
});

function touch(panel, type, x, y, time, { ignored = false, fingers = 1 } = {}) {
  const event = new Event(type, { cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : Array(fingers).fill(point) },
    changedTouches: { value: [point] }, timeStamp: { value: time },
    target: { value: { closest: () => ignored ? {} : null } },
  });
  panel.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
}

test("a deliberate right swipe from the left edge returns once using the existing close action", () => {
  const f = fixture(); let closes = 0;
  const cleanup = bindInspectorSwipe(f.panel, () => closes++, f.browser);
  touch(f.panel, "touchstart", 20, 250, 0);
  touch(f.panel, "touchmove", 120, 254, 100);
  touch(f.panel, "touchend", 170, 260, 220);
  assert.equal(closes, 1);
  touch(f.panel, "touchend", 100, 260, 250);
  assert.equal(closes, 1);
  cleanup();
  touch(f.panel, "touchstart", 20, 250, 0);
  touch(f.panel, "touchend", 170, 250, 200);
  assert.equal(closes, 1);
});

test("scrolling, code/table/input gestures, selection and multitouch never close a task", () => {
  const f = fixture(); let closes = 0;
  const cleanup = bindInspectorSwipe(f.panel, () => closes++, f.browser);
  for (const scenario of [
    { x: 50, y: 250, time: 200 },
    { x: -90, y: 250, time: 200 },
    { x: 390, y: 250, time: 200, startX: 200 },
    { x: 170, y: 250, time: 1000 },
    { x: 170, y: 250, time: 200, ignored: true },
    { x: 170, y: 250, time: 200, fingers: 2 },
  ]) {
    touch(f.panel, "touchstart", scenario.startX ?? 20, 250, 0, scenario);
    touch(f.panel, "touchend", scenario.x, scenario.y, scenario.time);
  }
  touch(f.panel, "touchstart", 20, 250, 0);
  touch(f.panel, "touchmove", 22, 290, 100);
  touch(f.panel, "touchend", 170, 280, 200);
  f.browser.getSelection = () => ({ isCollapsed: false });
  touch(f.panel, "touchstart", 20, 250, 0);
  touch(f.panel, "touchend", 170, 250, 200);
  assert.equal(closes, 0);
  cleanup();
});

test("submitting from the keyboard keeps its layout until the viewport recovers", () => {
  const f = fixture();const cleanup = bindInspectorViewport(f.panel,f.browser);
  f.document.activeElement=f.input;f.viewport.height=390;f.document.dispatchEvent(new Event('focusin'));f.flush();
  assert.equal(f.attributes.has('data-keyboard-open'),true);
  f.document.activeElement=null;f.document.dispatchEvent(new Event('focusout'));f.flush();
  assert.equal(f.attributes.has('data-keyboard-open'),true);
  f.viewport.height=780;f.viewport.dispatchEvent(new Event('resize'));f.flush();
  assert.equal(f.attributes.has('data-keyboard-open'),false);cleanup();
});

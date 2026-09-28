import test from "node:test";
import assert from "node:assert/strict";
import { bindInspectorSwipe, bindInspectorViewport } from "../src/mobileInspector.ts";

function fixture() {
  const panel = new EventTarget(), browser = new EventTarget();
  const viewport = Object.assign(new EventTarget(), { height: 780, offsetTop: 0, scale: 1 });
  const narrow = Object.assign(new EventTarget(), { matches: true });
  const document = Object.assign(new EventTarget(), { activeElement: null });
  const properties = new Map(), attributes = new Set(), frames = new Map();
  let nextFrame = 0;
  panel.style = { setProperty: (key, value) => properties.set(key, value), removeProperty: key => properties.delete(key) };
  panel.toggleAttribute = (key, value) => value ? attributes.add(key) : attributes.delete(key);
  panel.removeAttribute = key => attributes.delete(key);
  panel.getBoundingClientRect = () => ({ left: 0 });
  const input = { matches: () => true };
  panel.contains = target => target === input;
  Object.assign(browser, {
    document, visualViewport: viewport, innerHeight: 780,
    matchMedia: () => narrow, getSelection: () => ({ isCollapsed: true }),
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  const flush = () => { for (const [id, callback] of frames) { frames.delete(id); callback(); } };
  return { panel, browser, viewport, document, narrow, properties, attributes, frames, input, flush };
}

test("first focus follows the later keyboard resize and Safari viewport pan", () => {
  const f = fixture();
  const cleanup = bindInspectorViewport(f.panel, f.browser);
  assert.equal(f.properties.get("--inspector-viewport-height"), "780px");
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
  assert.equal(f.properties.get("--inspector-viewport-height"), "780px");
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

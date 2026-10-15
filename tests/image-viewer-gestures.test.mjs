import test from 'node:test';
import assert from 'node:assert/strict';
import { bindImageGestures, clampImageTransform, fitImage, imageIdentity, IMAGE_ZOOM_MAX, zoomImage } from '../src/imageViewerGestures.ts';

const bounds = { width: 300, height: 400, imageWidth: 300, imageHeight: 300, centerX: 200, centerY: 250 };
class Stage extends EventTarget {
  listeners = [];
  captures = new Set();
  addEventListener(type, fn, options) { super.addEventListener(type, fn, options); this.listeners.push({ type, fn }); }
  removeEventListener(type, fn, options) { super.removeEventListener(type, fn, options); this.listeners = this.listeners.filter(item => item.type !== type || item.fn !== fn); }
  setPointerCapture(id) { this.captures.add(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
  fire(type, fields = {}) { const event = new Event(type, { cancelable: true }); Object.defineProperty(event, 'timeStamp', { value: fields.at ?? 0 });
    if (fields.target) Object.defineProperty(event, 'target', { value: fields.target });
    Object.assign(event, { pointerId: 1, button: 0, clientX: 200, clientY: 250, ...Object.fromEntries(Object.entries(fields).filter(([key]) => !['target', 'at'].includes(key))) }); this.dispatchEvent(event); return event; }
}
function fixture() {
  const stage = new Stage(); let value = imageIdentity(), ready = true, closed = 0;
  const updates = [];
  const stop = bindImageGestures(stage, { bounds: () => bounds, get: () => value, set: next => { value = next; updates.push(next); }, ready: () => ready, close: () => closed++ });
  return { stage, stop, updates, get value() { return value; }, set value(next) { value = next; }, get closed() { return closed; }, ready: next => { ready = next; } };
}

test('contain fit preserves aspect ratio, does not upscale small images and rejects unavailable geometry', () => {
  assert.deepEqual(fitImage({ width: 4000, height: 2000 }, bounds), { width: 300, height: 150 });
  assert.deepEqual(fitImage({ width: 100, height: 100 }, bounds), { width: 100, height: 100 });
  for (const value of [0, -1, NaN, Infinity]) assert.deepEqual(fitImage({ width: value, height: 200 }, bounds), { width: 0, height: 0 });
});
test('zoom retains the inspected anchor and clamps pan to reachable image edges', () => {
  assert.deepEqual(zoomImage({ scale: 2, x: 30, y: 20 }, 3, { x: 40, y: 50 }, bounds), { scale: 3, x: 25, y: 5 });
  assert.deepEqual(clampImageTransform({ scale: 2, x: 9999, y: -9999 }, bounds), { scale: 2, x: 150, y: -100 });
  assert.deepEqual(zoomImage({ scale: 3, x: 80, y: 90 }, 1, { x: 60, y: 60 }, bounds), imageIdentity());
  assert.equal(clampImageTransform({ scale: 100, x: 0, y: 0 }, bounds).scale, IMAGE_ZOOM_MAX);
});
test('double click or double tap on the image zooms in then resets without closing', () => {
  const f = fixture();
  for (const at of [0, 150]) { f.stage.fire('pointerdown', { at }); f.stage.fire('pointerup', { at: at + 40 }); }
  assert.equal(f.value.scale, 2.5); assert.equal(f.closed, 0);
  for (const at of [500, 650]) { f.stage.fire('pointerdown', { at }); f.stage.fire('pointerup', { at: at + 40 }); }
  assert.deepEqual(f.value, imageIdentity()); assert.equal(f.closed, 0); f.stop();
});
test('only a short unmoved background tap closes, while controls and image taps stay open', () => {
  const f = fixture();
  f.stage.fire('pointerdown', { at: 0 }); f.stage.fire('pointerup', { at: 80 }); assert.equal(f.closed, 0);
  const control = { closest: () => ({}) };
  f.stage.fire('pointerdown', { target: control, clientX: 20, clientY: 20, at: 200 }); f.stage.fire('pointerup', { clientX: 20, clientY: 20, at: 250 }); assert.equal(f.closed, 0);
  f.stage.fire('pointerdown', { clientX: 20, clientY: 20, at: 400 }); f.stage.fire('pointerup', { clientX: 20, clientY: 20, at: 450 }); assert.equal(f.closed, 1); f.stop();
});
test('background dragging, long press, cancelled input and loading image movement never close', () => {
  for (const mode of ['drag', 'long', 'cancel', 'loading-drag']) {
    const f = fixture(); if (mode === 'loading-drag') f.ready(false);
    f.stage.fire('pointerdown', { clientX: 20, clientY: 20, at: 0 });
    if (mode.includes('drag')) f.stage.fire('pointermove', { clientX: 40, clientY: 20, at: 50 });
    f.stage.fire(mode === 'cancel' ? 'pointercancel' : 'pointerup', { clientX: mode.includes('drag') ? 40 : 20, clientY: 20, at: mode === 'long' ? 600 : 90 });
    assert.equal(f.closed, 0, mode); f.stop();
  }
});
test('a zoomed image follows one-finger drag and releases capture without a backdrop close', () => {
  const f = fixture(); f.value = { scale: 2.5, x: 0, y: 0 };
  f.stage.fire('pointerdown', { at: 0 }); f.stage.fire('pointermove', { clientX: 240, clientY: 280, at: 40 });
  assert.deepEqual(f.value, { scale: 2.5, x: 40, y: 30 });
  f.stage.fire('pointerup', { clientX: 240, clientY: 280, at: 80 }); assert.equal(f.closed, 0); assert.equal(f.stage.captures.size, 0); f.stop();
});
test('pinch zoom tracks distance and centroid, then remaining finger can pan without closing', () => {
  const f = fixture();
  f.stage.fire('pointerdown', { pointerId: 1, clientX: 140, at: 0 });
  f.stage.fire('pointerdown', { pointerId: 2, clientX: 260, at: 10 });
  f.stage.fire('pointermove', { pointerId: 2, clientX: 320, at: 30 });
  assert.equal(f.value.scale, 1.5); assert.equal(f.value.x, 30);
  f.stage.fire('pointermove', { pointerId: 1, clientX: 80, at: 50 });
  assert.equal(f.value.scale, 2); assert.equal(f.value.x, 0);
  f.stage.fire('pointerup', { pointerId: 2, clientX: 320, at: 70 });
  f.stage.fire('pointermove', { pointerId: 1, clientX: 100, at: 90 }); assert.equal(f.value.x, 20);
  f.stage.fire('pointerup', { pointerId: 1, clientX: 100, at: 110 }); assert.equal(f.closed, 0); f.stop();
});
test('wheel zoom prevents page scroll, while unavailable images do not acquire a transform', () => {
  const f = fixture();
  const wheel = f.stage.fire('wheel', { deltaY: -120, deltaMode: 0 });
  assert.equal(wheel.defaultPrevented, true); assert.ok(f.value.scale > 1);
  f.ready(false); const before = f.value; f.stage.fire('wheel', { deltaY: 300, deltaMode: 0 }); assert.equal(f.value, before);
  f.stop(); assert.equal(f.stage.listeners.length, 0);
});

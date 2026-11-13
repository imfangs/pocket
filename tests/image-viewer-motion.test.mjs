import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageViewerMotion, decodedViewerImage } from '../src/imageViewerMotion.ts';

function fixture({ reduced = false, hidden = false, animate = true } = {}) {
  const media = Object.assign(new EventTarget(), { matches: reduced }), doc = Object.assign(new EventTarget(), { hidden });
  const calls = [], dataset = {};
  const element = { ownerDocument: doc, isConnected: true, dataset, removeAttribute(name) { if (name === 'data-image-motion') delete dataset.imageMotion; } };
  const browser = { matchMedia: () => media }; doc.defaultView = browser;
  if (animate) element.animate = (frames, options) => {
    const animation = { cancelled: false, onfinish: null, oncancel: null, cancel() { this.cancelled = true; this.oncancel?.(); } };
    calls.push({ frames, options, animation }); return animation;
  };
  const motion = createImageViewerMotion(element, browser);
  return { media, doc, element, calls, motion };
}

test('opening fades only the image surface for the existing 180ms content duration', () => {
  const f = fixture(); f.motion.play('open');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.duration, 180);
  assert.deepEqual(f.calls[0].frames, [{ opacity: .45 }, { opacity: 1 }]);
  assert.equal(f.element.dataset.imageMotion, 'open'); f.calls[0].animation.onfinish();
  assert.equal(f.element.dataset.imageMotion, undefined); f.motion.dispose();
});
test('gallery movement conveys either direction without changing gesture-owned image transforms', () => {
  const f = fixture(); f.motion.play('next');
  assert.equal(f.calls[0].options.duration, 180); assert.match(f.calls[0].frames[0].transform, /10px/);
  f.motion.play('previous'); assert.equal(f.calls[0].animation.cancelled, true);
  assert.match(f.calls[1].frames[0].transform, /-10px/); assert.equal(f.element.dataset.imageMotion, 'previous');
  f.motion.cancel(); assert.equal(f.calls[1].animation.cancelled, true); assert.equal(f.element.dataset.imageMotion, undefined);
  f.motion.dispose();
});
test('a stale completion cannot remove a replacement motion and interaction cancels synchronously', () => {
  const f = fixture(); f.motion.play('open'); const stale = f.calls[0].animation.onfinish;
  f.motion.play('next'); stale(); assert.equal(f.element.dataset.imageMotion, 'next');
  f.motion.cancel(); assert.equal(f.element.dataset.imageMotion, undefined); f.motion.dispose();
});
test('reduced motion skips entry and a changed preference cancels an active effect', () => {
  const f = fixture({ reduced: true }); f.motion.play('open'); assert.equal(f.calls.length, 0);
  f.media.matches = false; f.motion.play('next'); assert.equal(f.calls.length, 1);
  f.media.matches = true; f.media.dispatchEvent(new Event('change'));
  assert.equal(f.calls[0].animation.cancelled, true); assert.equal(f.element.dataset.imageMotion, undefined); f.motion.dispose();
});
test('hidden, detached and unsupported image surfaces do not start animations', () => {
  const hidden = fixture({ hidden: true }); hidden.motion.play('open'); assert.equal(hidden.calls.length, 0); hidden.motion.dispose();
  const detached = fixture(); detached.element.isConnected = false; detached.motion.play('next'); assert.equal(detached.calls.length, 0); detached.motion.dispose();
  const unsupported = fixture({ animate: false }); assert.doesNotThrow(() => unsupported.motion.play('open')); unsupported.motion.dispose();
});
test('backgrounding and disposal cancel their effect and future events cannot revive it', () => {
  const f = fixture(); f.motion.play('next'); f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.calls[0].animation.cancelled, true);
  f.doc.hidden = false; f.motion.play('previous'); f.motion.dispose(); assert.equal(f.calls[1].animation.cancelled, true);
  f.motion.play('open'); f.media.dispatchEvent(new Event('change')); assert.equal(f.calls.length, 2);
});
test('a platform animation failure leaves the same image usable with no residual motion marker', () => {
  const f = fixture(); f.element.animate = () => { throw new Error('Unsupported platform effect'); };
  assert.doesNotThrow(() => f.motion.play('open')); assert.equal(f.element.dataset.imageMotion, undefined); f.motion.dispose();
});
test('candidate promotion waits for decode and returns actual natural dimensions', async () => {
  let release, finished = false;
  const image = { naturalWidth: 1200, naturalHeight: 800, decode: () => new Promise(done => { release = done; }) };
  const pending = decodedViewerImage(image, () => true).then(value => { finished = true; return value; });
  assert.equal(finished, false); release(); assert.deepEqual(await pending, { width: 1200, height: 800 });
});
test('late decode after navigation or close cannot promote the old candidate', async () => {
  let release, current = true;
  const pending = decodedViewerImage({ naturalWidth: 1200, naturalHeight: 800, decode: () => new Promise(done => { release = done; }) }, () => current);
  current = false; release(); assert.equal(await pending, null);
  let decoded = false;
  assert.equal(await decodedViewerImage({ decode() { decoded = true; } }, () => false), null); assert.equal(decoded, false);
});
test('decode errors and zero dimensions remain failures instead of showing a blank new image', async () => {
  await assert.rejects(decodedViewerImage({ naturalWidth: 0, naturalHeight: 0 }, () => true), /decode/);
  await assert.rejects(decodedViewerImage({ decode: async () => { throw new Error('Encoding failed'); } }, () => true), /Encoding/);
});

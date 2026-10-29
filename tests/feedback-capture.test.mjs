import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedbackImage } from '../packages/feedback-kit/browser/capture.ts';
import { annotationRectangle, toFeedbackImage } from '../packages/feedback-kit/browser/annotations.ts';

test('normalized rectangle maps to original pixel coordinates without browser layout dependence', () => {
  assert.deepEqual(annotationRectangle({ x: .1, y: .25, width: .5, height: .125 }, 1000, 2000), { x: 100, y: 500, width: 500, height: 250 });
});
test('replayed invalid annotations fail rather than marking another part of the image', () => {
  for (const rect of [{x:NaN,y:0,width:.5,height:.5},{x:-.1,y:0,width:.5,height:.5},{x:.8,y:0,width:.5,height:.5},{x:0,y:0,width:0,height:.5}])
    assert.throws(() => annotationRectangle(rect, 500, 500), error => error.code === 'annotation_bounds');
});
test('non-raster and malformed input is rejected before a decoder or object URL is created', async () => {
  for (const blob of [new Blob(['<svg/>'],{type:'image/svg+xml'}),new Blob(['not PNG'],{type:'image/png'}),new Blob([],{type:'image/jpeg'})])
    await assert.rejects(normalizeFeedbackImage(blob), error => ['image_format','image_dimensions'].includes(error.code));
});
test('oversized dimensions fail before allocating decoded image pixels', async () => {
  const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]); const data = new DataView(bytes.buffer); data.setUint32(16, 60000); data.setUint32(20, 60000);
  await assert.rejects(normalizeFeedbackImage(new Blob([bytes],{type:'image/png'})), error => error.code === 'image_dimensions');
});
test('cancelled normalization does not start a decode', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(normalizeFeedbackImage(new Blob(['x'],{type:'image/png'}),controller.signal), error => error.name === 'AbortError');
});
test('wire output rejects mismatched MIME before base64 serialization', async () => {
  await assert.rejects(toFeedbackImage({blob:new Blob(['x'],{type:'image/svg+xml'}),mime:'image/png',width:1,height:1},'original'), error => error.code === 'image_format');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createImagePreviewRegistry, imagePreviewGallery, isImagePreviewForScope, maxImagePreviewItems } from '../src/imagePreviewGallery.ts';

const scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const image = (index, thread = scope) => ({ src: `/api/tasks/${thread}/images/${index.toString(16).padStart(64, '0')}`, alt: `Image ${index}` });
const attachment = { src: `/api/tasks/${scope}/attachments/cccccccc-cccc-4ccc-8ccc-cccccccccccc`, alt: 'Attachment' };
const fileImage = { src: `/api/tasks/${scope}/files/${'d'.repeat(64)}/image`, alt: 'File image' };

test('gallery accepts only canonical images and original attachment capabilities in its own thread', () => {
  const valid = [image(1), attachment, fileImage];
  const forbidden = [image(2, other),
    { src: image(2).src + '?preview=1', alt: 'Preview' },
    { src: image(2).src.replace('/images/', '/files/'), alt: 'Ordinary file' },
    { src: '/api/machines/wandou' + image(2).src.slice(4), alt: 'Machine transport path' },
    { src: 'https://outside.invalid' + image(2).src, alt: 'External' },
    { src: '/Users/synthetic/figure.png', alt: 'Raw path' },
    { src: 'data:image/svg+xml;base64,PHN2Zz4=', alt: 'Diagram' },
    { src: image(2).src + '#fragment', alt: 'Fragment' }];
  forbidden.push(...[fileImage.src.replace('/image', ''), fileImage.src + '?preview=1', fileImage.src + '#image', fileImage.src.replace('/image', '/video'),
    fileImage.src.replace('/image', '/preview'), fileImage.src.replace(scope, other)].map(src => ({ src, alt: 'Unissued file view' })));
  assert.deepEqual(imagePreviewGallery(scope, [...valid, ...forbidden], image(1)), valid);
  for (const item of forbidden) {
    assert.equal(isImagePreviewForScope(item.src, scope), false);
    assert.deepEqual(imagePreviewGallery(scope, valid, item), []);
  }
});

test('gallery preserves reading order, deduplicates capabilities and freezes an independent open snapshot', () => {
  const first = image(1), second = image(2), third = image(3);
  const source = [first, second, { ...first, alt: 'Repeated image' }, attachment, third];
  const clicked = { ...second, alt: 'Clicked description' };
  const gallery = imagePreviewGallery(scope, source, clicked);
  assert.deepEqual(gallery, [first, clicked, attachment, third]);
  assert.ok(Object.isFrozen(gallery));
  assert.ok(gallery.every(Object.isFrozen));
  source.reverse(); first.src = image(20).src; second.alt = 'Reconciled'; clicked.alt = 'Changed after opening';
  assert.deepEqual(gallery.map(item => item.src), [image(1).src, image(2).src, attachment.src, image(3).src]);
  assert.equal(gallery[1].alt, 'Clicked description');
});

test('bounded gallery retains the clicked image and adjacent reading order even near either end', () => {
  const candidates = Array.from({ length: 90 }, (_, index) => image(index));
  for (const index of [0, 1, 15, 16, 31, 32, 61, 88, 89]) {
    const gallery = imagePreviewGallery(scope, candidates, candidates[index]);
    assert.equal(gallery.length, maxImagePreviewItems);
    assert.ok(gallery.some(item => item.src === candidates[index].src));
    const start = candidates.findIndex(item => item.src === gallery[0].src);
    assert.deepEqual(gallery, candidates.slice(start, start + maxImagePreviewItems));
  }
});

test('a clicked capability survives removal from the latest source manifest without adopting other threads', () => {
  assert.deepEqual(imagePreviewGallery(scope, [image(1), image(2, other)], image(3)), [image(1), image(3)]);
  assert.deepEqual(imagePreviewGallery(scope, [], image(3)), [image(3)]);
});

function element(position, ownerDocument, connected = true) {
  return {
    position, ownerDocument, isConnected: connected,
    compareDocumentPosition(otherElement) { return otherElement.position > this.position ? 4 : otherElement.position < this.position ? 2 : 0; },
    getAttribute() { throw new Error('DOM attributes must not grant capabilities'); },
  };
}

test('a group reads mounted source registrations in DOM order without inspecting source attributes', () => {
  const ownerDocument = {}, opener = element(2, ownerDocument), registry = createImagePreviewRegistry();
  registry.register(element(3, ownerDocument), attachment);
  registry.register(element(1, ownerDocument), image(1));
  registry.register(element(2, ownerDocument), image(2));
  registry.register(element(4, ownerDocument, false), image(4));
  registry.register(element(0, {}), image(5));
  assert.deepEqual(registry.snapshot(opener), [image(1), image(2), attachment]);
});

test('ref replacement, replay and unmount cleanly retire registrations without deleting a newer one', () => {
  const ownerDocument = {}, node = element(1, ownerDocument), registry = createImagePreviewRegistry();
  const cleanup = registry.register(node, image(1));
  cleanup(); assert.deepEqual(registry.snapshot(node), []);
  const replayCleanup = registry.register(node, image(1));
  const replacementCleanup = registry.register(node, image(2));
  replayCleanup(); assert.deepEqual(registry.snapshot(node), [image(2)]);
  replacementCleanup(); assert.deepEqual(registry.snapshot(node), []);
});

test('separate message and standalone attachment groups cannot collect adjacent message images', () => {
  const ownerDocument = {}, node = element(1, ownerDocument);
  const first = createImagePreviewRegistry(), second = createImagePreviewRegistry();
  first.register(node, image(1)); second.register(element(2, ownerDocument), image(2));
  assert.deepEqual(first.snapshot(node), [image(1)]);
  assert.deepEqual(second.snapshot(node), [image(2)]);
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: Provider, ImagePreviewGroup }, { default: Message }, { default: AttachmentList }] = await Promise.all([
  vite.ssrLoadModule('/src/ImagePreviewProvider.tsx'), vite.ssrLoadModule('/src/ConversationMessage.tsx'), vite.ssrLoadModule('/src/AttachmentList.tsx'),
]);
after(() => vite.close());
const scope = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const imageSrc = `/api/tasks/${scope}/images/${'f'.repeat(64)}`;
const uploadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const upload = { id: uploadId, name: 'Attached original.png', kind: 'image', mime: 'image/png', size: 10, sha256: 'f'.repeat(64),
  url: `/api/tasks/${scope}/attachments/${uploadId}`, previewUrl: `/api/tasks/${scope}/attachments/${uploadId}?preview=1` };
const render = children => renderToStaticMarkup(createElement(Provider, { scope }, children));

test('message image grouping renders on the server without a document or an extra layout wrapper', () => {
  assert.equal(typeof document, 'undefined');
  const message = { id: 'combined-message', role: 'assistant', phase: 'final', text: '![Body image](/synthetic/body.png)\n\n[Reference](https://example.invalid/reference)',
    images: { '/synthetic/body.png': imageSrc }, attachments: [upload] };
  const html = render(createElement(Message, { message, threadId: scope }));
  assert.match(html, /^<article\b/);
  assert.match(html, /<\/article>$/);
  assert.match(html, /aria-label="查看大图：Body image"/);
  assert.match(html, /aria-label="查看大图：Attached original.png"/);
  assert.ok(html.includes(`data-registered-source="${imageSrc}"`));
  assert.ok(html.includes(`data-attachment-id="${uploadId}"`));
  assert.match(html, /class="attachment-placeholder" aria-hidden="true"/);
  assert.doesNotMatch(html, /<img\b|<link\b|\ssrc=/, 'SSR does not start private body or attachment image reads');
  assert.doesNotMatch(html, /<dialog\b|data-reading-overlay|data-image-preview-group/);
  assert.ok(html.indexOf('Body image') < html.indexOf(`data-attachment-id="${uploadId}"`));
});

test('a registered image file joins the message boundary as a compact card without reading its image view during SSR', () => {
  const path = '/synthetic/page-preview.jpg', file = { url: `/api/tasks/${scope}/files/${'e'.repeat(64)}`, name: 'page-preview.jpg' };
  const html = render(createElement(Message, { threadId: scope, message: { id: 'body-file-attachment', role: 'assistant', phase: 'final',
    text: `![Body image](/synthetic/body.png)\n\n[Page preview](${path})`, images: { '/synthetic/body.png': imageSrc },
    files: { [path]: file }, attachments: [upload] } }));
  assert.match(html, /^<article\b/); assert.match(html, /<\/article>$/);
  assert.match(html, /message-file-image-actions/);
  assert.match(html, /aria-label="预览文件：page-preview.jpg"/);
  assert.match(html, /aria-label="下载文件：page-preview.jpg"/);
  assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, 3);
  assert.equal((html.match(/data-registered-source=/g) ?? []).length, 1, 'The body keeps its canonical image grant for the lazy reader');
  assert.match(html, /class="attachment-placeholder" aria-hidden="true"/);
  assert.doesNotMatch(html, /<img\b|<link\b|\ssrc=/, 'Image views wait for authenticated client reads');
  assert.doesNotMatch(html, /\/files\/[a-f0-9]{64}\/image|\/synthetic\/|<dialog\b/);
  assert.ok(html.indexOf('Body image') < html.indexOf('page-preview.jpg'));
  assert.ok(html.indexOf('page-preview.jpg') < html.indexOf(`data-attachment-id="${uploadId}"`));
});

test('standalone attachment fallback and an existing message group preserve the same attachment DOM', () => {
  const file = { ...upload, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'notes.txt', kind: 'file', mime: 'text/plain',
    url: `/api/tasks/${scope}/attachments/cccccccc-cccc-4ccc-8ccc-cccccccccccc`, previewUrl: undefined };
  const cards = createElement(AttachmentList, { attachments: [upload, file] });
  const standalone = render(cards), nested = render(createElement(ImagePreviewGroup, {}, cards));
  assert.equal(standalone, nested);
  assert.match(standalone, /^<div class="attachment-list"/);
  assert.match(standalone, /download="notes.txt"/);
  assert.equal((standalone.match(/aria-haspopup="dialog"/g) ?? []).length, 1);
  assert.equal(render(createElement(AttachmentList, { attachments: [] })), '');
});

test('groups do not add image controls for remote links, raw paths, ordinary files or diagrams during SSR', () => {
  const html = render(createElement(Message, { threadId: scope, message: { id: 'unregistered', role: 'assistant',
    text: '![Remote](https://outside.invalid/image.png)\n\n![Raw](/synthetic/unregistered.png)\n\n```mermaid\ngraph TD; A-->B\n```',
    attachments: [{ ...upload, kind: 'file', name: 'archive.png', previewUrl: undefined }] } }));
  assert.doesNotMatch(html, /aria-haspopup="dialog"/);
  assert.match(html, /download="archive.png"/);
  assert.match(html, /href="https:\/\/outside.invalid\/image.png"/);
  assert.doesNotMatch(html, /<img\b|<dialog\b/);
});

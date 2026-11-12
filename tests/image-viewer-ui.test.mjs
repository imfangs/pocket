import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: MessageImage }, { default: MessageMarkdown }, { default: AttachmentList }] = await Promise.all([
  vite.ssrLoadModule('/src/MessageImage.tsx'), vite.ssrLoadModule('/src/MessageMarkdown.tsx'), vite.ssrLoadModule('/src/AttachmentList.tsx'),
]);
after(() => vite.close());
const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const imageUrl = `/api/tasks/${id}/images/${'b'.repeat(64)}`;
const attachmentUrl = `/api/tasks/${id}/attachments/cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
const attachment = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: '合成图片.png', size: 4000, mime: 'image/png', kind: 'image', sha256: 'a'.repeat(64), url: attachmentUrl, previewUrl: `${attachmentUrl}?preview=1` };
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

test('a conversation image has an accessible same-page button rather than a raw image tab', () => {
  const html = render(MessageImage, { src: imageUrl, alt: '合成示意图' });
  assert.match(html, /<button\b[^>]*aria-label="查看大图：合成示意图"/);
  assert.doesNotMatch(html, /<a\b|target="_blank"/);
  assert.ok(html.includes(`data-registered-source="${imageUrl}"`));
  assert.match(html, /class="message-image-frame" aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<img\b|<link\b|\ssrc=/, 'SSR waits for the authenticated lazy reader before creating an image request');
});

test('registered Markdown images use the viewer button while ordinary web links keep their navigation semantics', () => {
  const html = render(MessageMarkdown, { text: '![图示](/synthetic/figure.png)\n\n[参考资料](https://example.org/reference)', images: { '/synthetic/figure.png': imageUrl } });
  assert.match(html, /<button\b[^>]*aria-label="查看大图：图示"/);
  assert.match(html, /<a href="https:\/\/example.org\/reference" target="_blank"/);
});

test('an image attachment retains an accessible preview placeholder without fetching private pixels during SSR', () => {
  const html = render(AttachmentList, { attachments: [attachment] });
  assert.match(html, /<button\b/);
  assert.match(html, /aria-label="[^"]*合成图片.png"/);
  assert.ok(html.includes(`data-attachment-id="${attachment.id}"`));
  assert.match(html, /class="attachment-placeholder" aria-hidden="true"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<img\b|<link\b|\ssrc=/);
  assert.doesNotMatch(html, /<a\b|href=|target="_blank"/);
});

test('ordinary file attachments retain their original download link rather than image controls', () => {
  const file = { ...attachment, name: '合成说明.txt', kind: 'file', mime: 'text/plain', previewUrl: undefined };
  const html = render(AttachmentList, { attachments: [file] });
  assert.ok(html.includes(`href="${attachmentUrl}"`));
  assert.match(html, /download="合成说明.txt"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<button\b|<img\b/);
});

test('unregistered or external image locations cannot become automatic private image viewers', () => {
  for (const url of ['https://example.org/private.png', 'javascript:alert(1)', 'blob:private']) {
    const html = render(AttachmentList, { attachments: [{ ...attachment, url, previewUrl: undefined }] });
    assert.match(html, /合成图片.png/);
    assert.doesNotMatch(html, /<a\b|<button\b|<img\b/);
  }
  const external = render(MessageMarkdown, { text: '![远程图片](https://example.org/remote.png)' });
  assert.doesNotMatch(external, /<button\b|<img\b/);
  assert.match(external, /查看图片/);
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
  esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
const { default: MessageFile } = await vite.ssrLoadModule('/src/MessageFile.tsx');
after(() => vite.close());
const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const url = `/api/tasks/${id}/files/${'b'.repeat(64)}`;
const render = name => renderToStaticMarkup(createElement(MessageFile, { file: { name, url }, threadId: id }));

test('PDF, audio, SVG, modern Office and ZIP keep compact preview cards with accessible modal actions', () => {
  for (const name of ['note.pdf', 'clip.wav', 'drawing.svg', 'notes.docx', 'cells.xlsx', 'slides.pptx', 'package.zip']) {
    const html = render(name);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.match(html, /aria-label="预览文件：/);
    assert.match(html, /message-file-action">查看/);
    assert.doesNotMatch(html, /<dialog|<canvas|<audio|<iframe/);
  }
});

test('legacy and unknown binary files retain download while forged references never become preview sources', () => {
  for (const name of ['old.doc', 'database.sqlite', 'program.exe']) {
    assert.match(render(name), /aria-label="下载文件：/);
    assert.doesNotMatch(render(name), /aria-haspopup="dialog"/);
  }
  for (const invalid of ['https://example.org/note.pdf', '/private/note.pdf', url + '?extra=1']) {
    const html = renderToStaticMarkup(createElement(MessageFile, { file: { name: 'note.pdf', url: invalid }, threadId: id }));
    assert.match(html, /文件保存在电脑上/);
    assert.doesNotMatch(html, /<button|<a|<iframe/);
  }
});

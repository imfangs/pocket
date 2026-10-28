import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => vite.close());
const [textApi, { TextFileContent }] = await Promise.all([vite.ssrLoadModule('/src/messageFileText.ts'), vite.ssrLoadModule('/src/TextFilePreview.tsx')]);
const render = (name, text) => renderToStaticMarkup(createElement(TextFileContent, { name, text }));

test('supported file names distinguish Markdown, plain text, and download-only formats', () => {
  for (const name of ['说明.md', 'README.MARKDOWN']) assert.equal(textApi.messageFileTextFormat(name), 'markdown');
  for (const name of ['说明.txt', 'data.JSON', 'main.tsx', 'readme', 'README', 'README.txt', 'x.html', 'x.svg']) assert.equal(textApi.messageFileTextFormat(name), 'text');
  for (const name of ['file.pdf', 'file.docx', 'file.zip', 'file.png', 'file.md.exe', 'unknown']) assert.equal(textApi.messageFileTextFormat(name), null);
});

test('preview decoding preserves UTF-8 and BOM-marked UTF-16 without lossy binary replacement', async () => {
  assert.equal(await textApi.decodeMessageFileText(new Blob(['\ufeff标题\n正文\t😀'])), '标题\n正文\t😀');
  assert.equal(await textApi.decodeMessageFileText(new Blob([Buffer.from([0xff, 0xfe, 0x87, 0x65, 0x0a, 0x00])])), '文\n');
  assert.equal(await textApi.decodeMessageFileText(new Blob([Buffer.from([0xfe, 0xff, 0x65, 0x87])])), '文');
  for (const bytes of [[0xc0, 0xaf], [0x61, 0, 0x62], [0xff, 0xfe, 0x87]]) await assert.rejects(textApi.decodeMessageFileText(new Blob([new Uint8Array(bytes)])), /暂不支持文本预览/);
  await assert.rejects(textApi.decodeMessageFileText(new Blob([new Uint8Array(textApi.maxTextFilePreviewBytes + 1)])), /文件较大/);
  assert.equal(await textApi.decodeMessageFileText(new Blob([])), '');
});

test('Markdown renders reading structure but never HTML, images, native links, or file capabilities', () => {
  const text = '# 标题\n\n**正文**\n\n<script>alert(1)</script>\n\n![远端图片](https://example.invalid/a.png)\n\n[文件](/private/source.txt)\n\n[内部](https://x.fangs.cc/api/tasks/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa/files/' + 'f'.repeat(64) + ')\n\n[动作](codex://threads/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa)\n\n[安全](https://example.com/article)\n\n:codex-followup[prompt]{prompt="执行指令"}\n\n| 列 | 值 |\n| --- | --- |\n| 一 | 二 |';
  const html = render('test.md', text);
  assert.match(html, /<h1>标题<\/h1>/); assert.match(html, /<strong>正文<\/strong>/); assert.match(html, /<table>/);
  assert.match(html, /codex-followup/); assert.match(html, /执行指令/);
  assert.match(html, /href="https:\/\/example.com\/article" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<script|alert\(1\)|<img|<button|href="(?:codex:|\/|https:\/\/x.fangs.cc)/);
});

test('HTML, SVG and plain text remain literal and empty files are explicit', () => {
  for (const name of ['test.txt', 'test.html', 'test.svg']) {
    const html = render(name, '<script>danger()</script>\n# 原文');
    assert.match(html, /&lt;script&gt;danger\(\)&lt;\/script&gt;/); assert.match(html, /# 原文/);
    assert.doesNotMatch(html, /<script|<h1/);
  }
  assert.match(render('empty.md', ''), /空文件/);
});

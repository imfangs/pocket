import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => vite.close());
const [{ default: Markdown }, { default: MessageFile }, { default: Message }, video] = await Promise.all([
  vite.ssrLoadModule('/src/MessageMarkdown.tsx'), vite.ssrLoadModule('/src/MessageFile.tsx'),
  vite.ssrLoadModule('/src/ConversationMessage.tsx'), vite.ssrLoadModule('/src/MessageVideo.tsx'),
]);
const threadId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const path = '/fixture/示例 视频.mp4', file = { name: '示例 视频.mp4', url: `/api/tasks/${threadId}/files/${'f'.repeat(64)}` };
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const markdown = (text, extra = {}) => render(Markdown, { text, threadId, files: { [path]: file }, ...extra });
const count = html => (html.match(/<video\b/g) || []).length;

test('registered video links, citations and image syntax use the same native inline player', () => {
  for (const text of [`[片段](<${path}>)`, `::codex-file-citation{path="${path}"}`, `![片段](<${path}>)`]) {
    const html = markdown(text);
    assert.equal(count(html), 1);
    assert.match(html, /controls=""/); assert.match(html, /playsinline=""/i); assert.match(html, /preload="none"/);
    assert.ok(html.includes(`src="${file.url}?video=1"`));
    assert.ok(html.includes(`href="${file.url}?video=1&amp;download=1"`));
    assert.match(html, /download="示例 视频.mp4"/);
    assert.doesNotMatch(html, /autoplay|<iframe|blob:|pocket-video-reference|\/fixture\//i);
  }
});

test('all supported filename extensions keep native controls without changing ordinary files', () => {
  for (const extension of ['mp4', 'M4V', 'mov', 'webm'])
    assert.equal(count(render(MessageFile, { file: { ...file, name: `movie.${extension}` }, threadId })), 1);
  for (const name of ['movie.mp4?token', 'movie.mp4#t=1', 'notes.md', 'image.png', 'document.pdf'])
    assert.equal(count(render(MessageFile, { file: { ...file, name }, threadId })), 0);
  assert.match(render(MessageFile, { file: { ...file, name: 'notes.md' }, threadId }), /预览文件：notes.md/);
});

test('image syntax preserves its descriptive alt while downloads retain the real filename', () => {
  const html = markdown(`![原片与两种轻量处理对照](<${path}>)`);
  assert.match(html, /aria-label="视频：原片与两种轻量处理对照"/);
  assert.match(html, /class="message-video-name" title="原片与两种轻量处理对照">原片与两种轻量处理对照/);
  assert.match(html, /download="示例 视频.mp4"/);
});

test('video routes are derived only after the original file capability and thread pass validation', () => {
  for (const candidate of [null, {}, { ...file, url: file.url + '?video=1' }, { ...file, url: file.url + '#video' },
    { ...file, url: file.url.replace(threadId, other) }, { ...file, url: '/api/machines/wandou' + file.url.slice(4) },
    { ...file, url: 'https://x.fangs.cc' + file.url }, { ...file, name: '../movie.mp4' }, { ...file, name: 'movie.mp4\n' }]) {
    assert.equal(count(markdown(`![片段](<${path}>)`, { files: { [path]: candidate } })), 0);
  }
  assert.equal(count(markdown(`![片段](<${path}>)`, { threadId: other })), 0);
  assert.equal(count(markdown(`![片段](<${path}>)`, { files: Object.create({ [path]: file }) })), 0);
});

test('raw file URLs and forged internal tokens cannot borrow a registered video capability', () => {
  const text = [`![real](<${path}>)`, `![raw](${file.url})`, `[raw](${file.url})`,
    `![absolute](https://x.fangs.cc${file.url}?video=1)`, `[absolute](https://x.fangs.cc${file.url}?video=1)`,
    '![token](pocket-video-reference:0)', '[token](pocket-file-reference:0)',
    '![remote](https://example.test/movie.mp4)'].join('\n\n');
  const html = markdown(text);
  assert.equal(count(html), 1);
  assert.doesNotMatch(html, /src="https:|pocket-video-reference|pocket-file-reference/);
  assert.equal((html.match(/\?video=1/g) || []).length, 2, 'only the authorized player and its download expose video URLs');
});

test('linked video images remain labels even when the same source has a grant elsewhere', () => {
  const linked = `[![linked clip](<${path}>)](https://example.test/article)`;
  const html = markdown(`![standalone](<${path}>)\n\n${linked}`);
  assert.equal(count(html), 1);
  assert.match(html, /href="https:\/\/example.test\/article"[^>]*><span>linked clip<\/span><\/a>/);
  assert.equal(count(markdown(linked)), 0);
  assert.equal(count(markdown(linked, { files: {} })), 0);
});

test('normal image grants and code/user/truncated-message boundaries are preserved', () => {
  const image = `/api/tasks/${threadId}/images/${'e'.repeat(64)}`;
  const html = markdown('![picture](/figure.png)', { images: { '/figure.png': image } });
  assert.match(html, /查看大图：picture/); assert.ok(html.includes(`src="${image}"`)); assert.equal(count(html), 0);
  assert.equal(count(markdown('```md\n' + `![clip](<${path}>)` + '\n```')), 0);
  for (const flags of [{ role: 'user' }, { role: 'assistant', truncated: true }]) {
    assert.equal(count(render(Message, { threadId, message: { id: 'media', text: `![clip](<${path}>)`, files: { [path]: file }, ...flags } })), 0);
  }
});

test('selected-machine URLs remain canonical and do not mutate the original registration', () => {
  const original = Object.freeze({ ...file });
  for (const machine of ['ged', 'wandou']) {
    const source = video.messageVideoSource(original, threadId, machine);
    const expected = machine === 'ged' ? file.url : '/api/machines/wandou' + file.url.slice(4);
    assert.equal(source.url, expected + '?video=1');
    assert.equal(source.downloadUrl, expected + '?video=1&download=1');
    assert.equal(original.url, file.url);
  }
  assert.equal(video.messageVideoSource(original, threadId, null), null);
});

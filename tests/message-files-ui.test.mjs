import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => vite.close());
const [{ default: Markdown }, { default: Message }, { default: Questions }, filesApi, { displayMessages }] = await Promise.all([
  vite.ssrLoadModule('/src/MessageMarkdown.tsx'), vite.ssrLoadModule('/src/ConversationMessage.tsx'),
  vite.ssrLoadModule('/src/QuestionPrompts.tsx'), vite.ssrLoadModule('/src/MessageFile.tsx'), vite.ssrLoadModule('/src/transcript.ts'),
]);
const threadId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const path = '/fixture/交付 说明.pdf', file = { url: `/api/tasks/${threadId}/files/${'f'.repeat(64)}`, name: '交付 说明.pdf' };
const files = { [path]: file }, text = `[查看文件](<${path}>)`;
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
const markdown = (value = text, extra = {}) => render(Markdown, { text: value, files, threadId, ...extra });

test('registered message files render a named download control without reading or exposing the local path', () => {
  const html = markdown();
  assert.match(html, /class="message-file-button"/); assert.match(html, /aria-label="下载文件：交付 说明.pdf"/);
  assert.doesNotMatch(html, /href=|src=|rel="preload"|\/fixture\/|pocket-file-reference/);
});

test('file citations become the same registered card while unmapped citations stay readable', () => {
  const citation = `::codex-file-citation{path="${path}"}`;
  const html = markdown(citation);
  assert.match(html, /下载文件：交付 说明.pdf/); assert.doesNotMatch(html, /codex-file-citation|path=/);
  const fallback = markdown(citation, { files: {} });
  assert.match(fallback, /交付 说明.pdf/); assert.match(fallback, /文件保存在电脑上/);
  assert.doesNotMatch(fallback, /codex-file-citation|<button|href=/);
});

test('only the current thread and exact issued file route can authorize a file control', () => {
  for (const extra of [{ threadId: undefined }, { threadId: other }, { files: undefined }, { files: {} }]) {
    const html = markdown(text, extra);
    assert.match(html, /文件保存在电脑上/); assert.doesNotMatch(html, /<button|href=/);
  }
  for (const url of [file.url + '?download=1', file.url + '#file', file.url.replace(threadId, other), file.url.replace('/files/', '/images/'), file.url.replace('f'.repeat(64), 'f'.repeat(63)), '/api/machines/wandou' + file.url.slice(4), 'https://x.fangs.cc' + file.url, 'javascript:bad', '//elsewhere.example/file']) {
    const html = markdown(text, { files: { [path]: { ...file, url } } });
    assert.match(html, /文件保存在电脑上/, url); assert.doesNotMatch(html, /<button|href=/, url);
  }
});

test('forged raw, absolute and render-token URLs cannot borrow a different reference capability', () => {
  const html = markdown([text, `[raw](${file.url})`, `[absolute](https://x.fangs.cc${file.url})`, '[token](pocket-file-reference:0)', '[safe](https://example.com/article)'].join('\n\n'));
  assert.equal((html.match(/class="message-file-button"/g) ?? []).length, 1);
  assert.match(html, /href="https:\/\/example.com\/article"/);
  assert.doesNotMatch(html, /href="[^\"]*(?:\/files\/|pocket-file-reference)/);
});

test('path resolution uses own exact keys before a single Markdown percent decode', () => {
  assert.deepEqual(filesApi.registeredMessageFile('/fixture/交付%20说明.pdf', files, threadId), file);
  const exact = { ...file, name: 'literal%20name.pdf' };
  assert.deepEqual(filesApi.registeredMessageFile('/fixture/交付%20说明.pdf', { ...files, '/fixture/交付%20说明.pdf': exact }, threadId), exact);
  assert.equal(filesApi.registeredMessageFile('/fixture/交付%2520说明.pdf', files, threadId), null);
  assert.equal(filesApi.registeredMessageFile(path, Object.create(files), threadId), null);
});

test('bad names and malformed map values remain inert instead of throwing or creating a download', () => {
  for (const value of [null, {}, { ...file, name: '' }, { ...file, name: '../private.pdf' }, { ...file, name: 'bad\nname.pdf' }]) {
    assert.equal(filesApi.safeMessageFile(value, threadId), null);
    assert.doesNotMatch(markdown(text, { files: { [path]: value } }), /<button|href=/);
  }
});

test('code and user messages preserve literal file directives and do not mint file controls', () => {
  const citation = `::codex-file-citation{path="${path}"}`;
  const code = markdown('`' + citation + '`\n\n```text\n' + text + '\n```');
  assert.match(code, /codex-file-citation/); assert.doesNotMatch(code, /class="message-file-button"/);
  const user = render(Message, { threadId, message: { id: 'user', role: 'user', text: citation + '\n\n' + text, files } });
  assert.match(user, /codex-file-citation/); assert.doesNotMatch(user, /class="message-file-button"/);
});

test('assistant and question-source messages receive their signed file maps and thread identity', () => {
  const assistant = render(Message, { threadId, message: { id: 'answer', role: 'assistant', text, files } });
  assert.match(assistant, /下载文件：交付 说明.pdf/);
  const questions = render(Questions, { threadId, sourceText: '补充文件：\n\n' + text, sourceFiles: files, questions: [{ id: 'q', key: 'q', turnId: 'turn', sourceMessageId: 'question', title: '继续吗？', options: ['继续'] }], disabled: false, drafts: new Map(), refresh() {} });
  assert.match(questions, /下载文件：交付 说明.pdf/);
});

test('a question source with a file is retained even when its text equals the native question projection', () => {
  const props = { threadId, sourceText: text, questions: [{ id: 'q', key: 'q', turnId: 'turn', sourceMessageId: 'question', title: text, options: [] }], disabled: false, drafts: new Map(), refresh() {} };
  assert.doesNotMatch(render(Questions, props), /class="question-source-text"/);
  const withFile = render(Questions, { ...props, sourceFiles: files });
  assert.match(withFile, /class="question-source-text"/); assert.match(withFile, /下载文件：交付 说明.pdf/);
});

test('truncated assistant display cannot reuse a stale cached file capability', () => {
  const message = { id: 'same', role: 'assistant', text, files };
  const html = render(Message, { threadId, message: { ...message, truncated: true } });
  assert.match(html, /文件保存在电脑上/); assert.doesNotMatch(html, /class="message-file-button"/);
  const merged = displayMessages({ source: 'desktop', messages: [message] }, { messages: [{ ...message, text: text + ' longer', files: undefined, truncated: true }] });
  assert.equal(merged[0].files, undefined);
});

test('canonical transcript extensions carry file registrations while explicit empty maps revoke stale display links', () => {
  const message = { id: 'same', role: 'assistant', text: 'prefix', files };
  const live = { source: 'desktop', messages: [message] };
  for (const [next, expected] of [[{ files: { [path]: { ...file, name: 'new.pdf' } } }, 'new.pdf'], [{}, file.name], [{ files: {} }, undefined]]) {
    const result = displayMessages(live, { messages: [{ ...message, ...next, text: 'prefix extended', files: next.files }] });
    assert.equal(result[0].files?.[path]?.name, expected);
  }
  assert.equal(displayMessages(live, { messages: [{ ...message, text: 'unrelated', files: {} }] })[0].files, files);
});

test('a user gesture download uses only the selected machine, no-store, credentials and an abort signal', async () => {
  const controller = new AbortController();
  for (const machine of ['ged', 'wandou']) {
    const calls = [];
    const blob = await filesApi.fetchMessageFile(file, threadId, { machine, signal: controller.signal, request: async (url, options) => {
      calls.push({ url, options }); return new Response('fixture contents', { headers: { 'X-Pocket-Machine': machine } });
    } });
    assert.equal(await blob.text(), 'fixture contents'); assert.equal(calls.length, 1);
    assert.equal(calls[0].url, machine === 'ged' ? file.url : '/api/machines/wandou' + file.url.slice(4));
    assert.equal(calls[0].options.cache, 'no-store'); assert.equal(calls[0].options.credentials, 'same-origin');
    assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.signal, controller.signal);
  }
});

test('invalid routes never issue a request and wrong-machine responses never consume the file body', async () => {
  let calls = 0, bodies = 0;
  await assert.rejects(filesApi.fetchMessageFile({ ...file, url: file.url + '?x=1' }, threadId, { request: async () => { calls++; } }), /文件保存在电脑上/);
  assert.equal(calls, 0);
  await assert.rejects(filesApi.fetchMessageFile(file, threadId, { machine: 'wandou', request: async () => ({ headers: new Headers({ 'X-Pocket-Machine': 'ged' }), ok: true, blob: async () => { bodies++; } }) }), /电脑响应来源不匹配/);
  assert.equal(bodies, 0);
});

test('download errors explain expired login, moved files and temporary failure without exposing server details', async () => {
  for (const [status, expected] of [[401, /登录已过期/], [404, /文件已移动/], [409, /文件已更新/], [410, /文件已移动/], [413, /超过20 MiB/], [503, /下载未完成/]]) {
    await assert.rejects(filesApi.fetchMessageFile(file, threadId, { machine: 'ged', request: async () => new Response('private server detail', { status }) }), expected);
  }
});

test('declared and streaming file sizes are bounded at 20 MiB and oversized transfers are cancelled', async () => {
  const limit = filesApi.maxMessageFileBytes;
  await assert.rejects(filesApi.fetchMessageFile(file, threadId, { request: async () => new Response('unused', { headers: { 'Content-Length': String(limit + 1) } }) }), /超过20 MiB/);
  let cancelled = false, pulls = 0;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(12 * 1024 * 1024)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(filesApi.fetchMessageFile(file, threadId, { request: async () => new Response(body) }), /超过20 MiB/);
  assert.equal(cancelled, true); assert.ok(pulls <= 3);
});

test('aborting a download after the body resolves still prevents a completed download result', async () => {
  const controller = new AbortController();
  await assert.rejects(filesApi.fetchMessageFile(file, threadId, { signal: controller.signal, request: async () => ({ headers: new Headers(), ok: true, blob: async () => { controller.abort(); return new Blob(['fixture']); } }) }), error => error.name === 'AbortError');
});

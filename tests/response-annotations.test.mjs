import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { readableUserMessage } from '../src/userMessage.ts';
import { parseResponseAnnotations } from '../src/responseAnnotations.ts';

const notice = 'Each item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment. For every annotation you address, include its inline directive `:codex-annotation{index="N"}`, where N is its one-based array position (for example, `:codex-annotation{index="1"}`). Do not use unstructured annotation labels.';
const annotation = (text = '需要保留的引用原文。', extra = {}) => ({ text, source: { messageId: 'previous-answer', startOffset: 4, endOffset: 15 }, ...extra });
const envelope = (query = '它具体是什么意思？', entries = [annotation()]) => `\n# Response annotations:\n${notice}\n<response-annotations>\n${JSON.stringify(entries)}\n</response-annotations>\n\n## My request:\n${query}`;
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
const { default: Message } = await vite.ssrLoadModule('/src/ConversationMessage.tsx');
after(() => vite.close());
const render = (text, extra = {}) => renderToStaticMarkup(createElement(Message, { message: { id: 'query', role: 'user', text, ...extra }, queryDisclosure: { expanded: false, toggle() {} } }));

test('a complete annotation envelope renders the question and selected text without protocol instructions', () => {
  const raw = envelope();
  const html = render(raw);
  assert.doesNotMatch(html, /Response annotations|Each item contains|My request|response-annotations&gt;|startOffset|previous-answer/);
  assert.match(html, /它具体是什么意思？/);
  assert.match(html, /需要保留的引用原文。/);
  assert.ok(html.indexOf('它具体是什么意思？') < html.indexOf('需要保留的引用原文。'), 'the actual question comes before potentially long context');
  assert.equal(readableUserMessage(raw), '它具体是什么意思？\n\n引用：\n需要保留的引用原文。');
});

test('multiple selections and comments retain all human content in readable copying', () => {
  const raw = envelope('比较一下。', [annotation('第一处。', { comment: '这里需要解释。' }), annotation('第二处。')]);
  assert.equal(readableUserMessage(raw), '比较一下。\n\n引用 1：\n第一处。\n\n批注：\n这里需要解释。\n\n引用 2：\n第二处。');
  const html = render(raw);
  assert.match(html, /第一处。/); assert.match(html, /第二处。/); assert.match(html, /这里需要解释。/);
  assert.doesNotMatch(html, /Each item contains|startOffset|endOffset/);
});

test('quoted HTML and directive-looking text stay literal, without creating actions or markup', () => {
  const selected = '<script>alert(1)</script>\n:codex-file-citation{path="/private/file.txt"}\n[link](javascript:alert(1))';
  const html = render(envelope('解释这段。', [annotation(selected)]));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /:codex-file-citation/);
  assert.doesNotMatch(html, /<script|href="javascript|message-file-button/);
});

test('standalone headings, examples, incomplete payloads and unsupported schemas stay unchanged', () => {
  const good = envelope();
  for (const raw of [
    '# Response annotations:\nMy own title.',
    'Example:\n' + good,
    '```text\n' + good + '\n```',
    '    ' + good.trimStart().replaceAll('\n', '\n    '),
    good.replace('Each item contains', 'My custom wrapper contains'),
    good.replace('</response-annotations>', ''),
    good.replace('## My request:\n', ''),
    good.replace('## My request:', '## Other heading:'),
    good.replace('<response-annotations>', '<response-annotations source="custom">'),
    envelope('Keep this.', []),
    envelope('Keep this.', [{ text: 'known', unknownUserContent: 'must not lose me' }]),
    envelope('Keep this.', [{ text: 2 }]),
    envelope('Keep this.', [{ text: 'known', comment: ['unsupported'] }]),
    envelope('Keep this.', [{ text: 'known', source: { messageId: 'old', startOffset: -1, endOffset: 5 } }]),
  ]) assert.equal(readableUserMessage(raw), raw);
});

test('assistant messages and authored second request headings are not unwrapped', () => {
  assert.match(render(envelope(), { role: 'assistant' }), /Response annotations/);
  const query = '## My request:\nThis heading belongs to my question.\n';
  assert.ok(readableUserMessage(envelope(query)).startsWith(query));
});

test('CRLF, marker text inside a quoted selection, and annotation-only questions remain readable', () => {
  const raw = envelope('Question\r\nkeeps newlines.', [annotation('Literal </response-annotations> text')]).replaceAll(/(?<!\r)\n/g, '\r\n');
  assert.equal(readableUserMessage(raw), 'Question\r\nkeeps newlines.\n\n引用：\nLiteral </response-annotations> text');
  assert.equal(readableUserMessage(envelope('', [annotation('Only a selection', { comment: 'Only a comment' })])), '引用：\nOnly a selection\n\n批注：\nOnly a comment');
});

test('annotation parsing is bounded and never silently drops an unrecognized part of the user input', () => {
  for (const entries of [
    Array.from({ length: 33 }, () => annotation()),
    [annotation('a'.repeat(65537))],
    [annotation('quote', { comment: 'b'.repeat(65537) })],
    [annotation(), { text: 'extra', comment: { question: 'Must not disappear' } }],
    [annotation('quote', { source: { messageId: 'source', startOffset: 1.5, endOffset: 5 } })],
    [annotation('quote', { source: { messageId: 'source', startOffset: 10, endOffset: 5 } })],
  ]) {
    const raw = envelope('Keep everything.', entries);
    assert.equal(parseResponseAnnotations(raw), null);
    assert.equal(readableUserMessage(raw), raw);
  }
  const huge = envelope('q'.repeat(1024 * 1024));
  assert.equal(parseResponseAnnotations(huge), null);
  const raw = envelope('Query', Array.from({ length: 32 }, (_, n) => annotation(`Reference ${n}`)));
  assert.equal(parseResponseAnnotations(raw).annotations.length, 32);
  assert.match(readableUserMessage(raw), /Reference 31/);
});

test('more than two references keep their complete content in one initially inert group', () => {
  const html = render(envelope('Show my question first.', [annotation('one'), annotation('two'), annotation('three')]));
  assert.match(html, /展开其余 1 处引用/);
  assert.match(html, /class="annotation-more-quotes" data-expanded="false" inert=""/);
  assert.equal((html.match(/class="response-annotation"/g) || []).length, 3);
  assert.equal((html.match(/aria-label="复制这条消息"/g) || []).length, 1);
});

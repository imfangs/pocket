import test from 'node:test';
import assert from 'node:assert/strict';
import { createdThreadParts } from '../src/createdThreadParts.ts';

const first = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const second = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const directive = (id = first, prefix = '::') => `${prefix}created-thread{threadId="${id}"}`;
const cards = source => createdThreadParts(source).filter(part => part.kind === 'created-thread');
const unchanged = source => assert.deepEqual(createdThreadParts(source), [{ kind: 'markdown', text: source }], source);

test('extracts each consecutive standalone directive from the same top-level paragraph', () => {
  const source = `已创建两个任务。\n${directive()}\n${directive(second, ':')}\n稍后继续。`;
  assert.deepEqual(createdThreadParts(source), [
    { kind: 'markdown', text: '已创建两个任务。\n' },
    { kind: 'created-thread', threadId: first },
    { kind: 'markdown', text: '\n' },
    { kind: 'created-thread', threadId: second },
    { kind: 'markdown', text: '\n稍后继续。' },
  ]);
});

test('source slices preserve whitespace, CRLF, prose, references and code byte for byte', () => {
  const one = directive(), two = directive(second);
  const prefix = '前文 **强调**。[资料][shared]\r\n\r\n   ', between = '  \r\n\r\n`' + one + '`\r\n\r\n';
  const suffix = '\t\r\n\r\n```md\r\n' + one + '\r\n```\r\n\r\n[shared]: https://example.test/原文\r\n';
  const source = prefix + one + between + two + suffix;
  const parts = createdThreadParts(source);
  assert.deepEqual(parts, [
    { kind: 'markdown', text: prefix }, { kind: 'created-thread', threadId: first },
    { kind: 'markdown', text: between }, { kind: 'created-thread', threadId: second },
    { kind: 'markdown', text: suffix },
  ]);
  assert.equal(parts.map(part => part.kind === 'markdown' ? part.text : directive(part.threadId)).join(''), source);
  assert.equal(parts.filter(part => part.kind === 'markdown').map(part => part.text).join(''), prefix + between + suffix);
});

test('code, quoted and list examples retain their source rather than acquiring cards', () => {
  const item = directive();
  for (const source of [
    '`' + item + '`', '```md\n' + item + '\n```', '~~~\n' + item + '\n~~~', '```md\n' + item,
    '    ' + item, '\t' + item, '> ' + item, '> 引用\n>\n> ' + item, '> 引用\n' + item,
    '- ' + item, '1. ' + item, '- 说明\n  ' + item, '- 说明\n' + item,
    '> - ' + item, '- 说明\n\n    ' + item,
  ]) unchanged(source);
  const source = '> ' + item + '\n\n' + directive(second);
  assert.deepEqual(cards(source), [{ kind: 'created-thread', threadId: second }]);
});

test('Markdown links, destinations, labels, images and definitions never become cards', () => {
  const item = directive();
  for (const source of [
    `[${item}](https://example.test)`, `[说明](<https://example.test/${item}>)`, `[${item}][task]`,
    `[\n${item}\n](https://example.test)`, `![\n${item}\n](https://example.test/image.png)`,
    `[task]: <https://example.test/${item}>`, `[task]: https://example.test\n  "${item}"`,
    `[任务](codex://threads/${first})`, `[任务](/?task=${first})`,
  ]) unchanged(source);
});

test('raw HTML and details remain inert even when blank lines end their CommonMark HTML block', () => {
  const item = directive();
  for (const source of [
    `<div>\n${item}\n</div>`, `<div>\n\n${item}\n\n</div>`, `<div>\n\n${item}`,
    `<span>文字\n${item}\n</span>`, `<span>\n\n${item}\n\n</span>`,
    `<details><summary>任务</summary>\n\n${item}\n\n</details>`,
    `<details open><summary>任务</summary>\n\n${item}`, `<details onclick="anything"><summary>任务</summary>\n\n${item}\n</details>`,
    `<details>\n<summary>任务</summary>\n\n<div>\n\n${item}\n\n</div>\n</details>`,
    `<!--\n\n${item}\n\n-->`, `<unknown-envelope>\n\n${item}\n\n</unknown-envelope>`,
    `<oai-mem-citation>\n\n${item}\n\n</oai-mem-citation>`,
    `&lt;oai-mem-citation&gt;\n\n${item}\n\n&lt;/oai-mem-citation&gt;`,
    `&lt;citation_entries&gt;\n\n${item}`,
  ]) unchanged(source);
  const source = `<details><summary>引用</summary>\n\n${item}\n\n</details>\n\n${directive(second)}`;
  assert.deepEqual(cards(source), [{ kind: 'created-thread', threadId: second }]);
  assert.deepEqual(cards(`<br>\n\n${item}`), [{ kind: 'created-thread', threadId: first }]);
});

test('escaped, inline, labelled, incomplete, malformed, duplicate and unknown attributes stay Markdown', () => {
  const item = directive();
  for (const source of [
    '\\' + item, '\\:' + item.slice(1), ':\\:' + item.slice(2), ':' + item,
    '前文 ' + item, item + ' 后文', item + ' ' + directive(second),
    `::created-thread[label]{threadId="${first}"}`, `::created-thread{threadId="${first}"`,
    `::created-thread{threadId="${first}" threadId="${second}"}`, `::created-thread{threadId="${first}" extra="x"}`,
    `::created-thread{clientThreadId="pending-id"}`, `::created-thread{threadId="${first}" clientThreadId="pending-id"}`,
    '::created-thread{}', '::created-thread{threadId="bad-id"}', '::created-thread{threadId="../../escape"}',
    `::created-thread{threadId="${first}" trailing}`, `::created-thread{threadId="${first.slice(0, -1)}"}`,
    `::created-thread{\nthreadId="${first}"\n}`, `::created-thread{threadId="${first}\\n"}`,
    `::code-comment{title="example" body='${item}'}`, `::codex-future-view{body='${item}'}`,
  ]) unchanged(source);
});

test('colon-introduced example groups stay Markdown across adjacent directives and blank lines', () => {
  for (const separator of ['\n', '\n\n', '\r\n\r\n']) {
    for (const colon of [':', '：']) {
      const source = '格式示例' + colon + separator + directive() + separator + directive(second);
      unchanged(source);
    }
  }
  const source = '格式示例：\n\n' + directive() + '\n\n实际已经创建。\n' + directive(second);
  assert.deepEqual(cards(source), [{ kind: 'created-thread', threadId: second }]);
});

test('empty, ordinary and over-budget input use exact Markdown fallback', () => {
  unchanged(''); unchanged('普通正文。');
  const item = directive(), cap = 128 * 1024;
  const atCap = 'a'.repeat(cap - item.length - 2) + '\n\n' + item;
  assert.equal(Buffer.byteLength(atCap), cap);
  assert.equal(cards(atCap).length, 1);
  unchanged('a' + atCap);
  const unicode = '文'.repeat(50000) + '\n\n' + item;
  assert.ok(unicode.length < cap && Buffer.byteLength(unicode) > cap);
  unchanged(unicode);
});

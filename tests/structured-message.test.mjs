import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { projectStructuredMessage, structuredBodyMarkdown } from '../src/messageEnvelope.ts';
import { heartbeatMessage } from '../src/heartbeatMessage.ts';
import { subagentNotification } from '../src/subagentNotification.ts';
import { presentUserMessage } from '../src/userMessage.ts';
import { messageDetailsParts } from '../src/messageDetails.ts';
import { MessageImages } from '../server/message-images.mjs';
import { MessageFiles } from '../server/message-files.mjs';
import { readableCodexMarkdown } from '../src/codexMarkup.ts';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const imagePath = '/fixture/task/result.png', filePath = '/fixture/task/report.md';
const image = `/api/tasks/${id}/images/${'a'.repeat(64)}`, file = { name: 'report.md', url: `/api/tasks/${id}/files/${'b'.repeat(64)}` };
const heartbeat = body => `<heartbeat><automation_id>synthetic-check</automation_id><decision>NOTIFY</decision><message>${body}</message></heartbeat>`;
const child = body => `<subagent_notification>${JSON.stringify({ agent_path: '/root/synthetic', status: { completed: body } })}</subagent_notification>`;
const citation = '<oai-mem-citation><citation_entries>synthetic-hidden</citation_entries><rollout_ids>synthetic-source</rollout_ids></oai-mem-citation>';
const disclosure = body => `<details><summary>合成细节</summary>\n\n${body}\n\n</details>`;
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' },
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => vite.close());
const [{ default: Message }, { default: Markdown }] = await Promise.all([vite.ssrLoadModule('/src/ConversationMessage.tsx'), vite.ssrLoadModule('/src/MessageMarkdown.tsx')]);
const render = (text, role = 'assistant', extra = {}) => renderToStaticMarkup(createElement(Message, {
  threadId: id, message: { id: 'stable-message', role, text, phase: role === 'assistant' ? 'final' : undefined, ...extra },
}));
const md = (text, extra = {}) => renderToStaticMarkup(createElement(Markdown, { text, threadId: id, ...extra }));

test('both known adapters preserve normal Markdown, code and mixed-citation continuations in both original roles', () => {
  const tails = ['普通续文。\n\n- **保留排版**', '```xml\n<literal>代码示例</literal>\n```',
    citation + '\n\n继续的 [文章](https://example.invalid/read)', disclosure('可展开的 **说明**。')];
  for (const wrap of [heartbeat, child]) for (const tail of tails) for (const role of ['assistant', 'user']) {
    const source = wrap('合成摘要。') + '\n\n' + tail, projection = projectStructuredMessage(source);
    assert.notEqual(projection?.kind, 'literal'); assert.ok(projection?.continuation);
    const html = render(source, role);
    assert.match(html, /合成摘要/); assert.match(html, /普通续文|代码示例|继续的|可展开/);
    assert.doesNotMatch(html, /&lt;heartbeat|&lt;subagent_notification|synthetic-hidden/);
    assert.match(html, new RegExp(`data-message-id="stable-message"`));
    const copy = presentUserMessage(source).copyText;
    assert.match(copy, /合成摘要/); assert.doesNotMatch(copy, /automation_id|agent_path|synthetic-hidden/);
  }
});

test('field and closing-tag code examples remain inert across framing and continuation', () => {
  for (const wrap of [heartbeat, child]) {
    const body = '代码：\n\n```xml\n</heartbeat>\n</subagent_notification>\n<details>示例</details>\n```';
    const source = wrap(body) + '\n\n继续正常正文。';
    assert.match(render(source), /继续正常正文/); assert.match(render(source), /&lt;details&gt;示例/);
    assert.doesNotMatch(render(source), /<details\b/);
    assert.notEqual(projectStructuredMessage(source)?.kind, 'literal');
  }
  assert.equal(heartbeatMessage(heartbeat('    <node>缩进代码</node>')).text, '    <node>缩进代码</node>');
  assert.equal(subagentNotification(child('    <node>缩进代码</node>')).text, '    <node>缩进代码</node>');
  const delimiterExample = '字段代码：\n\n```xml\n</message>\n</instructions>\n```';
  assert.equal(heartbeatMessage(heartbeat(delimiterExample)).text, delimiterExample);
  assert.equal(heartbeatMessage('<heartbeat><automation_id>fixture</automation_id><instructions>' + delimiterExample + '</instructions></heartbeat>').instructions, delimiterExample);
});

test('unknown, duplicate and incomplete wires never gain a known shape from a normal tail', () => {
  const sources = ['<heartbeat><automation_id>check</automation_id><future>保留</future></heartbeat>',
    '<heartbeat><automation_id>check</automation_id><message>一</message><message>二</message></heartbeat>',
    '<heartbeat><automation_id>check</automation_id><message>未结束',
    '<subagent_notification>{"agent_path":"one","agent_path":"two","status":"running"}</subagent_notification>',
    '<subagent_notification>{"agent_path":"one","status":{"future":"保留"}}</subagent_notification>'];
  for (const source of sources) {
    assert.equal(projectStructuredMessage(source + '\n\n后文。')?.kind, 'literal');
    assert.match(render(source + '\n\n后文。'), /&lt;(?:heartbeat|subagent_notification)/);
  }
  assert.match(md('<future>未知结构仍可读</future>'), /&lt;/);
  for (const source of ['<script>不执行</script>', '<img src="invalid" onerror="bad()">保留'])
    assert.doesNotMatch(md(source), /<(?:script|img)\b/);
});

test('unknown inline HTML stays inert without turning surrounding normal Markdown into one code block', () => {
  const source = '**保留加粗**，这里的 <br> 和 <symbol> 是惰性文本。\n\n- 正常列表';
  const html = md(source);
  assert.match(html, /<strong>保留加粗<\/strong>/); assert.match(html, /<ul>/);
  assert.match(html, /&lt;symbol&gt;/); assert.doesNotMatch(html, /<br\b|<symbol\b|<pre\b/);
  assert.match(md(disclosure(source)), /<details\b/);
});

test('safe details retain nested/fenced/inline examples and decline unsupported attributes or streaming delimiters', () => {
  const noBlank = '<details><summary>代码</summary>\n```xml\n<details>示例</details>\n```\n</details>';
  assert.equal(messageDetailsParts(noBlank).filter(part => part.kind === 'details').length, 1);
  const html = md(noBlank);
  assert.equal((html.match(/<details\b/g) || []).length, 1); assert.match(html, /&lt;details&gt;示例/);
  const inline = '<details><summary>行内</summary>\n`</details>` 保留。\n</details>';
  assert.equal((md(inline).match(/<details\b/g) || []).length, 1); assert.match(md(inline), /<code>&lt;\/details&gt;<\/code>/);
  assert.equal((md(disclosure(disclosure('嵌套正文'))).match(/<details\b/g) || []).length, 2);
  for (const source of ['<details onclick="bad()"><summary>保留</summary>正文</details>', '<details><summary>载入中</summary>未闭合', '</details>保留正文', disclosure('x'.repeat(128 * 1024))]) {
    const fallback = md(source); assert.match(fallback, /&lt;\/?details/); assert.doesNotMatch(fallback, /<details\b|<[^>]*onclick=/);
  }
  assert.equal(messageDetailsParts(disclosure('body'), 6)[0].kind, 'markdown');
});

test('all display citation cleaners preserve code inside a details HTML block without framing blank lines', () => {
  const source = '<details><summary>Code example</summary>\n```xml\n<oai-mem-citation>literal-citation-code</oai-mem-citation>\n```\n</details>';
  assert.ok(readableCodexMarkdown(source).includes('literal-citation-code'));
  for (const wrap of [heartbeat, child]) {
    const combined = wrap('摘要。') + '\n\n' + source + '\n\n' + citation;
    assert.ok(projectStructuredMessage(combined).continuation.includes('literal-citation-code'));
    const html = render(combined);
    assert.match(html, /literal-citation-code/); assert.doesNotMatch(html, /synthetic-hidden|synthetic-source/);
    assert.equal((html.match(/<details\b/g) || []).length, 1);
  }
});

test('split disclosures share the original first Markdown definition across body and surrounding parts', () => {
  const text = `[image]: ${imagePath}\n\n${disclosure('![图][image]\n\n[报告][file]')}\n\n[file]: ${filePath}\n\n[image]: /fixture/task/other.png`;
  const html = md(text, { images: { [imagePath]: image }, files: { [filePath]: file } });
  assert.equal((html.match(/data-registered-source=/g) || []).length, 1); assert.ok(html.includes(`data-registered-source="${image}"`));
  assert.match(html, /aria-label="查看大图：图"/);assert.doesNotMatch(html, /<img\b|<link\b|\ssrc=/);
  assert.match(html, /预览文件：report.md/); assert.doesNotMatch(html, /!\[图\]|\[报告\]|other\.png|\/fixture\//);
});

test('metadata bodies cannot borrow capabilities while ordinary continuations use only existing grants', () => {
  const source = child(`![内部](${imagePath})\n\n[内部报告](${filePath})`) + `\n\n${disclosure(`![外部](${imagePath})\n\n[外部报告](${filePath})`)}`;
  const html = render(source, 'assistant', { images: { [imagePath]: image }, files: { [filePath]: file } });
  assert.equal((html.match(/data-registered-source=/g) || []).length, 1); assert.equal((html.match(/class="message-file-button"/g) || []).length, 1);
  assert.ok(html.includes(`data-registered-source="${image}"`));assert.match(html, /aria-label="查看大图：外部"/);
  assert.doesNotMatch(html, /查看大图：内部|<img\b|<link\b|\ssrc=/);
  assert.match(html, /文件保存在电脑上/);
  const outside = `${heartbeat('合成摘要。')}\n\n![音效对照](/fixture/outside/compare.wav)\n\n${disclosure('![重载参数](/fixture/outside/preview.jpg)')}`;
  const original = { id: 'raw', role: 'assistant', phase: 'final', text: outside }, history = { messages: [original] };
  const files = new MessageFiles().attach({ id, cwd: '/fixture/task' }, history).messages[0].files;
  const images = new MessageImages().attach({ id, cwd: '/fixture/task' }, history).messages[0].images;
  assert.deepEqual(files, {}); assert.deepEqual(images, {}); assert.equal(original.text, outside);
  const fallback = render(outside, 'assistant', { files, images });
  assert.equal((fallback.match(/文件保存在电脑上/g) || []).length, 2);
  assert.equal((fallback.match(/<pre\b/g) || []).length, 0); assert.equal((fallback.match(/<details\b/g) || []).length, 1);
  assert.doesNotMatch(fallback, /<(?:audio|img|video)\b|\/fixture\//);
});

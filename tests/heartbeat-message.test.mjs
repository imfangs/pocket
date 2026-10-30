import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { heartbeatMessage, heartbeatFallback, readableHeartbeatMessage } from '../src/heartbeatMessage.ts';
import { presentUserMessage } from '../src/userMessage.ts';
import { readableCodexMarkdown } from '../src/codexMarkup.ts';

const instructions = '检查合成任务的当前状态。\n\n- 保留现有工作\n- 有变化再记录';
const summary = '合成任务状态无变化，继续等待下一次检查。';
const envelope = (body) => `<heartbeat>\n<automation_id>synthetic-check</automation_id>\n${body}\n</heartbeat>`;
const trigger = envelope(`<current_time_iso>2026-10-28T05:00:00+08:00</current_time_iso>\n<instructions>${instructions}</instructions>`);
const result = (decision = 'DONT_NOTIFY', body = summary) => envelope(`<decision>${decision}</decision>\n<message>${body}</message>`);
const citationFooter = '<oai-mem-citation>\n<citation_entries>synthetic-private-entry</citation_entries>\n<rollout_ids>synthetic-private-id</rollout_ids>\n</oai-mem-citation>';
const encodedFooter = citationFooter.replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
  esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false }, appType: 'custom',
});
const { default: ConversationMessage } = await vite.ssrLoadModule('/src/ConversationMessage.tsx');
after(() => vite.close());

function render(role, text) {
  return renderToStaticMarkup(createElement(ConversationMessage, {
    message: { id: `synthetic-${role}`, role, text, phase: role === 'assistant' ? 'final' : undefined,
      timestamp: Date.UTC(2026, 9, 28), turnDurationMs: role === 'assistant' ? 121000 : undefined },
    queryDisclosure: role === 'user' ? { expanded: false, toggle() {} } : undefined,
  }));
}

test('DONT_NOTIFY affects notification choice, not the visible assistant history or copy text', () => {
  assert.deepEqual(heartbeatMessage(result()), { kind: 'result', text: summary });
  assert.equal(readableCodexMarkdown(result()), summary);
  const html = render('assistant', result());
  assert.match(html, /合成任务状态无变化/);
  assert.match(html, /复制回复/);
  assert.match(html, /总用时/);
  assert.doesNotMatch(html, /DONT_NOTIFY|synthetic-check|<heartbeat>/);
});

test('NOTIFY and future decision values preserve the same valid message', () => {
  for (const decision of ['NOTIFY', 'WAIT_FOR_NEXT_CHECK']) {
    assert.equal(readableHeartbeatMessage(result(decision)), summary);
    assert.match(render('assistant', result(decision)), /合成任务状态无变化/);
  }
});

test('a user heartbeat has an accessible disclosure and retains the complete human-readable copy', () => {
  const presentation = presentUserMessage(trigger);
  assert.equal(presentation.text, '定时检查');
  assert.equal(presentation.automationInstructions, instructions);
  assert.equal(presentation.copyText, `定时检查\n\n${instructions}`);
  const html = render('user', trigger);
  assert.match(html, /定时检查/);
  assert.match(html, /查看检查内容/);
  assert.match(html, /aria-expanded="false"/);
  const controlled = html.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(controlled);
  assert.ok(html.includes(`id="${controlled}" hidden=""`));
  assert.match(html, /检查合成任务的当前状态/);
  assert.match(html, /保留现有工作/);
  assert.match(html, /复制这条消息/);
  assert.doesNotMatch(html, /synthetic-check|2026-10-28T05:00/);
});

test('whitespace and multiline known fields preserve Markdown content', () => {
  const wrapped = ` \n${result('DONT_NOTIFY', '第一段。\n\n第二段。')}\n `;
  assert.equal(readableCodexMarkdown(wrapped), '第一段。\n\n第二段。');
  const html = render('assistant', wrapped);
  assert.match(html, /<p>第一段。<\/p>/);
  assert.match(html, /<p>第二段。<\/p>/);
});

test('ordinary prose and fenced heartbeat examples are not reclassified as automation messages', () => {
  for (const text of ['普通的 **回复**。', `示例说明：\n\n${result()}`, `\`\`\`xml\n${result()}\n\`\`\``]) {
    assert.equal(heartbeatMessage(text), null);
    assert.equal(heartbeatFallback(text), null);
    assert.equal(readableHeartbeatMessage(text), text);
    assert.equal(presentUserMessage(text).automationInstructions, undefined);
  }
  const code = render('assistant', `\`\`\`xml\n${result()}\n\`\`\``);
  assert.match(code, /&lt;heartbeat&gt;/);
  assert.match(code, /DONT_NOTIFY/);
});

test('indented Markdown heartbeat examples keep their literal source instead of turning into a live summary', () => {
  for (const prefix of ['    ', '\t']) {
    const example = result().split('\n').map(line => prefix + line).join('\n');
    assert.equal(heartbeatMessage(example), null);
    assert.equal(heartbeatFallback(example), null);
    assert.equal(readableHeartbeatMessage(example), example);
    assert.equal(presentUserMessage(example).automationInstructions, undefined);
    const html = render('assistant', example);
    assert.match(html, /&lt;heartbeat&gt;/);
    assert.match(html, /DONT_NOTIFY/);
  }
});

test('fenced tag examples inside a valid message remain ordinary Markdown code', () => {
  const body = '合成代码示例：\n\n```xml\n<task>literal example</task>\n```';
  const source = result('DONT_NOTIFY', body);
  assert.equal(heartbeatMessage(source)?.text, body);
  const html = render('assistant', source);
  assert.match(html, /合成代码示例/);
  assert.match(html, /&lt;task&gt;/);
  assert.doesNotMatch(html, /<task\b/);
});

test('unknown, duplicate, missing and incomplete heartbeat shapes use visible inert fallback', () => {
  const cases = [
    envelope('<future>合成未知字段</future>'),
    envelope('<message>合成重复字段一</message><message>合成重复字段二</message>'),
    '<heartbeat>\n<message>合成缺少身份</message>\n</heartbeat>',
    '<heartbeat>\n<automation_id>synthetic-check</automation_id>\n<message>合成未闭合消息',
    '<heartbeat version="next"><message>合成新版包装</message></heartbeat>',
  ];
  for (const source of cases) {
    assert.equal(heartbeatMessage(source), null);
    assert.ok(heartbeatFallback(source)?.startsWith('```text\n'));
    for (const role of ['user', 'assistant']) {
      const html = render(role, source);
      assert.match(html, /合成/);
      assert.match(html, /&lt;heartbeat/);
      assert.doesNotMatch(html, /<heartbeat\b|<future\b/);
    }
  }
});

test('fallback fences cannot be broken by embedded code fences or script text', () => {
  const source = envelope('<future>合成未知\n```\n<script>syntheticProbe()</script></future>');
  const fallback = heartbeatFallback(source);
  assert.ok(fallback.startsWith('````text\n'));
  const html = render('assistant', source);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script\b/);
});

test('tag-like or malicious field content remains inert and does not recreate the empty-body defect', () => {
  const samples = [
    '<section>保留合成摘要</section>',
    '<script>保留合成摘要</script>',
    '<img src="invalid" onerror="syntheticProbe()">保留合成摘要',
    '<heartbeat><message>保留合成摘要</message></heartbeat>',
  ];
  for (const body of samples) {
    for (const [role, source] of [['assistant', result('DONT_NOTIFY', body)], ['user', envelope(`<instructions>${body}</instructions>`)]]) {
      const html = render(role, source);
      assert.match(html, /保留合成摘要/);
      assert.doesNotMatch(html, /<(?:script|section|img|heartbeat)\b/);
      assert.doesNotMatch(html, /<div class="message-text message-markdown"><\/div>/);
    }
  }
});

test('heartbeat presentation never mutates the original message used by identity and read accounting', () => {
  const message = Object.freeze({ id: 'synthetic-immutable', role: 'assistant', phase: 'final', text: result() });
  const before = JSON.stringify(message);
  renderToStaticMarkup(createElement(ConversationMessage, { message }));
  assert.equal(JSON.stringify(message), before);
  assert.equal(message.text, result());
});

test('complete heartbeat envelopes accept only an external citation suffix, including encoded and streamed footers', () => {
  for (const footer of [citationFooter, encodedFooter, '<citation_entries>synthetic-private-entry</citation_entries>',
    '<rollout_ids>synthetic-private-id', '&lt;oai-mem-citation&gt;synthetic-private-entry',
    `${citationFooter}\n\n${encodedFooter}\n<rollout_ids>synthetic-private-id</rollout_ids>`]) {
    const body = '可读摘要。\n\n[参考文章](https://example.invalid/article)', source = result('DONT_NOTIFY', body) + '\n' + footer;
    assert.deepEqual(heartbeatMessage(source), { kind: 'result', text: body });
    assert.equal(readableCodexMarkdown(source), body);
    const html = render('assistant', source);
    assert.match(html, /href="https:\/\/example.invalid\/article"/);
    assert.doesNotMatch(html, /synthetic-private|citation_entries|rollout_ids|&lt;heartbeat/);
    const presentation = presentUserMessage(trigger + '\n' + footer);
    assert.equal(presentation.automationInstructions, instructions);
    assert.equal(presentation.copyText, `定时检查\n\n${instructions}`);
  }
});

test('citation stripping never pre-cleans code or literal tags inside heartbeat fields', () => {
  const bodies = ['内部示例：\n\n```xml\n<oai-mem-citation>literal-example</oai-mem-citation>\n```',
    '内部行内示例 `<citation_entries>literal-example</citation_entries>` 保留。',
    '<oai-mem-citation>literal-example</oai-mem-citation>',
    '闭合标签代码 `</heartbeat>` 也保留。'];
  for (const body of bodies) {
    const source = result('DONT_NOTIFY', body) + '\n' + citationFooter;
    assert.equal(heartbeatMessage(source)?.text, body);
    assert.equal(heartbeatMessage(envelope(`<instructions>${body}</instructions>`) + '\n' + citationFooter)?.instructions, body);
    assert.match(render('assistant', source), /literal-example|闭合标签代码/);
    assert.doesNotMatch(render('assistant', source), /synthetic-private/);
  }
});

test('ordinary trailing text or protected citation examples retain the original heartbeat fallback', () => {
  for (const tail of ['\n后续普通文字', `\n\n\`\`\`xml\n${citationFooter}\n\`\`\``,
    '\n`<oai-mem-citation>literal-example</oai-mem-citation>`',
    '\n\n    <oai-mem-citation>literal-example</oai-mem-citation>', `${citationFooter}\n后续普通文字`]) {
    const source = result() + tail;
    assert.equal(heartbeatMessage(source), null);
    assert.ok(heartbeatFallback(source).includes(source.trim()));
  }
});

test('unknown heartbeat shapes remain inert while a safe external footer is removed from their fallback', () => {
  for (const source of [envelope('<future>未知字段</future>'), envelope('<message>一</message><message>二</message>'),
    '<heartbeat version="future"><message>未知格式</message></heartbeat>']) {
    assert.equal(heartbeatMessage(source + '\n' + citationFooter), null);
    assert.equal(heartbeatFallback(source + '\n' + citationFooter), heartbeatFallback(source));
  }
  const incomplete = result().replace('</heartbeat>', '');
  assert.equal(heartbeatMessage(incomplete + citationFooter), null);
  assert.ok(heartbeatFallback(incomplete + citationFooter).includes('synthetic-private-entry'));
});

test('whole fenced, indented and inline heartbeat examples stay unclassified even with a footer', () => {
  for (const example of [`\`\`\`xml\n${result()}\n\`\`\``, result().split('\n').map(line => '    ' + line).join('\n'),
    `\`${result().replaceAll('\n', ' ')}\``]) {
    const source = example + '\n' + citationFooter;
    assert.equal(heartbeatMessage(source), null); assert.equal(heartbeatFallback(source), null);
    assert.equal(readableHeartbeatMessage(source), source);
  }
});

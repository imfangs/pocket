import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { subagentNotification, subagentNotificationFallback, readableSubagentNotification } from '../src/subagentNotification.ts';
import { presentUserMessage } from '../src/userMessage.ts';
import { readableCodexMarkdown } from '../src/codexMarkup.ts';

const report = '独立验证完成。\n\n- **117 项：112 通过、5 失败**\n- 五个场景全部通过。';
const wrap = (value) => `<subagent_notification>\n${typeof value === 'string' ? value : JSON.stringify(value)}\n</subagent_notification>`;
const envelope = (status = { completed: report }) => wrap({ agent_path: '/root/synthetic-review', status });
const citationFooter = '<oai-mem-citation><citation_entries>synthetic-private-entry</citation_entries><rollout_ids>synthetic-private-id</rollout_ids></oai-mem-citation>';
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
  esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: ConversationMessage } = await vite.ssrLoadModule('/src/ConversationMessage.tsx');
const { default: EarlierHistoryMessage } = await vite.ssrLoadModule('/src/earlierHistoryMessage.tsx');
after(() => vite.close());
function render(text, role = 'user', extra = {}) {
  return renderToStaticMarkup(createElement(ConversationMessage, {
    message: { id: 'unchanged-message-id', role, text, timestamp: Date.UTC(2026, 9, 28), ...extra },
    queryDisclosure: { expanded: false, toggle() {} },
  }));
}

test('complete child result decodes JSON newlines and preserves meaningful Markdown in readable copy', () => {
  assert.deepEqual(subagentNotification(envelope()), { status: 'completed', label: '子任务已完成', text: report });
  assert.equal(presentUserMessage(envelope()).copyText, '子任务已完成\n\n' + report);
  assert.equal(readableCodexMarkdown(envelope()), '子任务已完成\n\n' + report);
  assert.equal(readableSubagentNotification(envelope()), '子任务已完成\n\n' + report);
});

test('notification gets its own compact disclosure rather than a long user query', () => {
  for (const role of ['user', 'assistant']) {
    const html = render(envelope(), role);
    assert.match(html, /class="conversation-message (?:user|assistant) message-notification"/);
    assert.match(html, /data-message-id="unchanged-message-id"/);
    assert.match(html, /aria-label="子任务已完成"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /查看结果/);
    assert.match(html, /复制子任务结果/);
    assert.match(html, /<strong>117 项：112 通过、5 失败<\/strong>/);
    assert.match(html, /hidden="" class="subagent-notification-body"/);
    assert.doesNotMatch(html, /user-query-body|message-user|agent_path|subagent_notification|synthetic-review|\\n/);
  }
});

test('a child notification carried as commentary retains its result copy and time', () => {
  const html = render(envelope(), 'assistant', { phase: 'commentary' });
  assert.match(html, /class="conversation-message assistant message-notification"/);
  assert.match(html, /<footer class="message-footer">[\s\S]*message-timestamp[\s\S]*复制子任务结果/);
});

test('historical rows share the same projection without delivery or read credentials', () => {
  const html = renderToStaticMarkup(createElement(EarlierHistoryMessage, { threadId: 'fixture', message: {
    id: 'historic-notification', role: 'user', text: envelope(), clientMessageId: 'not-a-receipt',
  } }));
  assert.match(html, /子任务已完成/);
  assert.match(html, /查看结果/);
  assert.doesNotMatch(html, /user-query-body|data-query-id|message-send-confirmed|data-pocket-read-marker/);
});

test('known status-only and error notices remain compact and honest', () => {
  for (const [status, label] of [
    ['running', '子任务运行中'], ['pending_init', '子任务准备中'],
    ['shutdown', '子任务已结束'], ['not_found', '子任务暂不可用'],
  ]) {
    assert.deepEqual(subagentNotification(envelope(status)), { status, label, text: '' });
    const html = render(envelope(status));
    assert.match(html, new RegExp(label));
    assert.doesNotMatch(html, /查看结果|aria-expanded/);
  }
  assert.deepEqual(subagentNotification(envelope({ errored: '连接中断。' })), {
    status: 'errored', label: '子任务遇到问题', text: '连接中断。',
  });
  assert.match(render(envelope({ errored: '连接中断。' })), /data-status="errored"/);
});

test('literal property keys inside the result are not mistaken for duplicate envelope fields', () => {
  const text = '代码示例：\n\n```json\n{"status":"completed", "agent_path":"literal"}\n```';
  assert.equal(subagentNotification(envelope({ completed: text })).text, text);
  assert.match(render(envelope({ completed: text })), /status/);
});

test('ordinary prose and Markdown code examples are not reclassified', () => {
  for (const text of [
    '普通回复', `解释这个例子：\n\n${envelope()}`, `\`\`\`xml\n${envelope()}\n\`\`\``,
    `\`${envelope().replaceAll('\n', ' ')}\``,
    ...['    ', '\t'].map(prefix => envelope().split('\n').map(line => prefix + line).join('\n')),
  ]) {
    assert.equal(subagentNotification(text), null);
    assert.equal(subagentNotificationFallback(text), null);
    assert.equal(readableSubagentNotification(text), text);
  }
  assert.match(render(`\`\`\`xml\n${envelope()}\n\`\`\``), /&lt;subagent_notification&gt;/);
});

test('unknown, malformed, incomplete and duplicate shapes remain visible inert source', () => {
  const cases = [
    envelope('future_status'), envelope({ future: '保留未知结果' }),
    wrap({ agent_path: '/root/child', status: { completed: report }, extra: 'unknown' }),
    wrap({ status: { completed: report } }), wrap({ agent_path: '', status: 'running' }),
    wrap({ agent_path: '/root/child', status: { completed: report, errored: 'conflict' } }),
    wrap('{"agent_path":"one","agent_path":"two","status":{"completed":"duplicate"}}'),
    wrap('{"agent_path":"one","status":{"completed":"first","compl\\u0065ted":"second"}}'),
    wrap('{"agent_path":"one","status":'), envelope().slice(0, -24),
    envelope().replace('<subagent_notification>', '<subagent_notification version="new">'),
  ];
  for (const source of cases) {
    assert.equal(subagentNotification(source), null);
    assert.ok(subagentNotificationFallback(source));
    assert.equal(presentUserMessage(source).copyText, source);
    for (const role of ['user', 'assistant']) {
      const html = render(source, role);
      assert.match(html, /&lt;subagent_notification/);
      assert.doesNotMatch(html, /<subagent_notification|message-notification/);
    }
  }
});

test('HTML and embedded fences in a result cannot become active markup or disappear', () => {
  for (const text of ['<script>preserve the example</script>', '<img src="invalid" onerror="syntheticAttack()">保留这段文字',
    '```xml\n<node>literal</node>\n```']) {
    const html = render(envelope({ completed: text }));
    assert.match(html, /preserve|保留|literal/);
    assert.doesNotMatch(html, /<(?:script|img|node)\b/);
  }
  const invalid = wrap('{"unknown":"```\n<script>inert example</script>"}');
  assert.match(subagentNotificationFallback(invalid), /^````text/);
  assert.doesNotMatch(render(invalid), /<script\b/);
});

test('notification contents never inherit attached file/image capabilities', () => {
  const file = '/workspace/validation.md', image = '/workspace/chart.png';
  const text = `[报告](${file})\n\n![图](${image})\n\n:codex-file-citation{path="/workspace/secret.txt"}`;
  const html = render(envelope({ completed: text }), 'assistant', {
    files: { [file]: { name: 'validation.md', url: '/api/tasks/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa/files/' + 'a'.repeat(64) } },
    images: { [image]: '/api/tasks/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa/images/' + 'b'.repeat(64) },
  });
  assert.doesNotMatch(html, /<img|href="\/api|data-message-file|打开文件/);
  assert.match(html, /文件保存在电脑上/);
});

test('display projection does not mutate the source identity or message bytes', () => {
  const message = Object.freeze({ id: 'original', role: 'user', clientMessageId: 'exact-request', text: envelope() });
  const before = JSON.stringify(message);
  renderToStaticMarkup(createElement(ConversationMessage, { message }));
  assert.equal(JSON.stringify(message), before);
});

test('a hidden result cannot expose a read marker while visible status-only and ordinary messages can', () => {
  const renderReadTarget = text => renderToStaticMarkup(createElement(ConversationMessage, {
    message: { id: 'read-target', role: 'assistant', text }, readMarker() {},
  }));
  assert.doesNotMatch(renderReadTarget(envelope()), /data-pocket-read-marker/);
  assert.match(renderReadTarget(envelope('running')), /data-pocket-read-marker/);
  assert.match(renderReadTarget('普通回复'), /data-pocket-read-marker/);
});

test('subagent notifications accept external raw, entity, multiple and truncated citation suffixes', () => {
  const encoded = citationFooter.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  for (const footer of [citationFooter, encoded, '<citation_entries>synthetic-private-entry',
    '&lt;rollout_ids&gt;synthetic-private-id', citationFooter + '\n' + encoded]) {
    const source = envelope() + '\n' + footer;
    assert.deepEqual(subagentNotification(source), subagentNotification(envelope()));
    assert.equal(readableCodexMarkdown(source), '子任务已完成\n\n' + report);
    assert.equal(presentUserMessage(source).copyText, '子任务已完成\n\n' + report);
    const html = render(source);
    assert.match(html, /message-notification/); assert.doesNotMatch(html, /synthetic-private|agent_path|&lt;subagent_notification/);
  }
});

test('subagent JSON and internal code remain exact even when they contain literal envelope closing tags', () => {
  for (const text of ['JSON文字包含 </subagent_notification> 然后继续。',
    '内部代码：\n\n```xml\n<oai-mem-citation>literal-example</oai-mem-citation>\n```',
    '保留行内 `<rollout_ids>literal-example</rollout_ids>`。',
    '字面JSON {"ending":"</subagent_notification>","note":"<citation_entries>literal-example</citation_entries>"}']) {
    const source = envelope({ completed: text }) + '\n' + citationFooter;
    assert.equal(subagentNotification(source)?.text, text);
    assert.match(render(source), /JSON|literal-example/); assert.doesNotMatch(render(source), /synthetic-private/);
  }
});

test('ordinary and protected Markdown continuations share the subagent display projection', () => {
  for (const tail of ['\n普通后文', `\n\n\`\`\`xml\n${citationFooter}\n\`\`\``,
    `\n\`${citationFooter}\``, `\n\n    ${citationFooter}`, citationFooter + '\n普通后文']) {
    const source = envelope() + tail;
    const notification = subagentNotification(source);
    assert.equal(notification.text, report); assert.ok(notification.continuation);
    assert.equal(subagentNotificationFallback(source), null);
    if (tail === citationFooter + '\n普通后文') assert.equal(notification.continuation, '普通后文');
    else assert.ok(notification.continuation.includes(tail.replace(/^\n+/, '')));
  }
});

test('external citations do not relax unknown/duplicate shapes or the original source length bound', () => {
  for (const source of [envelope('future_status'), wrap({ agent_path: 'agent', status: 'running', future: 'unknown' }),
    wrap('{"agent_path":"one","agent_path":"two","status":"running"}')]) {
    assert.equal(subagentNotification(source + '\n' + citationFooter), null);
    assert.equal(subagentNotificationFallback(source + '\n' + citationFooter), subagentNotificationFallback(source));
  }
  const oversized = envelope() + '\n<oai-mem-citation>' + 'x'.repeat(262144) + '</oai-mem-citation>';
  assert.ok(oversized.length > 262144); assert.equal(subagentNotification(oversized), null);
  assert.match(readableSubagentNotification(oversized), /^```text/);
  const incomplete = envelope().replace(/<\/subagent_notification>$/, '');
  assert.equal(subagentNotification(incomplete + citationFooter), null);
  assert.ok(subagentNotificationFallback(incomplete + citationFooter).includes('synthetic-private-entry'));
});

test('whole subagent Markdown examples are never promoted when an external footer follows', () => {
  for (const example of [`\`\`\`xml\n${envelope()}\n\`\`\``,
    envelope().split('\n').map(line => '    ' + line).join('\n'), `\`${envelope().replaceAll('\n', ' ')}\``]) {
    const source = example + '\n' + citationFooter;
    assert.equal(subagentNotification(source), null); assert.equal(subagentNotificationFallback(source), null);
    assert.equal(readableSubagentNotification(source), source);
  }
});

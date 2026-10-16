import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { parseHistoryLines } from '../server/history.mjs';
import { displayMessages } from '../src/transcript.ts';
import { readableUserMessage } from '../src/userMessage.ts';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: Message } = await vite.ssrLoadModule('/src/ConversationMessage.tsx');
after(() => vite.close());
const context = '<in-app-browser-context source="ambient-ui-state">\n' +
  "This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.\n" +
  '# In app browser:\n- The user has the in-app browser open with 1 tab.\n- Current URL: http://127.0.0.1:54321/report.html\n</in-app-browser-context>';
const wrapped = text => `\n${context}\n\n## My request:\n${text}`;
const render = (text, extra = {}) => renderToStaticMarkup(createElement(Message, { message: { id: 'request', role: 'user', text, ...extra } }));

test('native and recorded user messages hide only the generated browser envelope in their presentation', () => {
  const query = '把三天的曲线叠加在同一张图上。\n';
  const raw = wrapped(query);
  const live = { source: 'desktop', messages: [{ id: 'native', role: 'user', text: raw, clientMessageId: 'receipt' }] };
  const saved = { source: 'rollout', messages: parseHistoryLines(JSON.stringify({ type: 'response_item', payload: {
    type: 'message', id: 'recorded', role: 'user', content: [{ type: 'input_text', text: raw }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
  } })) };
  const before = structuredClone({ live, saved });
  for (const messages of [displayMessages(live, null), displayMessages(null, saved)]) {
    const html = renderToStaticMarkup(createElement(Message, { message: messages[0] }));
    assert.match(html, /把三天的曲线叠加在同一张图上。/);
    assert.doesNotMatch(html, /My request|ambient-ui-state|54321|In app browser/);
  }
  assert.deepEqual({ live, saved }, before);
});

test('authored headings, code and quoted examples remain visible', () => {
  for (const text of ['## My request:\nKeep this heading.', `Example:\n\n${wrapped('Keep the example.')}`, `\`\`\`text\n${wrapped('Keep the code.')}\n\`\`\``, wrapped('## My request:\nThis second heading is mine.')]) {
    assert.match(render(text), /My request/);
  }
});

test('assistant headings are not treated as user request wrappers', () => {
  assert.match(render(wrapped('Explanation.'), { role: 'assistant' }), /My request/);
});

test('only a complete known leading envelope is removed, preserving the exact request bytes', () => {
  const query = '\n## My request:\n  Keep spaces,\n\n```md\n# In app browser:\n```\n';
  assert.equal(readableUserMessage(wrapped(query)), query);
  const crlf = wrapped(query).replaceAll('\n', '\r\n');
  assert.equal(readableUserMessage(crlf), query.replaceAll('\n', '\r\n'));
  for (const raw of [
    '## My request:\nKeep this title.',
    wrapped('Keep this.').replace('ambient-ui-state', 'authored-example'),
    wrapped('Keep this.').replace('This block is automatically supplied', 'This block was written manually'),
    wrapped('Keep this.').replace('</in-app-browser-context>', ''),
    wrapped('Keep this.').replace('## My request:\n', ''),
    `    ${context.replaceAll('\n', '\n    ')}\n\n## My request:\nKeep this indented example.`,
    `${context}\nUser prose between the block and heading.\n\n## My request:\nKeep all of it.`,
    '# Files mentioned by the user:\n## example.txt: /fixture/example.txt\n\n## My request:\nKeep file context for the attachment adapter.',
    '# Response annotations:\n<response-annotations>[]</response-annotations>\n\n## My request:\nKeep quoted context.',
  ]) assert.equal(readableUserMessage(raw), raw);
});

test('optional-question answers keep their readable projection after an envelope', () => {
  const reply = '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: 'question', question: '选哪天？', answer: '第三天' }]) + '\n</send_user_message_question_reply>';
  assert.equal(readableUserMessage(wrapped(reply)), '回答：选哪天？\n\n第三天');
  assert.equal(readableUserMessage(reply), '回答：选哪天？\n\n第三天');
  assert.equal(readableUserMessage(wrapped('')), '');
});

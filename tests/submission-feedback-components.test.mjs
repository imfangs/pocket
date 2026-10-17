import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: Message }, { default: Outbox }] = await Promise.all([
  vite.ssrLoadModule('/src/ConversationMessage.tsx'), vite.ssrLoadModule('/src/Outbox.tsx'),
]);
after(() => vite.close());
const queueItem = status => ({ id: status, status, revision: 0, text: 'One queued instruction', createdAt: 1 });
function renderOutbox(items, extra = {}) {
  return renderToStaticMarkup(createElement(Outbox, { threadId: 'thread', items, disabled: false, allowSend: true, refresh: async () => {}, drafts: new Map(), ...extra }));
}
test('only a newly confirmed user message receives the green confirmation treatment', () => {
  const message = { id: 'one', role: 'user', text: 'Keep this exact text', clientMessageId: 'r' };
  const html = renderToStaticMarkup(createElement(Message, { message, recentlySent: true }));
  assert.match(html, /is-recently-sent/); assert.match(html, /已发送/); assert.match(html, /Keep this exact text/);
  assert.match(html, /<footer class="message-footer">[\s\S]*class="message-send-confirmed"[\s\S]*已发送[\s\S]*<\/footer>/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(Message, { message })), /is-recently-sent|已发送/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(Message, { message: { ...message, role: 'assistant' }, recentlySent: true })), /is-recently-sent|已发送/);
});
test('only unpaused queued rows breathe, while unknown and rejected rows retain warning semantics', () => {
  assert.match(renderOutbox([queueItem('queued')]), /is-queue-breathing/);
  assert.doesNotMatch(renderOutbox([queueItem('queued')], { paused: { stopId: 'stop' } }), /is-queue-breathing/);
  assert.doesNotMatch(renderOutbox([queueItem('editing')]), /is-queue-breathing/);
  const html = renderOutbox([queueItem('unknown'), queueItem('queued'), queueItem('rejected')]);
  assert.doesNotMatch(html, /is-queue-breathing|data-feedback-state="accepted"/);
  assert.match(html, /结果待确认，不会自动重发/); assert.match(html, /发送未完成，可编辑后重试/);
});
test('an accepted outbox row is green and no longer described as queued', () => {
  const html = renderOutbox([queueItem('accepted')]);
  assert.match(html, /data-feedback-state="accepted"/);
  assert.match(html, /已发送/);
  assert.doesNotMatch(html, /原任务|等待同步|正在同步历史/);
  assert.doesNotMatch(html, /排队中|is-queue-breathing/);
});

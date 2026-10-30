import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: Message }, { messageClock }] = await Promise.all([vite.ssrLoadModule('/src/ConversationMessage.tsx'), vite.ssrLoadModule('/src/messageTime.ts')]);
after(() => vite.close());

test('recent footer time is relative while keeping its full actual timestamp accessible', () => {
  const timestamp = messageClock.getSnapshot() - 12 * 60_000;
  for (const [role, phase, label] of [['user', undefined, '复制这条消息'], ['assistant', 'commentary', null], ['assistant', 'final', '复制回复']]) {
    const html = renderToStaticMarkup(createElement(Message, { message: { id: 'same-message', role, phase, text: 'Preserve this message.', timestamp } }));
    assert.match(html, /data-message-id="same-message"/);
    assert.match(html, /<footer class="message-footer">[\s\S]*<time class="message-timestamp"/);
    assert.ok(html.includes(`dateTime="${new Date(timestamp).toISOString()}"`));
    assert.match(html, /title="消息时间：[^"]+" aria-label="消息时间：[^"]+">12分钟前<\/time>/);
    assert.equal((html.match(/class="message-timestamp"/g) || []).length, 1);
    assert.ok(html.indexOf('Preserve this message.') < html.indexOf('<footer'));
    if (label) assert.ok(html.includes(`aria-label="${label}"`));
    else assert.doesNotMatch(html, /copy-button|复制过程/);
  }
});

test('process messages lose their entire footer at one hour, without changing normal replies', () => {
  const now = messageClock.getSnapshot(), hour = 60 * 60_000;
  for (const age of [hour, hour + 1, 2 * hour, 24 * hour]) {
    const message = { id: 'old-process', role: 'assistant', phase: 'commentary', text: 'The original process stays readable.', timestamp: now - age };
    const html = renderToStaticMarkup(createElement(Message, { message }));
    assert.match(html, /The original process stays readable/);
    assert.doesNotMatch(html, /message-footer|message-timestamp|copy-button|小时前|复制过程/);
    for (const [role, phase, copy] of [['user', 'commentary', '复制这条消息'], ['assistant', 'final', '复制回复'], ['assistant', undefined, '复制回复']]) {
      const normal = renderToStaticMarkup(createElement(Message, { message: { ...message, role, phase } }));
      assert.match(normal, /message-timestamp/);
      assert.ok(normal.includes(copy));
    }
  }
});

test('process messages with no usable timestamp have no footer, even with readable text', () => {
  for (const timestamp of [undefined, null, 0, Number.NaN, Infinity]) {
    const html = renderToStaticMarkup(createElement(Message, { message: { id: 'undated-process', role: 'assistant', phase: 'commentary', text: 'Undated progress.', timestamp } }));
    assert.match(html, /Undated progress/);
    assert.doesNotMatch(html, /message-footer|message-timestamp|copy-button/);
  }
});

test('removing the process footer preserves code-block copy and final duration metadata', () => {
  const timestamp = messageClock.getSnapshot() - 2 * 60 * 60_000;
  const process = renderToStaticMarkup(createElement(Message, { message: { id: 'process-code', role: 'assistant', phase: 'commentary', text: '```js\nconsole.log("preserved")\n```', timestamp } }));
  assert.match(process, /copy-button/);
  assert.doesNotMatch(process, /message-footer|复制过程/);
  const final = renderToStaticMarkup(createElement(Message, { message: { id: 'final-duration', role: 'assistant', phase: 'final_answer', text: 'Done.', timestamp, turnDurationMs: 65000 } }));
  assert.match(final, /总用时 <time>1:05<\/time>/);
  assert.match(final, /message-timestamp/);
  assert.match(final, /复制回复/);
});

test('missing and invalid timestamps add no time or empty footer', () => {
  for (const timestamp of [undefined, null, 0, Number.NaN, Infinity]) {
    const html = renderToStaticMarkup(createElement(Message, { message: { id: 'no-time', role: 'user', text: '', timestamp } }));
    assert.doesNotMatch(html, /message-timestamp|message-footer|刚刚/);
  }
});

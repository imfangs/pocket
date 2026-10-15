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
  for (const [role, phase, label] of [['user', undefined, '复制这条消息'], ['assistant', 'commentary', '复制过程'], ['assistant', 'final', '复制回复']]) {
    const html = renderToStaticMarkup(createElement(Message, { message: { id: 'same-message', role, phase, text: 'Preserve this message.', timestamp } }));
    assert.match(html, /data-message-id="same-message"/);
    assert.match(html, /<footer class="message-footer">[\s\S]*<time class="message-timestamp"/);
    assert.ok(html.includes(`dateTime="${new Date(timestamp).toISOString()}"`));
    assert.match(html, /title="消息时间：[^"]+" aria-label="消息时间：[^"]+">12分钟前<\/time>/);
    assert.equal((html.match(/class="message-timestamp"/g) || []).length, 1);
    assert.ok(html.indexOf('Preserve this message.') < html.indexOf('<footer'));
    assert.ok(html.includes(`aria-label="${label}"`));
  }
});

test('missing and invalid timestamps add no time or empty footer', () => {
  for (const timestamp of [undefined, null, 0, Number.NaN, Infinity]) {
    const html = renderToStaticMarkup(createElement(Message, { message: { id: 'no-time', role: 'user', text: '', timestamp } }));
    assert.doesNotMatch(html, /message-timestamp|message-footer|刚刚/);
  }
});

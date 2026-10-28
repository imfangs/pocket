import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: EarlierHistoryMessage } = await vite.ssrLoadModule('/src/earlierHistoryMessage.tsx');
after(() => vite.close());
test('historical user rows reuse the collapsed original query body without delivery or read controls', () => {
  const html = renderToStaticMarkup(React.createElement(EarlierHistoryMessage, { threadId: 'fixture', message: {
    id: 'old-query', role: 'user', text: 'Original long query.\n\n'.repeat(20), clientMessageId: 'unconfirmed-request',
  } }));
  assert.match(html, /class="user-query-body" data-query-expanded="false"/);
  assert.match(html, /Original long query/);
  assert.doesNotMatch(html, /data-query-id|query-controls|message-send-confirmed|data-pocket-read-marker/);
});

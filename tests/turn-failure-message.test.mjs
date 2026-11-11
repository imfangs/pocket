import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: Failure } = await vite.ssrLoadModule('/src/TurnFailureMessage.tsx'); after(() => vite.close());
const render = failure => renderToStaticMarkup(createElement(Failure, { failure }));
test('known demand failure presents a small summary with original diagnostic details safely escaped', () => {
  const html = render({ turnId: 'turn', message: 'We’re currently experiencing high demand, which may cause temporary errors.', code: 'internal_server_error', additionalDetails: '<script>unsafe()</script>' });
  assert.match(html, /本轮运行失败/); assert.match(html, /服务繁忙，本轮未能完成/); assert.match(html, /查看错误详情/);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>|data-message-id|重新发送|retry/);
});
test('failed status with no reason is explicit and creates no pretend diagnostic or action', () => {
  const html = render({ turnId: 'empty' }); assert.match(html, /未收到具体错误原因/); assert.doesNotMatch(html, /turn-failure-disclosure|copy-button|conversation-working/);
});

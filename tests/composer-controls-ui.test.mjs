import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: ContextStatus }, { default: StopExecution }] = await Promise.all([
  vite.ssrLoadModule('/src/ContextStatus.tsx'), vite.ssrLoadModule('/src/StopExecution.tsx'),
]);
after(() => vite.close());

const render = (Component, history) => renderToStaticMarkup(createElement(Component, {
  threadId: 'composer-controls-fixture', history, disabled: false, refresh: async () => {}, notify() {},
}));
const contextUsage = { percent: 37.2, usedTokens: 37200, contextWindow: 100000 };
const visibleText = html => html.replace(/<[^>]*>/g, '').trim();

test('context trigger uses a compact percentage while keeping its purpose accessible', () => {
  const html = render(ContextStatus, { contextUsage });
  assert.equal(visibleText(html), '37%');
  assert.match(html, /type="button"/);
  assert.match(html, /aria-label="上下文用量 37%"/);
  assert.match(html, /title="上下文用量 37%"/);
});

test('missing usage and unresolved compaction stay understandable in the compact composer', () => {
  assert.equal(visibleText(render(ContextStatus, null)), '上下文');
  assert.equal(visibleText(render(ContextStatus, { contextUsage, compaction: { active: true } })), '压缩中…');
  for (const status of ['pending', 'accepted', 'unknown']) {
    const html = render(ContextStatus, { contextUsage, compactionRequest: { requestId: 'original-compaction', status } });
    assert.equal(visibleText(html), '压缩待核对', status);
    assert.match(html, /aria-label="上下文用量 37%，压缩结果待核对"/);
  }
  assert.equal(visibleText(render(ContextStatus, { contextUsage, compactionRequest: { requestId: 'completed-compaction', status: 'completed' } })), '37%');
});

test('unresolved stops remain available for verification after the runtime stops advertising canStop', () => {
  for (const status of ['pending', 'accepted', 'unknown']) {
    const html = render(StopExecution, { canStop: false, stopRequest: { requestId: 'original-stop', status } });
    assert.match(html, /aria-label="核对停止状态"/, status);
    assert.match(html, /data-waiting="true"/);
    assert.doesNotMatch(html, /disabled=/);
  }
});

test('stop control distinguishes current execution from a settled receipt', () => {
  assert.equal(render(StopExecution, { canStop: false, stopRequest: { requestId: 'settled-stop', status: 'stopped' } }), '');
  const html = render(StopExecution, { canStop: true, activeTurnId: 'current-turn' });
  assert.match(html, /type="button"/);
  assert.match(html, /aria-label="停止当前执行"/);
  assert.doesNotMatch(html, /data-waiting=/);
});

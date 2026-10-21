import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const previousWindow = global.window;
const events = new EventTarget(), data = new Map();
global.window = { location: { search: '?machine=ged' },
  localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) },
  addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events) };
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' },
  optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const [{ default: SendingSettings }, { default: Outbox }, preference] = await Promise.all([
  vite.ssrLoadModule('/src/SendingSettings.tsx'), vite.ssrLoadModule('/src/Outbox.tsx'), vite.ssrLoadModule('/src/sendingPreference.ts'),
]);
after(async () => { global.window = previousWindow; await vite.close(); });

test('settings show an accessible default-on native switch with the new-submission boundary', () => {
  const html = renderToStaticMarkup(createElement(SendingSettings));
  assert.match(html, /<button[^>]*type="button"[^>]*role="switch"[^>]*aria-checked="true"/);
  assert.match(html, /自动直接发送/);
  assert.match(html, /支持时立即发送，否则排队。仅对新提交的消息生效。/);
  const controlId = html.match(/<button[^>]*id="([^"]+)"/)[1];
  assert.ok(html.includes(`for="${controlId}"`));
  assert.ok(html.includes(`aria-describedby="${controlId}-help"`));
  assert.equal(data.size, 0, 'rendering does not persist or submit anything');
  preference.saveAutoDirectPreference(false);
  assert.match(renderToStaticMarkup(createElement(SendingSettings)), /aria-checked="false"/);
});

function renderQueue(items, props = {}) {
  return renderToStaticMarkup(createElement(Outbox, { threadId: 'fixture', items, disabled: false, allowSend: true,
    drafts: new Map(), refresh: async () => {}, ...props }));
}
const item = { id: 'queue-item', revision: 1, createdAt: 1, status: 'queued', text: 'Keep this exact message.' };

test('queue wording reads only the saved head intent and preserves the manual action', () => {
  preference.saveAutoDirectPreference(true);
  assert.match(renderQueue([item]), /本轮结束后依次发送/);
  assert.match(renderQueue([{ ...item, autoDirect: false }]), /本轮结束后依次发送/);
  assert.match(renderQueue([item, { ...item, id: 'second', autoDirect: true }]), /本轮结束后依次发送/);
  preference.saveAutoDirectPreference(false);
  const automatic = renderQueue([{ ...item, autoDirect: true }]);
  assert.match(automatic, /可接收时依次发送/);
  assert.match(automatic, />直接发送<\/button>/);
  assert.match(automatic, /Keep this exact message\./);
});

test('queue recovery and explicit paused, editing, failed, and unknown states retain priority', () => {
  const automatic = { ...item, autoDirect: true };
  for (const [items, props, message] of [
    [[automatic], { connectionPending: true }, '连接恢复后依次发送'],
    [[automatic], { paused: { stopId: 'stop' } }, '队列已暂停'],
    [[{ ...automatic, status: 'editing' }], {}, '首条已暂停'],
    [[{ ...automatic, status: 'rejected' }], {}, '首条发送未完成，请先处理'],
    [[{ ...automatic, status: 'unknown' }], {}, '首条结果待核对，队列已暂停'],
  ]) {
    const html = renderQueue(items, props);
    assert.ok(html.includes(message));
    assert.doesNotMatch(html, /可接收时依次发送/);
  }
});

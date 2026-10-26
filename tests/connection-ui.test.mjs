import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

// Portal targets are DOM refs, so SSR cannot render their action subtree. Capture
// the real Conversation boundary props; controller actions have their own tests.
const probeKey = Symbol.for('pocket.ssr.connection-ui.test.mjs');
globalThis[probeKey] = {};
const controllerBoundary = {
  name: 'capture-conversation-controller-props', enforce: 'pre',
  resolveId(source, importer) {
    if (importer?.endsWith('/src/Conversation.tsx') && ['./Outbox'].includes(source))
      return '\0' + 'pocket.ssr.connection-ui.test.mjs' + source;
  },
  load(id) {
    if (!id.startsWith('\0' + 'pocket.ssr.connection-ui.test.mjs')) return;
    const name = id.endsWith('/Outbox') ? 'outbox' : 'submitted';
    return `export default function ControllerBoundary(props) { globalThis[Symbol.for(${JSON.stringify('pocket.ssr.connection-ui.test.mjs')})][${JSON.stringify(name)}] = props; return null; }`;
  },
};

const vite = await createServer({ plugins: [controllerBoundary], configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: Conversation } = await vite.ssrLoadModule('/src/Conversation.tsx');
after(async () => { delete globalThis[probeKey]; await vite.close(); });
const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const connection = status => ({ requestId: 'connection-one', status, startedAt: 10, checkedAt: 20, ...(status === 'failed' ? { code: 'connection_timeout' } : {}) });
function render(state, override = {}, seed = 'Keep this draft') {
  const history = { source: 'rollout', runtime: 'unavailable', canSend: false, canQueue: true, canAttemptSend: true, messages: [], outbox: [{ id: 'q', text: 'Saved instruction', status: 'queued', revision: 0 }], checkedAt: 15, hint: '显示已保存的历史。连接 Mac 中的原任务后可发送消息。', connection: connection(state), ...override };
  const drafts = new Map([[id, typeof seed === 'string' ? { text: seed } : seed]]);
  globalThis[probeKey] = {};
  const html = renderToStaticMarkup(createElement(Conversation, { thread: { id, archived: false, missing: false }, drafts, historyCache: new Map([[id, { history, scrollTop: 0, nearBottom: true }]]), onConnect: async () => ({ connection: connection('connecting') }) }));
  return { html, drafts, controls: { ...globalThis[probeKey] } };
}

function assertPrimaryAction(html, { type, disabled, text }) {
  const matches = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(match =>
    (match[1].match(/(?:^|\s)class="([^"]*)"/)?.[1].split(/\s+/) || []).includes('primary'));
  assert.equal(matches.length, 1, 'exactly one primary action is visible');
  const [, attributes, content] = matches[0];
  assert.match(attributes, new RegExp(`(?:^|\\s)type="${type}"`));
  assert.equal(/(?:^|\s)disabled(?:=""|\s|$)/.test(attributes), disabled, 'primary action disabled state');
  assert.equal(content.replace(/<[^>]*>/g, ''), text);
}

test('an acknowledged handoff remains visibly connecting and keeps the composer draft editable', () => {
  const { html, drafts } = render('connecting');
  assert.match(html, /连接中…/);
  assert.doesNotMatch(html, /连接原任务|conversation-connect"/);
  assert.match(html, /<textarea[^>]*>Keep this draft<\/textarea>/);
  assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
  assert.equal(drafts.get(id).text, 'Keep this draft');
});

test('failed connection preserves queued text and draft, with one main submission action', () => {
  const { html, drafts } = render('failed');
  assert.match(html, /连接超时/);
  assert.doesNotMatch(html, /重试连接/);
  assert.match(html, /Saved instruction/);
  assert.equal(drafts.get(id).text, 'Keep this draft');
});

test('verified connection does not grant sending permission before a fresh desktop snapshot', () => {
  const { html } = render('connected', { outbox: [] });
  assert.match(html, /同步中…/);
  assert.doesNotMatch(html, /发送并连接|连接原任务/);
  assert.match(html, />发送<\/button>/);
});

test('a newer fallback read does not keep claiming an old verified connection is live', () => {
  const { html } = render('connected', { checkedAt: 30 });
  assert.doesNotMatch(html, /同步中…/);
  assert.match(html, /连接中断/);
});

test('empty failed input reuses the primary button for connection retry', () => {
  const { html } = render('failed', { outbox: [] }, '');
  assertPrimaryAction(html, { type: 'button', disabled: false, text: '重试连接' });
  assert.doesNotMatch(html, /conversation-connect"/);
  assert.match(html, /class="composer-text-field"[\s\S]*class="composer-inline-state" role="status"[^>]*aria-label="[^"]+"/);
  assert.match(html, /<span>连接失败<\/span>/);
});

test('empty connecting input shows a disabled primary connection action', () => {
  const { html } = render('connecting', { outbox: [] }, '');
  assertPrimaryAction(html, { type: 'button', disabled: true, text: '连接中…' });
  assert.match(html, /composer-connection-spinner/);
});

test('even an empty legacy unknown draft keeps a receipt-check action instead of reconnecting', () => {
  const { html } = render('failed', { outbox: [] }, { text: '', requestId: 'previous-request' });
  assertPrimaryAction(html, { type: 'submit', disabled: false, text: '核对发送状态' });
  assert.doesNotMatch(html, /重试连接/);
});

test('a fresh resumed desktop clears an old failed connection without overriding approval restrictions', () => {
  const { html } = render('failed', { source: 'desktop', resumeState: 'resumed', checkedAt: 100, canSend: false, canAttemptSend: false, hint: '请先处理原任务中的确认。', pendingRequests: [{ key: 'k', kind: 'unsupported', reason: '请在 Mac 处理', choices: [] }] });
  assert.doesNotMatch(html, /同步中…/);
  assert.doesNotMatch(html, /连接超时|重试连接/);
  assert.match(html, /请先处理会话中的确认/);
  assert.doesNotMatch(html, />发送<\/button>/);
});

test('incompatible history keeps text editable and queue storage available without promising automatic connection', () => {
  for (const readOnlyReason of ['desktop_protocol_incompatible', 'unsupported_app_identity', 'app_version_changed']) {
    const { html, drafts, controls } = render('idle', { connection: { status: 'idle' }, readOnlyReason, canAttemptSend: false, canAttemptCompact: false });
    assert.match(html, /class="composer-text-field"[\s\S]*class="composer-inline-state" role="status"/);
    assert.match(html, /<span>暂不可连接<\/span>/);
    assert.doesNotMatch(html, /版本已变化|提交消息后自动连接|发送并连接/);
    assert.equal(controls.outbox.allowSend, false, 'incompatible history forbids immediate queue dispatch');
    assert.equal(controls.outbox.items[0].status, 'queued');
    assert.ok(controls.outbox.inlineTargets instanceof Map);
    assertPrimaryAction(html, { type: 'submit', disabled: false, text: '加入队列' });
    assert.match(html, /加入队列/);
    assert.match(html, /Saved instruction/);
    assert.doesNotMatch(html.match(/<textarea[^>]*>/)[0], /disabled/);
    assert.equal(drafts.get(id).text, 'Keep this draft');
    const emptyQueue = render('idle', { connection: { status: 'idle' }, readOnlyReason, canAttemptSend: false, outbox: [] }).html;
    assert.doesNotMatch(emptyQueue, /发送并连接/);
    assert.match(emptyQueue, /加入队列/);
  }
});

test('an incompatible connection result blocks stale sending permissions before history finishes refreshing', () => {
  const { html, controls } = render('failed', { connection: { ...connection('failed'), code: 'desktop_protocol_incompatible' }, canAttemptSend: true });
  assert.match(html, /Codex 接口暂不兼容/);
  assert.equal(controls.outbox.allowSend, false, 'connection incompatibility overrides stale canAttemptSend');
  assert.doesNotMatch(html, /发送并连接/);
});

test('fresh resumed history clears an old incompatible connection while preserving the queued text and draft', () => {
  const { html, drafts, controls } = render('failed', { connection: { ...connection('failed'), code: 'desktop_protocol_incompatible' },
    source: 'desktop', resumeState: 'resumed', checkedAt: 100, canSend: true, canAttemptSend: true,
    hint: '消息会在 Mac 的原任务中运行，沿用原模型与权限。' });
  assert.doesNotMatch(html, /Codex 接口暂不兼容|重试连接/);
  assert.equal(controls.outbox.allowSend, true, 'fresh resumed history restores explicit queue dispatch');
  assert.equal(controls.outbox.disabled, false);
  assert.match(html, /Saved instruction/);
  assert.equal(drafts.get(id).text, 'Keep this draft');
});

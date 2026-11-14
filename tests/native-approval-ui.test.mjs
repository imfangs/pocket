import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
  esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const { default: RequestActions } = await vite.ssrLoadModule('/src/RequestActions.tsx');
after(() => vite.close());
const id = index => String(index).padStart(64, '0');
const command = { key: 'request', kind: 'command', reason: 'Synthetic approval', cwd: '/synthetic', command: 'git diff --stat', choices: ['accept', 'cancel'] };
const render = request => renderToStaticMarkup(createElement(RequestActions, {
  threadId: 'thread', requests: [request], disabled: false, refresh: async () => {}, drafts: new Map(),
}));

test('native choices expose their explicit scope instead of silently falling back to legacy once-only buttons', () => {
  const html = render({ ...command, approvalOptions: [
    { id: id(1), kind: 'accept', scope: 'once' },
    { id: id(2), kind: 'acceptForSession', scope: 'session' },
    { id: id(3), kind: 'execpolicy', scope: 'rule', rule: ['git', 'diff'] },
    { id: id(4), kind: 'decline', scope: 'once' },
    { id: id(5), kind: 'cancel', scope: 'once' },
  ] });
  assert.match(html, /本会话内允许/);
  assert.match(html, /允许命令前缀/);
  assert.match(html, /git diff/);
  assert.match(html, /拒绝操作/);
  assert.match(html, /中断执行/);
  assert.equal([...html.matchAll(/class="[^"]*\bprimary\b[^\"]*"/g)].length, 1, 'Only the once option is the primary action');
  assert.doesNotMatch(html, /拒绝本次/);
});

test('presence of an empty or malformed native option list never invents a legacy grant', () => {
  for (const approvalOptions of [[], null, {}, [{ id: id(1), kind: 'accept', scope: 'session' }]]) {
    const html = render({ ...command, approvalOptions });
    assert.doesNotMatch(html, />允许这一次<|>本会话内允许<|>拒绝本次</);
  }
  assert.match(render(command), /允许这一次/);
});

test('directory and file-session grants identify their actual scope and never masquerade as one-time approval', () => {
  const html = render({ ...command, kind: 'file', command: undefined, details: '/synthetic/src/file.txt\n+changed line',
    approvalOptions: [{ id: id(1), kind: 'accept', scope: 'session', grantRoot: '/synthetic/src' },
      { id: id(2), kind: 'acceptForSession', scope: 'session', grantRoot: '/synthetic/src' }] });
  assert.match(html, /允许目录授权/);
  assert.match(html, /\/synthetic\/src/);
  assert.match(html, /这些文件后续允许/);
  assert.match(html, /上方这些文件/);
  assert.doesNotMatch(html, /允许这一次|class="[^"]*\bprimary\b/);
});

test('permissions session and network rules are reviewable and do not repeat a native object as opaque JSON', () => {
  const permissions = render({ ...command, kind: 'permissions', command: undefined, details: 'Network access; read /synthetic/input',
    approvalOptions: [{ id: id(1), kind: 'permissionTurn', scope: 'turn' }, { id: id(2), kind: 'permissionSession', scope: 'session' },
      { id: id(3), kind: 'cancel', scope: 'turn' }] });
  assert.match(permissions, /本会话允许这些权限/);
  assert.match(permissions, /上方申请的权限/);
  assert.doesNotMatch(permissions, /申请权限 · 仅本轮/);
  assert.match(permissions, /拒绝权限/); assert.doesNotMatch(permissions, /中断执行/);
  const network = render({ ...command, approvalOptions: [{ id: id(1), kind: 'networkPolicy', scope: 'rule', host: 'example.test', action: 'allow' },
    { id: id(2), kind: 'networkPolicy', scope: 'rule', host: 'blocked.test', action: 'deny' }] });
  assert.match(network, /添加网络允许规则/); assert.match(network, /添加网络拒绝规则/);
  assert.match(network, /example\.test/); assert.match(network, /blocked\.test/);
  assert.doesNotMatch(network, /&quot;optionId&quot;|&quot;nativeDecision&quot;|execpolicy_amendment/);
});

test('an unknown native approval receipt provides verification only and preserves answer drafts', () => {
  const html = render({ ...command, approvalOptions: [{ id: id(1), kind: 'acceptForSession', scope: 'session' }],
    response: { responseId: 'existing-response', status: 'unknown' } });
  assert.match(html, /结果待核对，不会重复响应/); assert.match(html, /核对状态/);
  assert.doesNotMatch(html, /本会话内允许/);
});

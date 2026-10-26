import test from 'node:test';
import assert from 'node:assert/strict';
import { compactionKeepsComposerExpanded, desktopComposerHint } from '../src/composerStatus.ts';

const history = { source: 'desktop', canSend: false, hint: '', messages: [], runtime: 'active', checkedAt: 1 };

test('compaction boilerplate is redundant only when its actual status is available', () => {
  const hint = '正在压缩上下文，完成后可继续。';
  assert.equal(desktopComposerHint({ ...history, hint }), hint);
  assert.equal(desktopComposerHint({ ...history, hint, compaction: { active: false } }), hint);
  assert.equal(desktopComposerHint({ ...history, hint, compaction: { active: true } }), undefined);
  assert.equal(desktopComposerHint({ ...history, hint: '需要核对的新状态', compaction: { active: true } }), '需要核对的新状态');
});

test('the exact approval summary is omitted only when corresponding cards exist', () => {
  const hint = '任务正在等待你确认操作，可在下方查看并响应。';
  assert.equal(desktopComposerHint({ ...history, hint, pendingRequests: [] }), hint);
  assert.equal(desktopComposerHint({ ...history, hint, pendingRequests: [{ key: 'approval' }] }), undefined);
  assert.equal(desktopComposerHint({ ...history, hint: '任务正在等待审批或输入，请在 Mac 的 Codex 中处理。', pendingRequests: [{ key: 'approval' }] }),
    '任务正在等待审批或输入，请在 Mac 的 Codex 中处理。');
});

test('unfamiliar restrictions and non-sendable desktop explanations remain visible', () => {
  const hint = '消息会在 Mac 的原任务中运行，沿用原模型与权限。';
  assert.equal(desktopComposerHint({ ...history, hint, canSend: true }), undefined);
  assert.equal(desktopComposerHint({ ...history, hint }), hint.replaceAll('原任务', '会话'));
  assert.equal(desktopComposerHint({ ...history, hint: '新权限需要在 Mac 上处理。', canSend: true }), '新权限需要在 Mac 上处理。');
  assert.equal(desktopComposerHint(null), undefined);
});

test('known background compaction can collapse while unconfirmed controls retain space', () => {
  assert.equal(compactionKeepsComposerExpanded(), false);
  // Native progress can disappear a render before the owner's terminal receipt.
  // The accepted request remains visible, so that intermediate render must not
  // reopen the editor underneath an already-open context popover.
  assert.equal(compactionKeepsComposerExpanded('accepted'), false);
  for (const status of ['pending', 'unknown']) assert.equal(compactionKeepsComposerExpanded(status), true);
  for (const status of ['completed', 'failed', 'rejected', 'not_found']) assert.equal(compactionKeepsComposerExpanded(status), false);
});

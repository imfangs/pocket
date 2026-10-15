import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeRenameOperation, renameNameError, renameOperationText, renameRequest, renameSourceHint, renameUnresolved } from '../src/threadRename.ts';

const pending = { requestId: 'request-one', threadId: 'thread-one', name: '新名称', status: 'pending' };

test('renaming accepts Chinese names and enforces the native UTF-16 limit after trimming', () => {
  assert.equal(renameNameError('  格得 — 修炼  '), null);
  assert.equal(renameNameError('名'.repeat(220)), null);
  assert.match(renameNameError('名'.repeat(221)), /220/);
  assert.equal(renameNameError('  ' + '😀'.repeat(110) + '  '), null);
  assert.match(renameNameError('😀'.repeat(111)), /220/);
  assert.equal(renameNameError('😀'.repeat(109) + '名字'), null);
  assert.match(renameNameError('😀'.repeat(109) + '名字长'), /220/);
  assert.match(renameNameError(' \n\t '), /请输入/);
});

test('renaming rejects Cc, line and paragraph separators even at the trimmed boundary', () => {
  for (const control of ['\u0000', '\t', '\n', '\r', '\u007f', '\u0085', '\u2028', '\u2029']) {
    assert.match(renameNameError(`名称${control}继续`), /换行或控制字符/);
    assert.match(renameNameError(`${control}名称${control}`), /换行或控制字符/);
  }
  assert.equal(renameNameError('格得 — 健康🏃‍♂️'), null);
  assert.match(renameNameError('名称\ud800'), /无效字符/);
  assert.match(renameNameError('\udfff名称'), /无效字符/);
});

test('automatic titles use the observed display title and fingerprint as rename preconditions', () => {
  const source = { title: '自动生成的原标题', name: null, nameFingerprint: 'exact-observation', canRename: true };
  assert.deepEqual(renameRequest(source, '  新名称  ', pending.requestId), {
    requestId: pending.requestId, name: '新名称', expectedName: source.title, expectedFingerprint: source.nameFingerprint,
  });
  assert.equal(source.name, null);
});

test('pending and unknown rename receipts remain unresolved until readback confirms a terminal result', () => {
  assert.equal(renameUnresolved(pending), true);
  const unknown = mergeRenameOperation(pending, { ...pending, status: 'unknown' });
  assert.equal(renameUnresolved(unknown), true);
  const succeeded = mergeRenameOperation(unknown, { ...unknown, status: 'succeeded', thread: { id: pending.threadId, title: pending.name } });
  assert.equal(renameUnresolved(succeeded), false);
  assert.equal(mergeRenameOperation(succeeded, pending), succeeded);
  for (const status of ['rejected', 'changed']) assert.equal(renameUnresolved({ ...pending, status }), false);
});

test('unrelated requests cannot replace the receipt being checked', () => {
  assert.equal(mergeRenameOperation(pending, { ...pending, requestId: 'other-request', status: 'succeeded' }), pending);
  assert.equal(mergeRenameOperation(pending, { ...pending, threadId: 'other-thread', status: 'succeeded' }), pending);
});

test('rename feedback distinguishes uncertain results and concurrent title changes', () => {
  assert.match(renameOperationText({ ...pending, status: 'unknown' }), /尚未确认.*核对/);
  assert.match(renameOperationText({ ...pending, status: 'changed' }), /已变化.*重新读取/);
  assert.match(renameOperationText({ ...pending, status: 'rejected' }), /未能重命名/);
  const notApplied = { ...pending, status: 'rejected', code: 'rename_not_applied' };
  assert.match(renameOperationText(notApplied), /未生效.*可重新保存/);
  assert.equal(renameUnresolved(notApplied), false);
});

test('source hints match archived and unavailable codes emitted by the service', () => {
  assert.match(renameSourceHint({ code: 'archived_thread' }), /先恢复/);
  assert.match(renameSourceHint({ code: 'thread_not_found' }), /刷新后再试/);
  assert.match(renameSourceHint({ code: 'lifecycle_pending' }), /未完成的管理操作/);
  for (const code of ['app_version_changed', 'cli_version_changed']) assert.match(renameSourceHint({ code }), /版本已变化/);
});

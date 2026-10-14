import test from 'node:test';
import assert from 'node:assert/strict';
import { activeOperation, creationRecoveryIds, failedOperation, mergeOperation, operationCheckError, operationCancelLabel, operationText, pollOperation, readCreationRecoveryIds, saveCreationRecoveryIds } from '../src/taskOperations.ts';
import { filterThreads } from '../src/model.ts';

test('created and first-message delivery are distinct; terminal creation only updates the matching message receipt', () => {
  const current={requestId:'create',operation:'create',status:'succeeded',creationStatus:'created',threadId:'task',initialMessage:{requestId:'first',status:'queued'}};
  assert.doesNotMatch(operationText(current),/已发送/);
  const accepted=mergeOperation(current,{...current,initialMessage:{requestId:'first',status:'accepted'}});
  assert.equal(accepted.status,'succeeded');assert.match(operationText(accepted),/已发送/);
  assert.equal(mergeOperation(current,{...current,initialMessage:{requestId:'different',status:'accepted'}}),current);
  const unknown={...current,status:'unknown',initialMessage:{requestId:'first',status:'not_queued'}};
  assert.match(operationText(unknown),/已创建/);assert.doesNotMatch(operationText(unknown),/已发送/);
});

const operation = status => ({ requestId: 'one', operation: 'archive', status, threadId: 'thread' });
test('only proven pre-forward failures release a create; missing or lost replies stay unknown', () => {
  const initial = { requestId: 'one', operation: 'create', status: 'pending' };
  const rejected = failedOperation(initial, { status: 503, code: 'relay_not_forwarded' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(activeOperation(rejected), false);
  assert.match(operationText(rejected), /还未送达 Mac/);
  for (const failure of [{}, { name: 'TimeoutError' }, { status: 503 }, { status: 502 },
    { status: 503, code: 'relay_unavailable' }, { status: 500, code: 'relay_not_forwarded' }]) {
    const result = failedOperation(initial, failure);
    assert.equal(result.status, 'unknown'); assert.equal(result.requestId, initial.requestId);
    assert.match(operationText(result), /结果尚未确认/);
  }
  assert.match(operationCheckError({ status: 404 }), /暂未找到/);
  assert.match(operationCheckError({ status: 503, code: 'relay_not_forwarded' }), /连接不到 Mac/);
  assert.match(operationCheckError({ status: 503, code: 'relay_unavailable' }), /连接不到 Mac/);
  assert.match(operationCheckError({ name: 'TimeoutError' }), /超时/);
  assert.match(operationCheckError({ status: 401 }), /登录已过期/);
});
test('waiting archive remains active and pollable, while unknown offers only explicit receipt checking', () => {
  assert.equal(activeOperation(operation('waiting')), true);
  assert.equal(pollOperation(operation('waiting')), true);
  assert.equal(activeOperation(operation('unknown')), true);
  assert.equal(pollOperation(operation('unknown')), false);
  assert.match(operationText(operation('waiting')), /等待 Codex 释放/);
  assert.doesNotMatch(operationText(operation('waiting')), /已归档/);
});
test('late polls cannot undo a confirmed archive or cancellation, and mismatched receipts are ignored', () => {
  for (const status of ['succeeded', 'cancelled', 'changed', 'rejected']) {
    const current = operation(status);
    assert.equal(mergeOperation(current, operation('pending')), current);
  }
  const current = operation('waiting');
  assert.equal(mergeOperation(current, { ...operation('succeeded'), requestId: 'other' }), current);
  assert.equal(mergeOperation(current, { ...operation('succeeded'), operation: 'create' }), current);
  const newer = { ...current, updatedAt: 100 };
  assert.equal(mergeOperation(newer, { ...operation('pending'), updatedAt: 50 }), newer);
  assert.equal(mergeOperation(current, { ...operation('succeeded'), threadId: 'another' }), current);
});
test('archive blockers distinguish queued content from an uncertain send', () => {
  assert.match(operationText({ ...operation('rejected'), code: 'outbox_not_empty' }), /待发消息/);
  assert.match(operationText({ ...operation('rejected'), code: 'unresolved_send' }), /尚未确认/);
  assert.match(operationText({ ...operation('rejected'), code: 'active_or_unknown_thread' }), /尚未确认结束/);
});
test('waiting and cancellation describe the actual action without promising that external state is unchanged', () => {
  const restore = { ...operation('waiting'), operation: 'restore' };
  assert.match(operationText(restore), /释放后自动恢复/);
  assert.equal(operationCancelLabel(restore), '取消等待恢复');
  assert.equal(operationCancelLabel(operation('waiting')), '取消等待归档');
  assert.equal(operationCancelLabel(operation('unknown')), '停止后续尝试');
  assert.equal(operationCancelLabel({ ...operation('unknown'), operation: 'create' }), '停止核对');
  assert.equal(operationCancelLabel({ ...operation('pending'), operation: 'create' }), null);
  assert.equal(operationText(operation('cancelled')), '已取消等待。');
});
test('unfinished creation recovery stores only request IDs and survives a page reload', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
  saveCreationRecoveryIds([id, id, 'name or private cwd'], storage);
  assert.deepEqual(readCreationRecoveryIds(storage), [id]);
  assert.equal([...values.values()][0], JSON.stringify([id]));
  saveCreationRecoveryIds([], storage);
  assert.deepEqual(readCreationRecoveryIds(storage), []);
});
test('a definite creation rejection before server reservation is removed from reload recovery', () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const requestId = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', watched = new Set([requestId]);
  let current = { requestId, operation: 'create', status: 'pending' };
  saveCreationRecoveryIds(creationRecoveryIds([current], watched), storage);
  assert.deepEqual(readCreationRecoveryIds(storage), [requestId]);
  current = mergeOperation(current, { ...current, status: 'rejected', message: '工作目录已变化' });
  saveCreationRecoveryIds(creationRecoveryIds([current], watched), storage);
  assert.deepEqual(readCreationRecoveryIds(storage), []);
  assert.equal(activeOperation(current), false);
  for (const status of ['pending', 'waiting', 'unknown', 'succeeded']) {
    assert.deepEqual(creationRecoveryIds([{ ...current, status }], watched), [requestId]);
  }
  assert.deepEqual(creationRecoveryIds([{ ...current, status: 'succeeded' }], new Set()), []);
});
test('stopping an unconfirmed creation frees recovery without claiming to remove an existing thread', () => {
  const current = { requestId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', operation: 'create', status: 'unknown' };
  assert.equal(operationCancelLabel(current), '停止核对');
  const cancelled = mergeOperation(current, { ...current, status: 'cancelled' });
  assert.equal(activeOperation(cancelled), false);
  assert.deepEqual(creationRecoveryIds([cancelled], new Set([current.requestId])), []);
  assert.match(operationText(cancelled), /已停止此次新建结果核对/);
  assert.match(operationText(cancelled), /可能已创建的会话会保留/);
  assert.doesNotMatch(operationText(cancelled), /未创建|已删除|保持原状/);
});
test('every ordinary list excludes truly archived tasks while the archive view retains them', () => {
  const archived = { id: 'a', archived: true, pinned: true, pinnedOrder: 0, intent: 'active', needsInput: true, lastOpenedAt: 1, groupIds: ['g'], updatedAt: 1, missing: false };
  for (const view of ['all', 'pinned', 'unread', 'running', 'recent']) {
    const row = { ...archived, ...(view === 'later' || view === 'reference' ? { intent: view } : {}) };
    assert.deepEqual(filterThreads([row], view, '', '', 'updated'), [], view);
  }
  assert.equal(filterThreads([archived], 'archived', '', '', 'updated')[0], archived);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessCheck } from '../src/accessCheck.ts';

function fixture() {
  const pending = [], states = [], errors = [];
  const checks = createAccessCheck({
    request: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    onResult: value => states.push(value),
    onFailure: () => errors.push('offline'),
  });
  return { checks, pending, states, errors };
}

test('a late unauthenticated result cannot replace a newer authenticated observation', async () => {
  const f = fixture(), old = f.checks.check(), recent = f.checks.check();
  f.pending[1].resolve(true); await recent;
  f.pending[0].resolve(false); await old;
  assert.deepEqual(f.states, [true]);
});

test('login/logout ignore preceding reads and suppress checks while changing session', async () => {
  for (const oldState of [true, false]) {
    const f = fixture(), old = f.checks.check();
    f.checks.pause();
    await f.checks.check(); assert.equal(f.pending.length, 1);
    f.checks.resume();
    f.pending[0].resolve(oldState); await old;
    assert.deepEqual(f.states, []);
    const fresh = f.checks.check(); f.pending[1].resolve(!oldState); await fresh;
    assert.deepEqual(f.states, [!oldState]);
  }
});

test('expiry and unmount invalidate pending success; stale failures do not show offline UI', async () => {
  const f = fixture(), first = f.checks.check();
  f.checks.invalidate();f.pending[0].resolve(true);await first;
  assert.deepEqual(f.states, []);
  const stale = f.checks.check(), fresh = f.checks.check();
  f.pending[2].resolve(true);await fresh;
  f.pending[1].reject(new Error('old network failure'));await stale;
  assert.deepEqual(f.errors, []);
  const leaving = f.checks.check();f.checks.pause();f.pending[3].resolve(false);await leaving;
  assert.deepEqual(f.states, [true]);
  f.checks.resume();const failed = f.checks.check();f.pending[4].reject(new Error('offline'));await failed;
  assert.deepEqual(f.errors, ['offline']);
});

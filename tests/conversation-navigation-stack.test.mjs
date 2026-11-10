import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationNavigationStack, conversationNavigationStackLimit } from '../src/conversationNavigationStack.ts';

const owner = { machine: 'ged', readingScope: 'source-a' };
const available = () => true;
const stack = () => new ConversationNavigationStack(owner);

test('a committed A → B → C visit returns C → B → A → list', () => {
  const history = stack();
  assert.equal(history.push(null, 'A'), false);
  assert.equal(history.push('A', 'B'), true);
  assert.equal(history.push('B', 'C'), true);
  assert.equal(history.back('C', available), 'B');
  assert.equal(history.back('B', available), 'A');
  assert.equal(history.back('A', available), null);
  assert.equal(history.depth, 0);
});

test('reopening the selected thread adds no parent and keeps the existing chain', () => {
  const history = stack();
  history.push('A', 'B');
  for (let i = 0; i < 50; i++) assert.equal(history.push('B', 'B'), false);
  assert.equal(history.depth, 1);
  assert.equal(history.back('B', available), 'A');
  assert.equal(history.back('A', available), null);
});

test('return follows visits even when the chain revisits an earlier thread', () => {
  const history = stack();
  history.push('A', 'B');
  history.push('B', 'A');
  assert.equal(history.back('A', available), 'B');
  assert.equal(history.back('B', available), 'A');
  assert.equal(history.back('A', available), null);
});

test('long and cyclic visit chains keep only the newest 32 parents and always terminate', () => {
  for (const cyclic of [false, true]) {
    const history = stack(), total = conversationNavigationStackLimit + 10;
    const id = n => cyclic ? (n % 2 ? 'B' : 'A') : `thread-${n}`;
    for (let n = 0; n < total; n++) history.push(id(n), id(n + 1));
    assert.equal(conversationNavigationStackLimit, 32);
    assert.equal(history.depth, conversationNavigationStackLimit);
    let current = id(total);
    for (let n = total - 1; n >= total - conversationNavigationStackLimit; n--) {
      current = history.back(current, available);
      assert.equal(current, id(n));
    }
    assert.equal(history.back(current, available), null);
    assert.equal(history.depth, 0);
  }
});

test('back skips parents confirmed missing, archived or excluded by the current owner', () => {
  const history = stack(), checked = [];
  history.push('A', 'missing');
  history.push('missing', 'archived');
  history.push('archived', 'excluded');
  history.push('excluded', 'E');
  const usable = id => { checked.push(id); return id === 'A'; };
  assert.equal(history.back('E', usable), 'A');
  assert.deepEqual(checked, ['excluded', 'archived', 'missing', 'A']);
  assert.equal(history.back('A', usable), null);
  assert.equal(history.depth, 0);
});

test('all unavailable parents fall through to the list without retaining dead entries', () => {
  const history = stack();
  history.push('A', 'B'); history.push('B', 'C');
  assert.equal(history.back('C', () => false), null);
  assert.equal(history.depth, 0);
  assert.equal(history.back('C', available), null);
});

test('the caller can retain a parent whose availability is temporarily unknown', () => {
  const history = stack();
  history.push('unknown', 'B');
  assert.equal(history.back('B', id => id === 'unknown'), 'unknown');
});

test('replacement, a new root selection and explicit clear each discard the previous visit chain', () => {
  for (const reset of [history => history.replace(), history => history.push(null, 'new-root'), history => history.clear()]) {
    const history = stack();
    history.push('A', 'B'); history.push('B', 'C');
    reset(history);
    assert.equal(history.depth, 0);
    assert.equal(history.back('new-root', available), null);
    history.push('new-root', 'next');
    assert.equal(history.back('next', available), 'new-root');
  }
});

test('machine or reading scope changes clear history even when switching back to a previous owner', () => {
  for (const nextOwner of [{ ...owner, machine: 'wandou' }, { ...owner, readingScope: 'source-b' }]) {
    const history = stack();
    history.push('A', 'B');
    assert.equal(history.setOwner({ ...owner }), false);
    assert.equal(history.depth, 1);
    assert.equal(history.setOwner(nextOwner), true);
    assert.equal(history.back('B', available), null);
    history.push('X', 'Y');
    assert.equal(history.setOwner(owner), true);
    assert.equal(history.back('Y', available), null);
  }
});

test('missing and unknown owners cannot seed a later authenticated reading scope', () => {
  for (const unknownOwner of [{ machine: null, readingScope: 'source-a' }, { machine: 'ged' },
    { machine: 'ged', readingScope: '' }, { machine: 'ged', readingScope: 'unknown' }]) {
    const history = new ConversationNavigationStack(unknownOwner);
    assert.equal(history.push('A', 'B'), false);
    assert.equal(history.depth, 0);
    history.setOwner(owner);
    assert.equal(history.back('B', available), null);
    history.push('B', 'C');
    assert.equal(history.back('C', available), 'B');
  }
});

test('owner objects are captured by value so later external mutations cannot preserve the old chain', () => {
  const supplied = { ...owner }, history = new ConversationNavigationStack(supplied);
  history.push('A', 'B');
  supplied.readingScope = 'source-b';
  assert.equal(history.setOwner(supplied), true);
  assert.equal(history.back('B', available), null);
  history.push('X', 'Y');
  supplied.machine = 'wandou';
  assert.equal(history.setOwner(supplied), true);
  assert.equal(history.back('Y', available), null);
});

test('invalid destination and returning while no detail is selected cannot add or expose a parent', () => {
  const history = stack();
  history.push('A', 'B');
  assert.equal(history.push('B', ''), false);
  assert.equal(history.depth, 1);
  assert.equal(history.back(null, available), null);
  assert.equal(history.depth, 0);
});

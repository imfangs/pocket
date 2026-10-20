import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlRequests, controlReceipt, controlUnresolved } from '../src/controlRequests.ts';

const memory = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const fixture = () => {
  const storage = memory();
  let machine = 'ged';
  const requests = createControlRequests(() => storage, () => machine);
  return { storage, requests, machine: value => { machine = value; } };
};
const start = (owner, kind, requestId = 'request-one') => owner.begin(requestId, kind === 'stop' ? 'original-turn' : undefined);
const finish = (owner, requestId, status, source = 'check') => owner.receive({ requestId, status }, source);

for (const kind of ['compact', 'stop']) {
  test(`${kind}: only operation identity survives a full reload, and accepted is still unresolved`, () => {
    const f = fixture(), owner = f.requests.for('thread-one', kind);
    assert.equal(start(owner, kind), true);
    const persisted = JSON.parse([...f.storage.values.values()][0]);
    assert.deepEqual(persisted, { threadId: 'thread-one', kind, requestId: 'request-one', ...(kind === 'stop' ? { targetTurnId: 'original-turn' } : {}) });
    finish(owner, 'request-one', 'accepted', 'post'); owner.finishPost('request-one');
    assert.equal(owner.getSnapshot().status, 'accepted');
    assert.equal(start(owner, kind, 'request-two'), false);
    const reopened = createControlRequests(() => f.storage, () => 'ged').for('thread-one', kind);
    assert.deepEqual(reopened.getSnapshot(), { identity: persisted, status: 'unknown', posting: false });
    assert.equal(start(reopened, kind, 'request-two'), false);
    assert.equal(f.storage.values.size, 1);
  });

  test(`${kind}: return to a new view retains the POST lock and cannot clear it with an early not_found`, () => {
    const f = fixture(), owner = f.requests.for('thread-one', kind);
    start(owner, kind);
    const reopened = f.requests.for('thread-one', kind), events = [];
    const unsubscribe = reopened.subscribe(() => events.push(reopened.getSnapshot()));
    assert.equal(reopened, owner);
    assert.equal(reopened.getSnapshot().posting, true);
    assert.equal(finish(reopened, 'request-one', 'not_found'), false);
    assert.equal(start(reopened, kind, 'request-two'), false);
    owner.finishPost('another-request');
    assert.equal(reopened.getSnapshot().posting, true);
    finish(owner, 'request-one', 'unknown', 'post'); owner.finishPost('request-one');
    assert.equal(reopened.getSnapshot().posting, false);
    assert.equal(reopened.getSnapshot().status, 'unknown');
    assert.ok(events.some(event => !event.posting));
    unsubscribe();
    assert.equal(finish(reopened, 'request-one', 'not_found'), true);
    assert.equal(f.storage.values.size, 0);
    assert.equal(start(reopened, kind, 'request-two'), true);
  });

  test(`${kind}: different, malformed, and unconfirmed receipts never clear the original identity`, () => {
    const f = fixture(), owner = f.requests.for('thread-one', kind);
    start(owner, kind); owner.finishPost('request-one');
    for (const receipt of [null, { requestId: 'other', status: 'rejected' }, { requestId: 'request-one', status: 'future-status' }, { requestId: 'request-one', status: 'not_found' }]) {
      assert.equal(owner.receive(receipt, 'history'), false);
    }
    for (const status of ['unknown', 'pending', 'accepted']) {
      owner.receive({ requestId: 'request-one', status }, 'check');
      assert.equal(controlUnresolved(owner.getSnapshot().status), true);
      assert.equal(f.storage.values.size, 1);
    }
    owner.observe({ requestId: 'another-history-request', status: 'accepted' });
    assert.equal(owner.getSnapshot().identity.requestId, 'request-one');
    const effective = controlReceipt(owner.getSnapshot(), { requestId: 'another-history-request', status: 'completed' });
    assert.equal(effective.requestId, 'request-one');
  });

  test(`${kind}: same-ID terminal results survive late replies, release storage once, and preserve a newer request`, () => {
    const f = fixture(), owner = f.requests.for('thread-one', kind);
    start(owner, kind);
    const terminal = kind === 'compact' ? 'completed' : 'stopped';
    assert.equal(finish(owner, 'request-one', terminal, 'history'), true);
    assert.equal(f.storage.values.size, 1, 'keep identity until the local POST settles');
    assert.equal(finish(owner, 'request-one', 'accepted', 'post'), false);
    owner.finishPost('request-one');
    assert.equal(f.storage.values.size, 0);
    assert.equal(controlReceipt(owner.getSnapshot(), { requestId: 'request-one', status: 'unknown' }).status, terminal);
    owner.observe({ requestId: 'request-one', status: 'unknown' });
    assert.equal(owner.getSnapshot().status, terminal);
    assert.equal(start(owner, kind, 'request-two'), true);
    finish(owner, 'request-one', terminal); owner.finishPost('request-one');
    assert.equal(owner.getSnapshot().identity.requestId, 'request-two');
    assert.equal(owner.getSnapshot().posting, true);
    assert.equal(JSON.parse([...f.storage.values.values()][0]).requestId, 'request-two');
  });
}

test('storage refusal or failed readback prevents starting a nonrecoverable POST', () => {
  for (const storage of [
    { getItem() { return null; }, setItem() { throw new Error('quota'); }, removeItem() {} },
    { getItem() { return null; }, setItem() {}, removeItem() {} },
    { getItem() { throw new Error('denied'); }, setItem() {}, removeItem() {} },
  ]) {
    const owner = createControlRequests(() => storage, () => 'ged').for('thread-one', 'compact');
    assert.equal(owner.begin('request-one'), false);
    assert.equal(owner.getSnapshot(), null);
  }
});

test('machine, thread and kind have separate owners, including delayed callbacks to the previous machine', () => {
  const f = fixture(), ged = f.requests.for('thread-one', 'stop');
  ged.begin('ged-request', 'ged-turn');
  f.machine('wandou'); const wandou = f.requests.for('thread-one', 'stop');
  assert.equal(wandou.getSnapshot(), null); wandou.begin('wandou-request', 'wandou-turn');
  const compact = f.requests.for('thread-one', 'compact'); compact.begin('compact-request');
  const other = f.requests.for('thread-two', 'stop'); other.begin('other-request', 'other-turn');
  assert.equal(f.storage.values.size, 4);
  ged.receive({ requestId: 'ged-request', status: 'stopped' }, 'post'); ged.finishPost('ged-request');
  assert.equal(wandou.getSnapshot().identity.requestId, 'wandou-request');
  assert.equal(f.storage.values.size, 3);
  assert.ok([...f.storage.values.keys()].every(key => key.startsWith('pocket.machine.wandou.')));
  f.machine('ged'); assert.equal(f.requests.for('thread-one', 'stop'), ged);
});

test('stopping a different turn cannot settle or replace the retained request', () => {
  const f = fixture(), owner = f.requests.for('thread-one', 'stop');
  assert.equal(owner.begin('request-one'), false);
  assert.equal(owner.begin('request-one', 'original-turn'), true);
  assert.equal(owner.receive({ requestId: 'request-one', targetTurnId: 'new-turn', status: 'stopped' }, 'post'), false);
  owner.finishPost('request-one');
  assert.equal(owner.getSnapshot().status, 'pending');
  assert.equal(owner.getSnapshot().identity.targetTurnId, 'original-turn');
});

test('observed pending requests are recoverable without authorizing a new POST', () => {
  const f = fixture(), owner = f.requests.for('thread-one', 'stop');
  owner.observe({ requestId: 'from-history', targetTurnId: 'history-turn', status: 'accepted' });
  assert.equal(owner.getSnapshot().posting, false);
  assert.equal(owner.getSnapshot().identity.requestId, 'from-history');
  assert.equal(owner.begin('new', 'new-turn'), false);
  const reload = createControlRequests(() => f.storage, () => 'ged').for('thread-one', 'stop');
  assert.equal(reload.getSnapshot().identity.requestId, 'from-history');
});

test('corrupt and mismatched stored identities never select another operation', () => {
  const storage = memory(), key = 'pocket.control-request.v1.compact.thread-one';
  for (const value of ['{', 'null', JSON.stringify({ threadId: 'other', kind: 'compact', requestId: 'request-one' }),
    JSON.stringify({ threadId: 'thread-one', kind: 'stop', requestId: 'request-one' }),
    JSON.stringify({ threadId: 'thread-one', kind: 'compact', requestId: '../other' })]) {
    storage.setItem(key, value);
    assert.equal(createControlRequests(() => storage, () => 'ged').for('thread-one', 'compact').getSnapshot(), null);
  }
});

test('terminal cleanup cannot remove a different stored request, and failed cleanup stays safe after reload', () => {
  const f = fixture(), owner = f.requests.for('thread-one', 'compact');
  owner.begin('request-one'); owner.finishPost('request-one');
  const key = [...f.storage.values.keys()][0];
  f.storage.setItem(key, JSON.stringify({ threadId: 'thread-one', kind: 'compact', requestId: 'newer' }));
  owner.receive({ requestId: 'request-one', status: 'completed' }, 'history');
  assert.equal(JSON.parse(f.storage.getItem(key)).requestId, 'newer');
  const next = createControlRequests(() => ({ ...f.storage, removeItem() { throw new Error('blocked'); } }), () => 'ged').for('thread-one', 'compact');
  next.receive({ requestId: 'newer', status: 'completed' }, 'check');
  assert.equal(next.getSnapshot().status, 'completed');
  const reload = createControlRequests(() => f.storage, () => 'ged').for('thread-one', 'compact');
  assert.equal(reload.getSnapshot().identity.requestId, 'newer');
  assert.equal(reload.begin('unsafe-repeat'), false);
});

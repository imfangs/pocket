import test from 'node:test';
import assert from 'node:assert/strict';
import { createSendingPreferenceStore, sendingPreferenceKey, shouldEnqueueNewMessage } from '../src/sendingPreference.ts';
import { machineStorageKey } from '../src/machineScope.ts';

function fixture() {
  const data = new Map(), browser = new EventTarget();
  browser.localStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const store = machine => createSendingPreferenceStore({ browser: () => browser, machine: () => machine });
  const storageChanged = (key, storageArea = browser.localStorage) => {
    const event = new Event('storage');
    Object.assign(event, { key, storageArea });
    browser.dispatchEvent(event);
  };
  return { data, browser, store, storageChanged };
}

test('automatic direct sending defaults on and remembers an explicit off only for the chosen machine', () => {
  const f = fixture(), ged = f.store('ged'), wandou = f.store('wandou');
  assert.equal(ged.read(), true);
  assert.equal(wandou.read(), true);
  ged.save(false);
  assert.equal(ged.read(), false);
  assert.equal(f.store('ged').read(), false, 'reopening reads the saved preference');
  assert.equal(wandou.read(), true);
  assert.deepEqual([...f.data], [[sendingPreferenceKey, 'false']]);
  wandou.save(false); ged.save(true);
  assert.equal(ged.read(), true);
  assert.equal(wandou.read(), false);
  assert.equal(f.data.get(machineStorageKey(sendingPreferenceKey, 'wandou')), 'false');
});

test('subscribers update on same-page changes and relevant cross-tab changes without rewriting preferences', () => {
  const f = fixture(), ged = f.store('ged'), wandou = f.store('wandou');
  let gedChanges = 0, wandouChanges = 0;
  const stopGed = ged.subscribe(() => gedChanges++), stopWandou = wandou.subscribe(() => wandouChanges++);
  assert.equal(gedChanges + wandouChanges, 0, 'opening settings only reads the choice');
  ged.save(false);
  assert.deepEqual([gedChanges, wandouChanges], [1, 0]);
  f.data.set(sendingPreferenceKey, 'true');
  f.storageChanged(sendingPreferenceKey);
  assert.equal(ged.read(), true);
  assert.deepEqual([gedChanges, wandouChanges], [2, 0]);
  f.storageChanged('unrelated');
  f.storageChanged(sendingPreferenceKey, {});
  assert.deepEqual([gedChanges, wandouChanges], [2, 0], 'unrelated keys and session storage are ignored');
  f.data.clear(); f.storageChanged(null);
  assert.deepEqual([gedChanges, wandouChanges], [3, 1]);
  stopGed(); stopWandou();
  ged.save(false); f.storageChanged(null);
  assert.deepEqual([gedChanges, wandouChanges], [3, 1], 'closed views remove listeners');
});

test('a blocked store retains the explicit choice for this page and notifies all live views', () => {
  const f = fixture();
  f.browser.localStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  const first = f.store('ged'), second = f.store('ged'), other = f.store('wandou');
  const stop = second.subscribe(() => {});
  assert.equal(first.read(), true);
  assert.doesNotThrow(() => first.save(false));
  assert.equal(first.read(), false);
  assert.equal(second.read(), false);
  assert.equal(other.read(), true);
  first.save(true);
  assert.equal(second.read(), true);
  stop();
});

test('corrupt values use the default and an invalid machine never writes another machine preference', () => {
  const f = fixture();
  for (const value of ['null', '{', '0', 'off', 'true']) {
    f.data.set(sendingPreferenceKey, value);
    assert.equal(f.store('ged').read(), true);
  }
  const before = [...f.data];
  f.store(null).save(false);
  assert.deepEqual([...f.data], before);
  const noBrowser = createSendingPreferenceStore({ browser: () => undefined, machine: () => 'ged' });
  assert.equal(noBrowser.read(), true);
  assert.doesNotThrow(() => noBrowser.save(false));
});

const desktop = { source: 'desktop', runtime: 'active', canSend: true, outbox: [] };
test('only new opted-in messages with an available desktop and no older queue bypass the active turn wait', () => {
  assert.equal(shouldEnqueueNewMessage(true, desktop), false);
  assert.equal(shouldEnqueueNewMessage(false, desktop), true);
  assert.equal(shouldEnqueueNewMessage(false, { ...desktop, runtime: 'idle' }), false);
  for (const history of [null, undefined, { ...desktop, source: 'rollout' }, { ...desktop, canSend: false },
    { ...desktop, outbox: [{ id: 'older', status: 'queued' }] },
    { ...desktop, outbox: [{ id: 'older', status: 'unknown' }] },
    { ...desktop, queuePaused: { stopId: 'stop' } }])
    assert.equal(shouldEnqueueNewMessage(true, history), true);
  assert.equal(shouldEnqueueNewMessage(true, desktop, true), true, 'read or compatibility failures retain the queue path');
});

test('changing the preference cannot upgrade existing queue entries or a captured submission intent', () => {
  const f = fixture(), store = f.store('ged');
  store.save(false);
  const request = Object.freeze({ requestId: 'already-submitted', autoDirect: store.read() });
  const oldQueue = Object.freeze([{ id: 'old', status: 'queued' }, { id: 'unknown', status: 'unknown' }].map(Object.freeze));
  store.save(true);
  assert.equal(request.autoDirect, false);
  assert.equal(store.read(), true);
  assert.ok(oldQueue.every(item => !Object.hasOwn(item, 'autoDirect')));
  assert.equal(shouldEnqueueNewMessage(store.read(), { ...desktop, outbox: oldQueue }), true);
});

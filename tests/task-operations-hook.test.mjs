import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createApiClient } from '../src/api.ts';
import { getReloadBlocker, registerReloadGuard } from '../src/updateSafety.ts';
import { machineSwitchBlocker } from '../src/machineScope.ts';
import * as operations from '../src/taskOperations.ts';
import { createTaskOperationPolling, pendingCreation } from '../src/taskOperationPolling.ts';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const pending = { requestId: id, operation: 'create', status: 'pending', createdAt: 100 };
const queued = { ...pending, status: 'succeeded', creationStatus: 'created', threadId: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
  initialMessage: { requestId: 'dddddddd-dddd-8ddd-8ddd-dddddddddddd', status: 'queued' } };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// Drive the real hook, polling module and API client through their public
// interfaces. Only the render/effect clock, browser surfaces and HTTP are fake.
function mount(request, saved = []) {
  let cursor = 0, dirty = false, now = 0, sequence = 0, output, closed = false;
  const slots = [], effects = [], timers = new Map(), calls = [], completions = [];
  const values = new Map([['pocket.pending-creation-ids.v1', JSON.stringify(saved)]]);
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const browser = new EventTarget(), visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const network = { onLine: true };
  const clock = {
    now: () => now,
    setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  };
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => {
      assert.equal(closed, false, 'no hook updates after unmount');
      const next = typeof value === 'function' ? value(slots[index]) : value;
      if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
    }];
  };
  const useRef = value => useState(() => ({ current: value }))[0];
  const changed = (previous, dependencies) => !previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]));
  const useEffect = (callback, dependencies) => {
    const index = cursor++, previous = slots[index];
    if (changed(previous, dependencies)) {
      slots[index] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = callback(); });
    }
  };
  const useCallback = (callback, dependencies) => {
    const index = cursor++, previous = slots[index];
    if (changed(previous, dependencies)) slots[index] = { dependencies, callback };
    return slots[index].callback;
  };
  const client = createApiClient(() => 'ged', async (path, options) => {
    const call = { path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal, at: now };
    calls.push(call);
    const data = await request(call);
    return new Response(JSON.stringify(data));
  }, () => {});
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL('../src/useTaskOperations.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { module, exports: module.exports, window: browser, document: visibility, navigator: network,
    AbortController, AbortSignal, crypto: { randomUUID: () => id }, setTimeout: clock.setTimer, clearTimeout: clock.clearTimer,
    require(name) {
      if (name === 'react') return { useState, useRef, useCallback, useEffect, useLayoutEffect: useEffect };
      if (name === './api') return client;
      if (name === './taskOperations') return { ...operations,
        readCreationRecoveryIds: () => operations.readCreationRecoveryIds(storage),
        saveCreationRecoveryIds: ids => operations.saveCreationRecoveryIds(ids, storage) };
      if (name === './taskOperationPolling') return { pendingCreation,
        createTaskOperationPolling: options => createTaskOperationPolling({ ...options, ...clock }) };
      if (name === './updateSafety') return { useReloadGuard(getter) {
        const latest = useRef(getter); latest.current = getter;
        useEffect(() => registerReloadGuard(() => latest.current()), []);
      } };
      throw Error(`Unexpected module ${name}`);
    },
  });
  const render = () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      dirty = false; cursor = 0; output = module.exports.default(operation => completions.push(operation));
      while (effects.length) effects.shift()();
      if (!dirty) return output;
    }
    throw Error('hook did not settle');
  };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); render(); };
  render();
  return { calls, completions, browser, visibility, network, storage, render, flush, get output() { return output; },
    async advance(duration) {
      const target = now + duration; await flush();
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = target; await flush();
    },
    close() { for (const slot of slots) slot?.cleanup?.(); closed = true; },
  };
}

test('a locally submitted creation is exposed and recoverable before POST returns, without exposing old successes', async () => {
  const post = deferred();
  const ui = mount(call => call.method === 'POST' ? post.promise :
    call.path === '/api/task-operations' ? { operations: [{ ...queued, requestId: otherId }] } : queued);
  try {
    await ui.flush();
    assert.equal(ui.output.creations.length, 0);
    const submitted = ui.output.start('create', { locationId: 'location', initialQuery: 'private synthetic query' }, undefined, id);
    ui.render();
    assert.equal(ui.output.creations[0].requestId, id);
    assert.deepEqual(operations.readCreationRecoveryIds(ui.storage), [id]);
    assert.ok(getReloadBlocker()); assert.ok(machineSwitchBlocker(getReloadBlocker()));
    assert.equal(ui.storage.getItem('pocket.pending-creation-ids.v1').includes('private'), false);
    await ui.advance(2000);
    assert.equal(ui.calls.filter(call => call.path === `/api/task-operations/${id}`).length, 0);
    post.resolve(pending); await submitted; await ui.advance(0);
    assert.equal(ui.output.creations[0].status, 'succeeded'); assert.equal(ui.completions.length, 1);
  } finally { post.resolve(pending); await ui.flush(); ui.close(); }
});

test('restored creation delivery survives leaving the form, pauses offline and confirms once on return', async () => {
  let accepted = false;
  const ui = mount(call => call.path === '/api/task-operations' ? { operations: [queued] } :
    { ...queued, initialMessage: { ...queued.initialMessage, status: accepted ? 'accepted' : 'queued' } }, [id]);
  try {
    await ui.advance(0);
    assert.equal(ui.output.creations[0].initialMessage.status, 'queued');
    assert.equal(ui.completions.length, 1);
    ui.network.onLine = false; ui.browser.dispatchEvent(new Event('offline'));
    const paused = ui.calls.length; accepted = true;
    await ui.advance(15000); assert.equal(ui.calls.length, paused);
    ui.network.onLine = true; ui.browser.dispatchEvent(new Event('online')); await ui.advance(0);
    assert.equal(ui.output.creations[0].initialMessage.status, 'accepted'); assert.equal(ui.completions.length, 1);
    // A stale list on pageshow cannot revive a queued marker or its polling.
    ui.browser.dispatchEvent(new Event('pageshow')); await ui.advance(0);
    const receiptCount = ui.calls.filter(call => call.path === `/api/task-operations/${id}`).length;
    await ui.advance(30000);
    assert.equal(ui.calls.filter(call => call.path === `/api/task-operations/${id}`).length, receiptCount);
    assert.equal(ui.output.creations[0].initialMessage.status, 'accepted');
    assert.equal(ui.calls.some(call => call.method !== 'GET'), false);
  } finally { ui.close(); }
});

test('dismissal clears creation recovery and does not revive tracking from another foreground list', async () => {
  const ui = mount(call => call.path === '/api/task-operations' ? { operations: [queued] } : queued, [id]);
  try {
    await ui.advance(0);
    assert.equal(ui.output.creations.length, 1);
    ui.output.dismiss(id); ui.render();
    assert.equal(ui.output.creations.length, 0); assert.deepEqual(operations.readCreationRecoveryIds(ui.storage), []);
    const reads = ui.calls.filter(call => call.path === `/api/task-operations/${id}`).length;
    ui.browser.dispatchEvent(new Event('pageshow')); await ui.advance(60000);
    assert.equal(ui.output.creations.length, 0);
    assert.equal(ui.calls.filter(call => call.path === `/api/task-operations/${id}`).length, reads);
    assert.equal(ui.completions.length, 1);
  } finally { ui.close(); }
});

test('a listed unknown creation keeps recovery protection and never adds automatic recovery GETs', async () => {
  const unknown = { ...queued, status: 'unknown', initialMessage: { ...queued.initialMessage, status: 'not_queued' } };
  const ui = mount(call => call.path === '/api/task-operations' ? { operations: [unknown] } : unknown, [id]);
  try {
    await ui.advance(60000);
    ui.browser.dispatchEvent(new Event('pageshow')); await ui.advance(10000);
    assert.equal(ui.calls.filter(call => call.path !== '/api/task-operations').length, 0);
    assert.equal(ui.completions.length, 0); assert.equal(ui.output.creations[0].status, 'unknown');
    assert.ok(getReloadBlocker()); assert.deepEqual(operations.readCreationRecoveryIds(ui.storage), [id]);
  } finally { ui.close(); }
});

test('failed creation-list reads retry with capped backoff until a restored creation is confirmed', async () => {
  let failures = 7;
  const accepted = { ...queued, initialMessage: { ...queued.initialMessage, status: 'accepted' } };
  const ui = mount(call => {
    assert.equal(call.path, '/api/task-operations');
    if (failures-- > 0) throw new TypeError('temporary network failure');
    return { operations: [accepted] };
  }, [id]);
  try {
    await ui.advance(59999);
    assert.equal(ui.output.creations[0].status, 'unknown');
    assert.ok(getReloadBlocker());
    await ui.advance(1);
    assert.deepEqual(ui.calls.map(call => call.at), [0, 1000, 3000, 7000, 15000, 30000, 45000, 60000]);
    assert.equal(ui.output.creations[0].initialMessage.status, 'accepted');
    assert.equal(ui.completions.length, 1);
    assert.equal(getReloadBlocker(), null);
    const reads = ui.calls.length;
    await ui.advance(60000);
    assert.equal(ui.calls.length, reads, 'a successful list clears the retry intent');
    assert.equal(ui.calls.some(call => call.method !== 'GET'), false);
  } finally { ui.close(); }
});

test('failed creation-list recovery pauses when hidden or offline and resets backoff after success', async () => {
  for (const mode of ['hidden', 'offline']) {
    let fail = true;
    const accepted = { ...queued, initialMessage: { ...queued.initialMessage, status: 'accepted' } };
    const ui = mount(call => {
      assert.equal(call.path, '/api/task-operations');
      if (fail) throw new TypeError('temporary network failure');
      return { operations: [accepted] };
    }, [id]);
    try {
      await ui.advance(3000);
      assert.equal(ui.calls.length, 3);
      if (mode === 'hidden') { ui.visibility.visibilityState = 'hidden'; ui.visibility.dispatchEvent(new Event('visibilitychange')); }
      else { ui.network.onLine = false; ui.browser.dispatchEvent(new Event('offline')); }
      await ui.advance(45000);
      assert.equal(ui.calls.length, 3, mode);
      fail = false;
      if (mode === 'hidden') { ui.visibility.visibilityState = 'visible'; ui.visibility.dispatchEvent(new Event('visibilitychange')); }
      else { ui.network.onLine = true; ui.browser.dispatchEvent(new Event('online')); }
      await ui.advance(0);
      assert.equal(ui.output.creations[0].initialMessage.status, 'accepted');
      assert.equal(ui.calls.at(-1).at, 48000);
      fail = true; ui.browser.dispatchEvent(new Event('pageshow')); await ui.advance(0);
      fail = false;
      const reads = ui.calls.length;
      await ui.advance(999); assert.equal(ui.calls.length, reads);
      await ui.advance(1); assert.equal(ui.calls.length, reads + 1, 'success resets the next failure to a one-second retry');
      assert.equal(ui.completions.length, 1);
      assert.equal(ui.calls.some(call => call.method !== 'GET'), false);
    } finally { ui.close(); }
  }
});

test('a missing restored unknown creation requires explicit single-operation recovery', async () => {
  const unknown = { requestId: id, operation: 'create', status: 'unknown' };
  const ui = mount(call => call.path === '/api/task-operations' ? { operations: [] } : unknown, [id]);
  try {
    await ui.advance(60000);
    assert.equal(ui.calls.filter(call => call.path !== '/api/task-operations').length, 0);
    assert.equal(ui.output.creations[0].status, 'unknown');
    assert.ok(getReloadBlocker());
    assert.deepEqual(operations.readCreationRecoveryIds(ui.storage), [id]);
    await ui.output.check(id); await ui.flush();
    assert.equal(ui.calls.filter(call => call.path === `/api/task-operations/${id}`).length, 1);
    assert.equal(ui.calls.some(call => call.method !== 'GET'), false);
  } finally { ui.close(); }
});

test('a succeeded creation awaiting its first message does not prevent the next explicit create', async () => {
  const ui = mount(call => call.method === 'POST' ? { ...pending, requestId: call.body.requestId } :
    call.path === '/api/task-operations' ? { operations: [queued] } : queued, [id]);
  try {
    await ui.advance(0);
    const result = await ui.output.start('create', { locationId: 'another-location' }, undefined, otherId);
    ui.render();
    assert.equal(result.requestId, otherId);
    assert.deepEqual(ui.calls.filter(call => call.method === 'POST').map(call => call.body.requestId), [otherId]);
    assert.equal(ui.output.creations.length, 2);
    assert.deepEqual(operations.readCreationRecoveryIds(ui.storage), [id, otherId]);
  } finally { ui.close(); }
});

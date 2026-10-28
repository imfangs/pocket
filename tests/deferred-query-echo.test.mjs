import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createDeferredQueryEcho, QUERY_ECHO_WAIT_MS } from '../src/useDeferredQueryEcho.ts';
import { sameAttachments } from '../src/attachments.ts';
import { queryTimeline } from '../src/queryTimeline.ts';

const query = Object.freeze({ threadId: 'thread', requestId: 'request', text: 'A new query', status: 'unknown', createdAt: 100 });
const saved = Object.freeze({ id: 'rollout:100', role: 'user', text: query.text, turnId: 'turn' });
const native = Object.freeze({ ...saved, id: 'native', clientMessageId: query.requestId });
const ids = value => [...value];
function setup(messages = [], entries = [query]) {
  let now = 0;
  const controller = createDeferredQueryEcho(() => now);
  controller.observe(messages, entries, false);
  return { controller, advance(ms) { now += ms; } };
}

test('a new complete unlinked record waits once without changing the query or receipt', () => {
  const f = setup();
  assert.deepEqual(ids(f.controller.view([saved], [query], false)), [saved.id]);
  const first = f.controller.observe([saved], [query], false);
  assert.deepEqual(first.fresh, [saved.id]);
  assert.equal(first.remainingMs, QUERY_ECHO_WAIT_MS);
  assert.deepEqual(f.controller.observe([saved], [query], false).fresh, []);
  assert.equal(query.status, 'unknown');
  assert.equal(saved.clientMessageId, undefined);
  assert.deepEqual(ids(f.controller.view([native], [query], false)), []);
  f.controller.observe([native], [query], false);
  assert.deepEqual(ids(f.controller.view([saved], [query], false)), [], 'a removed candidate cannot restart a new hiding window');
});

test('initially visible and previously shown same-text records never disappear later', () => {
  const initial = setup([saved]);
  assert.deepEqual(ids(initial.controller.view([saved], [query], false)), []);
  const laterQuery = setup([], []);
  laterQuery.controller.observe([saved], [], false);
  assert.deepEqual(ids(laterQuery.controller.view([saved], [query], false)), []);
});

test('delayed initial reads establish a baseline before a matching local query can reserve a row', () => {
  const controller = createDeferredQueryEcho(() => 0);
  const pending = { ...query, text: 'continue', createdAt: 2000 };
  const oldUser = { id: 'old-user', role: 'user', text: 'continue', timestamp: 1000 };
  const oldReply = { id: 'old-reply', role: 'assistant', text: 'An earlier answer', timestamp: 1100 };
  controller.observe([], [pending], false, false);
  // One source can finish empty while the other still holds the old history.
  controller.observe([], [pending], false, false);
  const messages = [oldUser, oldReply];
  const deferred = controller.view(messages, [pending], false, true);
  assert.deepEqual(ids(deferred), []);
  const timeline = queryTimeline(messages, [pending], [pending], [], deferred);
  assert.equal(timeline.byMessage.has(oldUser.id), false);
  assert.deepEqual(timeline.tail.map(row => row.requestId), [pending.requestId]);
  controller.observe(messages, [pending], false, true);
  assert.deepEqual(ids(controller.view(messages, [pending], false, true)), []);
  assert.equal(pending.status, 'unknown');
});

test('both source orders and skewed clocks preserve initial history while later echoes still wait', () => {
  for (const earlierTimestamp of [1, 9999999999999]) {
    const controller = createDeferredQueryEcho(() => 0);
    const first = { ...saved, id: 'first-source', timestamp: earlierTimestamp };
    const second = { ...saved, id: 'second-source', timestamp: earlierTimestamp };
    controller.observe([], [query], false, false);
    assert.deepEqual(ids(controller.view([first], [query], false, false)), []);
    controller.observe([first], [query], false, false);
    assert.deepEqual(ids(controller.view([first, second], [query], false, true)), []);
    controller.observe([first, second], [query], false, true);
    const newEcho = { ...saved, id: 'new-echo', timestamp: earlierTimestamp };
    assert.deepEqual(ids(controller.view([first, second, newEcho], [query], false, true)), [newEcho.id]);
  }
});

test('a successfully read empty conversation can defer its first new echo', () => {
  const controller = createDeferredQueryEcho(() => 0);
  controller.observe([], [], false, false);
  controller.observe([], [], false, true);
  assert.deepEqual(ids(controller.view([saved], [query], false, true)), [saved.id]);
});

test('a late delegated opening Query cannot be reserved by a same-text pending request', () => {
  const reply = { id: 'existing-answer', role: 'assistant', text: 'Existing answer', turnId: 'old-turn' };
  const delegated = { id: 'fco_start', role: 'user', text: query.text, turnId: 'old-turn', origin: 'codex_delegation' };
  const f = setup([reply], []);
  const messages = [delegated, reply];
  const deferred = f.controller.view(messages, [query], false, true);
  assert.deepEqual(ids(deferred), []);
  const observation = f.controller.observe(messages, [query], false, true);
  assert.deepEqual(observation.fresh, []); assert.equal(observation.remainingMs, null);
  const timeline = queryTimeline(messages, [query], [query], [], deferred);
  assert.equal(timeline.byMessage.has(delegated.id), false);
  assert.equal(timeline.hiddenMessages.has(delegated.id), false);
  assert.deepEqual(timeline.tail.map(row => row.requestId), [query.requestId]);
  assert.equal(query.status, 'unknown');
});

test('explicit identity, truncation, other content and attachment mismatches are never deferred', () => {
  const attachment = { id: 'file', sha256: 'abc', name: 'file.txt', kind: 'file' };
  for (const [message, entry] of [
    [{ ...saved, clientMessageId: 'other-request' }, query],
    [native, query],
    [{ ...saved, truncated: true }, query],
    [{ ...saved, text: 'Other message' }, query],
    [saved, { ...query, attachments: [attachment] }],
    [{ ...saved, attachments: [{ ...attachment, sha256: 'different' }] }, { ...query, attachments: [attachment] }],
  ]) {
    const f = setup();
    assert.deepEqual(ids(f.controller.view([message], [entry], false)), []);
  }
  const f = setup();
  assert.deepEqual(ids(f.controller.view([{ ...saved, attachments: [attachment] }], [{ ...query, attachments: [attachment] }], false)), [saved.id]);
});

test('repeated snapshots cannot extend the original deadline and timeout restores separate messages', () => {
  const f = setup();
  f.controller.observe([saved], [query], false);
  f.advance(12000);
  assert.equal(f.controller.observe([{ ...saved }], [{ ...query }], false).remainingMs, 6000);
  f.advance(5999);
  assert.deepEqual(ids(f.controller.view([saved], [query], false)), [saved.id]);
  f.advance(1);
  assert.deepEqual(ids(f.controller.view([saved], [query], false)), []);
  const expired = f.controller.observe([saved], [query], false);
  assert.equal(expired.remainingMs, null);
  assert.deepEqual(expired.fresh, []);
  f.advance(100000);
  assert.deepEqual(ids(f.controller.view([saved], [query], false)), []);
});

test('read failure and disabling release immediately and do not re-hide on recovery', () => {
  const failed = setup();
  const first = failed.controller.observe([saved], [query], false);
  assert.equal(failed.controller.release(first.fresh), true);
  assert.deepEqual(ids(failed.controller.view([saved], [query], false)), []);
  assert.equal(failed.controller.release(first.fresh), false);
  const disabled = setup();
  disabled.controller.observe([saved], [query], false);
  assert.deepEqual(ids(disabled.controller.view([saved], [query], true)), []);
  disabled.controller.observe([saved], [query], true);
  assert.deepEqual(ids(disabled.controller.view([saved], [query], false)), []);
});

test('a match lost after editing or a definite non-delivery becomes visible permanently', () => {
  for (const patch of [{ echoed: true }, { dismissed: true }, { status: 'cancelled' }, { status: 'editing' },
    { status: 'rejected' }, { status: 'not_found' }, { status: 'not_queued' }, { text: 'Edited query' }]) {
    const f = setup();
    f.controller.observe([saved], [query], false);
    assert.deepEqual(ids(f.controller.view([saved], [{ ...query, ...patch }], false)), []);
    f.controller.observe([saved], [{ ...query, ...patch }], false);
    assert.deepEqual(ids(f.controller.view([saved], [query], false)), []);
  }
});

test('independent same-text records have individual deadlines and a failed earlier read cannot release newer candidates', () => {
  const f = setup(), second = { ...saved, id: 'rollout:200' };
  const first = f.controller.observe([saved], [query], false);
  f.advance(5000);
  const next = f.controller.observe([saved, second], [query], false);
  assert.deepEqual(next.fresh, [second.id]);
  f.controller.release(first.fresh);
  assert.deepEqual(ids(f.controller.view([saved, second], [query], false)), [second.id]);
  f.advance(QUERY_ECHO_WAIT_MS);
  assert.deepEqual(ids(f.controller.view([saved, second], [query], false)), []);
});

// Exercise the real hook's scheduling and refresh integration with a controlled
// render/effect clock; real DOM/reading geometry remains in browser verification.
function mount(refresh, baselineReady = true) {
  let now = 0, cursor = 0, dirty = false, sequence = 0, closed = false, lateUpdates = 0, output;
  let props = { messages: [], entries: [query], options: { disabled: false, baselineReady, refresh } };
  const slots = [], effects = [], timers = new Map(), browser = new EventTarget(), document = new EventTarget();
  Object.assign(browser, { setTimeout(fn, delay) { timers.set(++sequence, { fn, at: now + delay }); return sequence; },
    clearTimeout(id) { timers.delete(id); } });
  const useState = initial => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], value => {
      if (closed) lateUpdates++;
      const next = typeof value === 'function' ? value(slots[i]) : value;
      if (!Object.is(next, slots[i])) { slots[i] = next; dirty = true; }
    }];
  };
  const useRef = value => useState(() => ({ current: value }))[0];
  const useLayoutEffect = (callback, dependencies) => {
    const i = cursor++, previous = slots[i];
    if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
      slots[i] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = callback(); });
    }
  };
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL('../src/useDeferredQueryEcho.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, { module, exports: module.exports, window: browser, document, performance: { now: () => now },
    require(name) { return name === 'react' ? { useState, useRef, useLayoutEffect } : { sameAttachments }; } });
  const render = patch => {
    if (patch) props = { ...props, ...patch };
    for (let count = 0; count < 12; count++) {
      dirty = false; cursor = 0;
      output = module.exports.useDeferredQueryEcho(props.messages, props.entries, props.options);
      while (effects.length) effects.shift()();
      if (!dirty) return output;
    }
    throw Error('hook did not settle');
  };
  render();
  return { render, timers, browser, get output() { return output; }, get lateUpdates() { return lateUpdates; },
    async flush() { await setImmediate(); return render(); },
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      return this.flush();
    },
    close() { closed = true; for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('the hook wakes one shared read and releases at its fixed deadline across snapshot rerenders', async () => {
  let calls = 0;
  const ui = mount(async () => { calls++; });
  try {
    assert.deepEqual(ids(ui.render({ messages: [saved] })), [saved.id]);
    await ui.flush(); assert.equal(calls, 1);
    await ui.advance(9000);
    ui.render({ messages: [{ ...saved }], entries: [{ ...query }] });
    await ui.flush(); assert.equal(calls, 1);
    await ui.advance(8999); assert.deepEqual(ids(ui.output), [saved.id]);
    await ui.advance(1); assert.deepEqual(ids(ui.output), []); assert.equal(ui.timers.size, 0);
    ui.browser.dispatchEvent(new Event('pageshow')); await ui.flush(); assert.equal(calls, 1);
  } finally { ui.close(); }
});

test('the hook does not hide either initial source and defers new records after their combined baseline', async () => {
  for (const firstSourceEmpty of [true, false]) {
    let calls = 0;
    const refresh = async () => { calls++; };
    const ui = mount(refresh, false);
    const first = { ...saved, id: 'first-source' }, second = { ...saved, id: 'second-source' };
    const firstMessages = firstSourceEmpty ? [] : [first];
    try {
      assert.deepEqual(ids(ui.render({ messages: firstMessages })), []);
      await ui.flush(); assert.equal(calls, 0);
      const baseline = [...firstMessages, second];
      assert.deepEqual(ids(ui.render({ messages: baseline, options: { disabled: false, baselineReady: true, refresh } })), []);
      await ui.flush(); assert.equal(calls, 0); assert.equal(ui.timers.size, 0);
      const echo = { ...saved, id: 'new-echo' };
      assert.deepEqual(ids(ui.render({ messages: [...baseline, echo] })), [echo.id]);
      await ui.flush(); assert.equal(calls, 1);
      await ui.advance(QUERY_ECHO_WAIT_MS);
      assert.deepEqual(ids(ui.output), []); assert.equal(ui.timers.size, 0);
    } finally { ui.close(); }
  }
});

test('the hook falls back after a failed read and clears timers without cancelling shared work on unmount', async () => {
  const failed = mount(async () => { throw Error('read failed'); });
  try {
    failed.render({ messages: [saved] }); await failed.flush();
    assert.deepEqual(ids(failed.output), []); assert.equal(failed.timers.size, 0);
  } finally { failed.close(); }
  let reject;
  const late = mount(() => new Promise((_, failure) => { reject = failure; }));
  late.render({ messages: [saved] }); await late.flush();
  assert.equal(late.timers.size, 1); late.close(); assert.equal(late.timers.size, 0);
  reject(Error('late failure')); await setImmediate(); assert.equal(late.lateUpdates, 0);
});

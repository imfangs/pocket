import test from 'node:test';
import assert from 'node:assert/strict';
import { receiptHandoffs, reconcileHandoffRows, animateReceiptHandoff } from '../src/receiptMotion.ts';

const entry = { threadId: 'thread', requestId: 'query', text: 'Keep this complete query', status: 'accepted', createdAt: 1 };
const message = { id: 'native', role: 'user', clientMessageId: 'query', text: entry.text };

test('only exact complete accepted echoes authorize a receipt exit and target entrance', () => {
  const match = receiptHandoffs([entry], [message], []);
  assert.deepEqual([...match.submissions], ['query']);
  assert.deepEqual([...match.outbox], ['query']);
  assert.equal(match.messageIds.get('query'), 'native');
  for (const status of ['unknown', 'pending', 'rejected', 'editing']) {
    const result = receiptHandoffs([{ ...entry, status }], [message], []);
    assert.equal(result.submissions.size, 0, status);
    assert.equal(result.outbox.size, 0, status);
    assert.equal(result.messageIds.size, 0, status);
  }
  for (const changed of [{ ...message, truncated: true }, { ...message, text: 'Keep' }, { ...message, clientMessageId: 'other' }, { ...message, role: 'assistant' }]) {
    const result = receiptHandoffs([entry], [changed], []);
    assert.equal(result.submissions.size, 0);
    assert.equal(result.messageIds.size, 0);
  }
});

test('queue takeover matches identity, full text and attachments without claiming delivery', () => {
  const pending = { ...entry, status: 'pending' };
  const queue = { id: entry.requestId, text: entry.text, status: 'pending', revision: 0, createdAt: 1 };
  const result = receiptHandoffs([pending], [], [queue]);
  assert.deepEqual([...result.submissions], ['query']);
  assert.equal(result.outbox.size, 0);
  assert.equal(result.messageIds.size, 0);
  assert.equal(receiptHandoffs([pending], [], [{ ...queue, text: 'different edit' }]).submissions.size, 0);
  assert.equal(receiptHandoffs([{ ...pending, attachments: [{ id: 'file' }] }], [], [queue]).submissions.size, 0);
});

test('explicit dismiss and confirmed cancellation authorize exits without manufacturing an echo', () => {
  for (const changed of [{ ...entry, status: 'cancelled' }, { ...entry, status: 'rejected', dismissed: true }]) {
    const result = receiptHandoffs([changed], [], []);
    assert.deepEqual([...result.explicit], ['query']);
    assert.deepEqual([...result.outbox], ['query']);
    assert.equal(result.messageIds.size, 0);
  }
});

test('presentation retains authorized exiting rows in place and cancels their exit on re-entry', () => {
  const previous = ['a', 'b', 'c'].map(id => ({ id, item: { id }, leaving: false }));
  const next = reconcileHandoffRows(previous, [{ id: 'a' }, { id: 'c' }], item => item.id, new Set(['b']));
  assert.deepEqual(next.map(({ id, leaving }) => [id, leaving]), [['a', false], ['b', true], ['c', false]]);
  const returned = reconcileHandoffRows(next, [{ id: 'a' }, { id: 'b', newer: true }, { id: 'c' }], item => item.id, new Set(['b']));
  assert.equal(returned[1].leaving, false);
  assert.equal(returned[1].item.newer, true);
  assert.deepEqual(reconcileHandoffRows(previous, [], item => item.id, new Set()), []);
});

function surface({ reduced = false, selected = false, focused = false } = {}) {
  const doc = new EventTarget(), browser = new EventTarget(), media = new EventTarget();
  const markers = new Set(), frames = new Map(), animations = [];
  let frameId = 0;
  Object.assign(media, { matches: reduced });
  Object.assign(browser, { innerHeight: 800, matchMedia: () => media, requestAnimationFrame: fn => { const id = ++frameId; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    getComputedStyle: () => ({ paddingTop: '12px', paddingBottom: '12px', marginTop: '6px', marginBottom: '6px', borderTopWidth: '1px', borderBottomWidth: '1px' }) });
  Object.assign(doc, { visibilityState: 'visible', defaultView: browser, activeElement: focused ? {} : null,
    getSelection: () => ({ isCollapsed: !selected, rangeCount: 1, getRangeAt: () => ({ intersectsNode: () => selected }) }),
    createElement: () => ({ setAttribute() {}, remove() { markers.delete(this); } }), body: { append: node => markers.add(node) },
    createEvent: () => { const event = new Event('pocket-reading-visibility-change'); event.initEvent = () => {}; return event; } });
  const node = new EventTarget();
  Object.assign(node, { ownerDocument: doc, isConnected: true, dataset: {}, closest: () => null,
    contains: target => target === doc.activeElement, getBoundingClientRect: () => ({ height: 100 }),
    removeAttribute: () => { delete node.dataset.handoffPhase; },
    animate(keyframes, options) {
      let resolve, reject;
      const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
      const animation = { finished, resolve, cancel: () => reject(new Error('cancelled')), keyframes, options };
      animations.push(animation); return animation;
    },
  });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  return { node, doc, media, markers, animations, frames, flush, clearSelection: () => { selected = false; doc.dispatchEvent(new Event('selectionchange')); } };
}

test('reduced motion completes immediately without adding reading holds or animation work', () => {
  const fixture = surface({ reduced: true }); let done = 0;
  const cancel = animateReceiptHandoff(fixture.node, 'exit', () => done++);
  assert.equal(done, 1); assert.equal(fixture.animations.length, 0); assert.equal(fixture.markers.size, 0);
  cancel(); assert.equal(done, 1);
});

test('automatic removal waits for selected text and releases every hold on cancellation', () => {
  const fixture = surface({ selected: true }); let done = 0;
  const cancel = animateReceiptHandoff(fixture.node, 'exit', () => done++);
  assert.equal(fixture.animations.length, 0); assert.equal(fixture.markers.size, 1);
  fixture.clearSelection(); assert.equal(fixture.animations.length, 1);
  assert.equal(fixture.animations[0].options.duration, 120);
  cancel(); assert.equal(done, 0); assert.equal(fixture.markers.size, 0); assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.node.dataset.handoffPhase, undefined);
});

test('reducing motion preserves selected text until selection is released', () => {
  const fixture = surface({ reduced: true, selected: true }); let done = 0;
  const cancel = animateReceiptHandoff(fixture.node, 'exit', () => done++);
  assert.equal(done, 0); assert.equal(fixture.animations.length, 0);
  fixture.clearSelection(); assert.equal(done, 1); assert.equal(fixture.animations.length, 0);
  fixture.flush(); assert.equal(fixture.markers.size, 0);
  cancel();
});

test('automatic exits retain focused controls while explicit dismissal can finish', async () => {
  const fixture = surface({ focused: true }); let done = 0;
  const cancel = animateReceiptHandoff(fixture.node, 'exit', () => done++);
  assert.equal(fixture.animations.length, 0);
  cancel(); assert.equal(done, 0); assert.equal(fixture.markers.size, 0);
  const dismiss = animateReceiptHandoff(fixture.node, 'exit', () => done++, true);
  assert.equal(fixture.animations.length, 1);
  fixture.animations[0].resolve(); await Promise.resolve(); fixture.flush();
  assert.equal(done, 1); assert.equal(fixture.markers.size, 0);
  dismiss();
});

test('only the completed exit retires a card and it holds reading through the final layout', async () => {
  const fixture = surface(); let done = 0;
  const cancel = animateReceiptHandoff(fixture.node, 'exit', () => done++);
  assert.equal(done, 0); assert.equal(fixture.markers.size, 1);
  fixture.animations[0].resolve(); await Promise.resolve();
  assert.equal(done, 1); assert.equal(fixture.markers.size, 1);
  fixture.flush(); assert.equal(fixture.markers.size, 0);
  cancel(); assert.equal(done, 1);
});

test('a preference change settles motion and removes its media listener and read hold', () => {
  const fixture = surface(); let done = 0;
  const cancel = animateReceiptHandoff(fixture.node, 'enter', () => done++);
  assert.equal(fixture.animations[0].options.duration, 180);
  fixture.media.matches = true; fixture.media.dispatchEvent(new Event('change'));
  fixture.flush(); assert.equal(done, 1); assert.equal(fixture.markers.size, 0);
  fixture.media.dispatchEvent(new Event('change')); assert.equal(done, 1);
  cancel();
});

test('cleaning an earlier entrance does not erase a newer exit on the same queue row', async () => {
  const fixture = surface();
  const enter = animateReceiptHandoff(fixture.node, 'enter');
  fixture.animations[0].resolve(); await Promise.resolve(); fixture.flush();
  const exit = animateReceiptHandoff(fixture.node, 'exit');
  assert.equal(fixture.node.dataset.handoffPhase, 'exit');
  enter(); assert.equal(fixture.node.dataset.handoffPhase, 'exit');
  assert.equal(fixture.markers.size, 1);
  exit(); assert.equal(fixture.markers.size, 0);
});

test('background and return preserve selected receipt text until the user releases it', async () => {
  const fixture = surface({ selected: true }); let done = 0;
  const cancel = animateReceiptHandoff(fixture.node, 'exit', () => done++);
  fixture.doc.visibilityState = 'hidden'; fixture.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(done, 0); assert.equal(fixture.animations.length, 0);
  fixture.doc.visibilityState = 'visible'; fixture.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(done, 0); assert.equal(fixture.markers.size, 1);
  fixture.clearSelection(); fixture.animations[0].resolve(); await Promise.resolve(); fixture.flush();
  assert.equal(done, 1); assert.equal(fixture.markers.size, 0); cancel();
});

test('background blur cannot retire a protected receipt before the visible view resumes', async () => {
  const fixture = surface({ focused: true }); let done = 0;
  const cancel = animateReceiptHandoff(fixture.node, 'exit', () => done++);
  fixture.doc.visibilityState = 'hidden'; fixture.doc.dispatchEvent(new Event('visibilitychange'));
  fixture.doc.activeElement = null; fixture.node.dispatchEvent(new Event('focusout')); await Promise.resolve();
  assert.equal(done, 0); assert.equal(fixture.animations.length, 0);
  fixture.doc.visibilityState = 'visible'; fixture.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(fixture.animations.length, 1);
  fixture.animations[0].resolve(); await Promise.resolve(); fixture.flush();
  assert.equal(done, 1); assert.equal(fixture.markers.size, 0); cancel();
});

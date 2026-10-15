import test from 'node:test';
import assert from 'node:assert/strict';
import { bindComposerConnectionIntent, createComposerConnectionIntent } from '../src/composerConnection.ts';

class Target {
  listeners = new Map();
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== fn)); }
  emit(type, data = {}) { for (const fn of this.listeners.get(type) ?? []) fn({ type, target: this, isTrusted: true, ...data }); }
}
function fixture(connect = async () => {}) {
  let available = true, calls = 0;
  const document = new Target(), input = new Target(), browser = new Target();
  document.defaultView = browser;
  const form = { ownerDocument: document, querySelector: () => input };
  const intent = createComposerConnectionIntent({ available: () => available, connect: async () => { calls++; await connect(); } });
  const unbind = bindComposerConnectionIntent(form, () => { void intent.request(); });
  return { document, input, browser, intent, calls: () => calls, available: value => { available = value; },
    close() { unbind(); intent.dispose(); } };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('reading, restored drafts and even trusted programmatic focus never open a conversation', async () => {
  const f = fixture();
  f.document.emit('focusin', { target: f.input });
  f.input.emit('input', { isTrusted: false });
  f.input.emit('pointerdown', { isTrusted: false, button: 0 });
  await flush();
  assert.equal(f.calls(), 0);
  f.close();
});

test('a real pointer, native typing, paste and IME share one automatic attempt', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.input.emit('pointerdown', { button: 0 });
  f.document.emit('focusin', { target: f.input });
  f.input.emit('input'); f.input.emit('paste'); f.input.emit('compositionstart');
  await flush();
  assert.equal(f.calls(), 1);
  finish(); await flush();
  f.input.emit('input'); f.input.emit('pointerdown', { button: 0 });
  await flush(); assert.equal(f.calls(), 1);
  f.close();
});

test('a trusted accessibility click can express intention without a preceding pointer event', async () => {
  const f = fixture(); f.input.emit('click'); await flush();
  assert.equal(f.calls(), 1); f.close();
});

test('Tab arriving at this input is intention; Tab to another field or window restoration is not', async () => {
  const f = fixture();
  f.document.emit('keydown', { key: 'Tab' });
  f.document.emit('focusin', { target: new Target() });
  f.document.emit('focusin', { target: f.input });
  f.document.emit('keydown', { key: 'Tab' }); f.browser.emit('blur');
  f.document.emit('focusin', { target: f.input });
  await flush(); assert.equal(f.calls(), 0);
  f.document.emit('keydown', { key: 'Tab' });
  f.document.emit('focusin', { target: f.input });
  await flush(); assert.equal(f.calls(), 1);
  f.close();
});

test('offline or blocked intention is not spent and eligibility is rechecked before opening', async () => {
  const f = fixture();
  f.available(false); f.input.emit('input'); await flush(); assert.equal(f.calls(), 0);
  f.available(true); f.input.emit('input'); f.available(false);
  await flush(); assert.equal(f.calls(), 0);
  f.available(true); f.input.emit('input'); await flush(); assert.equal(f.calls(), 1);
  f.close();
  const next = fixture(); next.available(false); next.input.emit('input'); await flush();
  next.available(true); next.input.emit('input'); await flush(); assert.equal(next.calls(), 1);
  next.close();
});

test('explicit retry can retry a failed automatic connection, but neither path runs in parallel', async () => {
  let calls = 0, finish;
  const intent = createComposerConnectionIntent({ available: () => true, connect: async () => {
    calls++;
    if (calls === 1) throw new Error('connection failed');
    await new Promise(resolve => { finish = resolve; });
  } });
  await assert.rejects(intent.request(), /failed/);
  await intent.request(); assert.equal(calls, 1);
  const retry = intent.request(true);
  assert.equal(intent.request(true), retry);
  await flush(); assert.equal(calls, 2);
  finish(); await retry;
  intent.dispose();
});

test('leaving the view cancels a not-yet-started connection and removes input listeners', async () => {
  const f = fixture(); f.input.emit('input'); f.close();
  await flush(); assert.equal(f.calls(), 0);
  f.input.emit('pointerdown', { button: 0 }); f.input.emit('input');
  f.document.emit('keydown', { key: 'Tab' }); f.document.emit('focusin', { target: f.input });
  await flush(); assert.equal(f.calls(), 0);
});

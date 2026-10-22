import test from 'node:test';
import assert from 'node:assert/strict';
import { displayedPocketContent, observeVisiblePocketRead } from '../src/readObservation.ts';
import { createPocketReadStateStore } from '../src/pocketReadState.ts';
import { displayConversation } from '../src/transcript.ts';

const message = { id: 'assistant', role: 'assistant', text: 'A complete visible answer', phase: 'final', turnId: 'turn' };
const content = { known: true, scope: 'source-one', revision: 1, version: 'a'.repeat(64), messageId: message.id };
const transcript = { source: 'rollout', messages: [message], checkedAt: 1, pocketContent: content };

test('cached complete assistant content can be read locally with later user messages', () => {
  assert.equal(displayedPocketContent(transcript, [message]), content);
  assert.equal(displayedPocketContent(transcript, [message, { id: 'user', role: 'user', text: 'Continue' }]), content);
  assert.equal(displayedPocketContent(null, [message]), null);
  assert.equal(displayedPocketContent({ ...transcript, pocketContent: null }, [message]), null);
  assert.equal(displayedPocketContent({ ...transcript, pocketContent: { ...content, messageId: null } }, [message]), null);
});

test('stale, truncated, or differently rendered assistant targets cannot mark newer content', () => {
  for (const change of [{ id: 'other' }, { role: 'user' }, { text: message.text + ' New output' }, { phase: 'commentary' }, { turnId: 'other-turn' }, { truncated: true }])
    assert.equal(displayedPocketContent(transcript, [{ ...message, ...change }]), null);
  assert.equal(displayedPocketContent({ ...transcript, messages: [{ ...message, truncated: true }] }, [message]), null);
  assert.equal(displayedPocketContent(transcript, [message, { ...message, id: 'newer-assistant' }]), null);
});

function fixture({ getContent, online = true } = {}) {
  const browser = new EventTarget(), visibility = new EventTarget(), frames = new Map(), seen = [];
  let id = 0, intersection;
  Object.assign(browser, { navigator: { onLine: online }, requestAnimationFrame: callback => { frames.set(++id, callback); return id; }, cancelAnimationFrame: frame => frames.delete(frame) });
  Object.assign(visibility, { visibilityState: 'visible', querySelector: () => null });
  const root = { getBoundingClientRect: () => ({ top: 0, bottom: 500, width: 390, height: 500 }) };
  const target = { getBoundingClientRect: () => ({ top: 499, bottom: 500, width: 340, height: 1 }), closest: () => null };
  class Observer { constructor(callback) { intersection = callback; } observe() {} disconnect() { intersection = null; } }
  const stop = observeVisiblePocketRead({ browser, visibility, Observer, root, target, content, getContent, onVisible: value => seen.push(value) });
  const paint = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  return { browser, visibility, root, target, stop, paint, seen, intersect: value => intersection?.([{ target, isIntersecting: value, intersectionRatio: value ? 1 : 0 }]) };
}

test('local reading works offline only after two visible frames and only once', () => {
  const f = fixture({ online: false });
  f.paint(); f.paint(); assert.equal(f.seen.length, 0);
  f.intersect(true); f.paint(); assert.equal(f.seen.length, 0);
  f.paint(); assert.deepEqual(f.seen, [content]);
  f.intersect(true); f.paint(); f.paint(); assert.equal(f.seen.length, 1);
  f.stop();
});

test('background, overlays, folded content and old scroll position do not count as visible reading', () => {
  const blockers = [
    f => { f.visibility.visibilityState = 'hidden'; },
    f => { f.visibility.querySelector = selector => selector.includes('dialog[open]') ? {} : null; },
    f => { f.visibility.querySelector = selector => selector === '.sidebar-backdrop.shown' ? { getBoundingClientRect: () => ({ width: 390, height: 500 }) } : null; },
    f => { f.target.closest = () => ({}); },
    f => { f.target.getBoundingClientRect = () => ({ top: 799, bottom: 800, width: 340, height: 1 }); },
  ];
  for (const block of blockers) {
    const f = fixture(); block(f); f.intersect(true); f.paint(); f.paint(); assert.equal(f.seen.length, 0); f.stop();
  }
});

test('closing an overlay resumes the same observation without a new network read', () => {
  const f = fixture(); let open = true;
  f.visibility.querySelector = selector => selector.includes('[data-reading-overlay]') && open ? {} : null;
  f.intersect(true); f.paint(); f.paint(); assert.equal(f.seen.length, 0);
  open = false; f.browser.dispatchEvent(new Event('pocket-reading-visibility-change'));
  f.paint(); f.paint(); assert.equal(f.seen.length, 1); f.stop();
});

test('leaving, changed content, source reset or layout protection cancels the pending observation', () => {
  for (const replacement of [null, { ...content, revision: 2 }, { ...content, version: 'b'.repeat(64) }, { ...content, scope: 'source-two' }, { ...content, messageId: 'other' }]) {
    let current = content;
    const f = fixture({ getContent: () => current }); f.intersect(true); f.paint(); current = replacement; f.paint();
    assert.equal(f.seen.length, 0); f.stop();
  }
  const f = fixture(); f.intersect(true); f.paint(); f.stop(); f.paint(); assert.equal(f.seen.length, 0);
});

test('observing old cached content cannot clear an unseen newer stream revision', () => {
  const storage = new Map();
  const store = createPocketReadStateStore({ machine: () => 'ged', browser: () => undefined,
    storage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  const newer = { ...content, revision: 2, version: 'b'.repeat(64) };
  store.observeCatalog([{ id: 'thread', pocketContent: newer, hasUnreadTurn: true }]);
  store.markSeen('thread', displayedPocketContent(transcript, [message]));
  assert.equal(store.unread({ id: 'thread', pocketContent: newer }), true);
  store.markSeen('thread', newer);
  assert.equal(store.unread({ id: 'thread', pocketContent: newer }), false);
});


test('a clipped saved tail may borrow the native turn identity without losing readable content', () => {
  const saved = { ...transcript, messages: [{ ...message, turnId: null }] };
  const live = { source: 'desktop', messages: [message], checkedAt: 2, runtime: 'idle', canSend: true, hint: '' };
  const displayed = displayConversation(live, saved).messages;
  assert.equal(displayed[0].turnId, message.turnId);
  assert.equal(displayedPocketContent(saved, displayed), content);
});

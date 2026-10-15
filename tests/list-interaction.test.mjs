import test from 'node:test';
import assert from 'node:assert/strict';
import { bindListInteraction, heldListRows } from '../src/listInteraction.ts';

class Target extends EventTarget {
  listeners = [];
  addEventListener(type, fn, options) { super.addEventListener(type, fn, options); this.listeners.push({ type, fn, capture: options === true || !!options?.capture }); }
  removeEventListener(type, fn, options) { super.removeEventListener(type, fn, options); this.listeners = this.listeners.filter(item => item.type !== type || item.fn !== fn || item.capture !== (options === true || !!options?.capture)); }
  fire(type, target, fields = {}) { const event = new Event(type, { cancelable: true }); Object.defineProperty(event, 'target', { value: target }); Object.assign(event, fields); this.dispatchEvent(event); return event; }
}
function fixture() {
  const root = new Target(), document = new Target(), browser = new Target(), timers = new Map();
  const a = { dataset: { rowMotionId: 'a' }, style: { height: '', overflow: '' }, getBoundingClientRect: () => ({ height: 80 }) };
  const b = { dataset: { rowMotionId: 'b' }, style: { height: '90px', overflow: 'visible' }, getBoundingClientRect: () => ({ height: 90 }) };
  a.closest = () => a; b.closest = () => b;
  root.querySelectorAll = () => [a, b];
  const attrs = new Set(); root.setAttribute = key => attrs.add(key); root.removeAttribute = key => attrs.delete(key);
  let clock = 0, next = 1, scope = 'all', holds = 0, releases = 0;
  const current = new Set(['a', 'b']);
  document.hidden = false; browser.document = document;
  browser.setTimeout = (fn, delay) => { const id = next++; timers.set(id, { at: clock + delay, fn }); return id; };
  browser.clearTimeout = id => timers.delete(id);
  const control = bindListInteraction(root, { scope: () => scope, current: id => current.has(id), hold: () => holds++, release: () => releases++ }, browser);
  const advance = ms => { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } };
  return { root, document, browser, a, b, control, current, attrs, timers, advance,
    get holds() { return holds; }, get releases() { return releases; },
    scope: value => { scope = value; control.scopeChanged(); },
  };
}

test('held order keeps fresh row data even after the former last visible row ranks beyond its display limit', () => {
  const a = { id: 'a', state: 'idle' }, b = { id: 'b', state: 'running' };
  const next = [{ id: 'new', state: 'waiting' }, { ...b, state: 'complete' }, { ...a, state: 'waiting' }];
  assert.deepEqual(heldListRows(next, [a, b]), [next[2], next[1]]);
  assert.deepEqual(heldListRows([next[0], next[1]], [a, b]), [a, next[1]], 'a removed row keeps space until the press settles');
  assert.deepEqual(heldListRows(next, null), next, 'release adopts the latest actual rank');
});

test('pointer press freezes geometry and a click on the pressed current row is allowed before release', () => {
  const f = fixture();
  f.root.fire('pointerdown', f.a, { pointerId: 1, button: 0 });
  assert.equal(f.holds, 1); assert.equal(f.a.style.height, '80px'); assert.equal(f.b.style.height, '90px');
  assert.equal(f.a.style.overflow, 'hidden'); assert.ok(f.attrs.has('data-list-interacting'));
  f.document.fire('pointerup', f.a, { pointerId: 1 }); f.advance(120);
  assert.equal(f.releases, 0, 'pointerup is earlier than the browser click');
  assert.equal(f.root.fire('click', f.a, { detail: 1 }).defaultPrevented, false);
  f.advance(0); assert.equal(f.releases, 1);
  assert.deepEqual(f.a.style, { height: '', overflow: '' }); assert.deepEqual(f.b.style, { height: '90px', overflow: 'visible' });
  f.control.dispose();
});

test('touchend keeps row positions until the delayed synthesized click has settled', () => {
  const f = fixture();
  f.root.fire('touchstart', f.a, { touches: [{}] });
  f.document.fire('touchend', f.a, { touches: [] }); f.advance(300);
  assert.equal(f.releases, 0);
  assert.equal(f.root.fire('click', f.a, { detail: 1 }).defaultPrevented, false);
  f.advance(0); assert.equal(f.releases, 1); assert.equal(f.timers.size, 0);
  f.control.dispose();
});

test('a displaced pointer release can never activate another row', () => {
  const f = fixture(); let activated = false;
  f.root.addEventListener('click', () => { activated = true; });
  f.root.fire('pointerdown', f.a, { pointerId: 1, button: 0 }); f.document.fire('pointerup', f.b, { pointerId: 1 });
  assert.equal(f.root.fire('click', f.b, { detail: 1 }).defaultPrevented, true);
  assert.equal(activated, false); f.advance(0); f.control.dispose();
});

test('removed or filtered-out targets cannot open through touch or keyboard clicks', () => {
  const f = fixture();
  f.root.fire('touchstart', f.a, { touches: [{}] }); f.current.delete('a');
  f.document.fire('touchend', f.a, { touches: [] });
  for (const detail of [1, 0]) assert.equal(f.root.fire('click', f.a, { detail }).defaultPrevented, true);
  f.advance(0); f.control.dispose();
});

test('changing scope releases the old layout but blocks the old press from selecting a new-scope row', () => {
  const f = fixture();
  f.root.fire('pointerdown', f.a, { pointerId: 1, button: 0 }); f.scope('project');
  assert.equal(f.releases, 1); assert.equal(f.a.style.height, '');
  f.document.fire('pointerup', f.b, { pointerId: 1 });
  assert.equal(f.root.fire('click', f.b, { detail: 1 }).defaultPrevented, true);
  f.advance(0); f.control.dispose();
});

test('keyboard activation stays immediate without a motion preference requirement', () => {
  const f = fixture();
  assert.equal(f.root.fire('click', f.a, { detail: 0 }).defaultPrevented, false);
  assert.equal(f.holds, 0); assert.equal(f.timers.size, 0); f.control.dispose();
});

test('cancelled gestures, release outside the list and no-click scrolls cannot leave a frozen layout', () => {
  for (const ending of ['cancel', 'outside', 'touch-cancel']) {
    const f = fixture();
    if (ending === 'touch-cancel') { f.root.fire('touchstart', f.a, { touches: [{}] }); f.document.fire('touchcancel', f.a, { touches: [] }); }
    else { f.root.fire('pointerdown', f.a, { pointerId: 1, button: 0 }); f.document.fire(ending === 'cancel' ? 'pointercancel' : 'pointerup', null, { pointerId: 1 }); }
    f.advance(400); assert.equal(f.releases, 1, ending); assert.equal(f.timers.size, 0); assert.equal(f.a.style.height, ''); f.control.dispose();
  }
});

test('multi-touch, visibility loss and disposal release temporary geometry and listeners', () => {
  const f = fixture();
  f.root.fire('pointerdown', f.a, { pointerId: 1, button: 0 });
  f.root.fire('pointerdown', f.b, { pointerId: 2, button: 0 });
  assert.equal(f.holds, 1);
  f.document.fire('pointerup', f.a, { pointerId: 1 }); f.advance(500); assert.equal(f.releases, 0);
  f.document.hidden = true; f.document.fire('visibilitychange', f.document);
  assert.equal(f.a.style.height, ''); assert.equal(f.timers.size, 0);
  f.control.dispose(); f.control.dispose();
  for (const node of [f.root, f.document, f.browser]) assert.equal(node.listeners.length, 0);
});

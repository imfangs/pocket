import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTaskListMotion } from '../src/taskListMotion.ts';

class Target extends EventTarget {
  listeners = [];
  addEventListener(type, callback, options) {
    super.addEventListener(type, callback, options);
    this.listeners.push({ type, callback, capture: options === true || !!options?.capture });
  }
  removeEventListener(type, callback, options) {
    super.removeEventListener(type, callback, options);
    const capture = options === true || !!options?.capture;
    this.listeners = this.listeners.filter(item => item.type !== type || item.callback !== callback || item.capture !== capture);
  }
  fire(type, fields = {}) { const event = new Event(type); Object.assign(event, fields); this.dispatchEvent(event); return event; }
}
class Node extends Target {
  dataset = {};
  attrs = new Map();
  children = [];
  calls = [];
  top = 0;
  height = 80;
  clientHeight = 500;
  scrollTop = 0;
  setAttribute(key, value) { this.attrs.set(key, value); }
  removeAttribute(key) { this.attrs.delete(key); }
  getBoundingClientRect() { return { top: this.top, bottom: this.top + this.height, height: this.height }; }
  querySelectorAll() { return this.children; }
  animate(frames, options) {
    const animation = new Target();
    animation.cancelled = false;
    animation.cancel = () => { animation.cancelled = true; animation.fire('cancel'); };
    this.calls.push({ frames, options, animation });
    return animation;
  }
}
function fixture({ count = 5, height = 500 } = {}) {
  const root = new Node(), panel = new Node(), document = new Target(), browser = new Target(), media = new Target();
  let clock = 1000, selection = false, overlay = false, inert = false, swiping = false;
  panel.height = panel.clientHeight = browser.innerHeight = height;
  media.matches = false;
  root.closest = selector => selector === '.list-panel' ? panel : inert ? root : null;
  root.querySelector = () => swiping ? root : null;
  document.querySelector = () => overlay ? root : null;
  document.hidden = false;
  browser.document = document;
  browser.performance = { now: () => clock };
  browser.matchMedia = () => media;
  browser.getSelection = () => ({ isCollapsed: !selection });
  const rows = Array.from({ length: count }, (_, i) => {
    const node = new Node(), status = new Node();
    node.dataset = { rowMotionId: String(i), rowPriority: 'false' }; node.top = i * 80;
    status.dataset = { listStatus: 'primary', listStatusKey: 'time' }; node.children = [status];
    return node;
  });
  root.children = rows;
  const control = bindTaskListMotion(root, browser);
  const commit = (scope = 'all') => { control.prepareLayout(); control.commit(scope); };
  const prioritize = (id = '3', position = 1) => {
    const row = rows.find(row => row.dataset.rowMotionId === id);
    row.dataset.rowPriority = 'true';
    const order = root.children.filter(item => item !== row); order.splice(position, 0, row);
    order.forEach((item, index) => { item.top = index * 80; }); root.children = order;
  };
  const calls = () => rows.flatMap(node => node.calls.map(call => ({ node, ...call })));
  const statusCalls = () => rows.flatMap(node => node.children.flatMap(status => status.calls));
  commit();
  return { root, panel, document, browser, media, rows, control, commit, prioritize, calls, statusCalls,
    tick: ms => { clock += ms; }, select: value => { selection = value; }, overlay: value => { overlay = value; }, inert: value => { inert = value; }, swipe: value => { swiping = value; } };
}

test('initial render, repeated polling and background rank changes never move rows', () => {
  const f = fixture();
  assert.equal(f.calls().length, 0); assert.equal(f.statusCalls().length, 0);
  f.commit(); f.prioritize(); f.commit();
  assert.equal(f.calls().length, 0); assert.equal(f.statusCalls().length, 0);
  f.control.dispose();
});

test('a confirmed Pocket priority change animates only the affected visible rows toward their actual rank, not the top', () => {
  const f = fixture();
  f.control.beginPriority('3', true);
  f.commit(); // The in-flight UI can render without changing the actual Pocket priority.
  assert.equal(f.calls().length, 0);
  f.prioritize('3', 1); f.commit();
  assert.deepEqual(f.calls().map(call => call.node.dataset.rowMotionId).sort(), ['1', '2', '3']);
  const moved = f.rows[3].calls[0];
  assert.deepEqual(moved.frames, [{ transform: 'translateY(160px)' }, { transform: 'translateY(0px)' }]);
  assert.equal(moved.options.duration, 180);
  assert.equal(f.control.isMoving(), true);
  f.commit(); // An unrelated later render cannot replay the consumed intent.
  assert.equal(f.calls().length, 3); assert.equal(f.control.isMoving(), false);
  f.control.dispose();
});

test('priority failure, keyboard actions and a changed list scope do not animate', () => {
  for (const mode of ['failure', 'keyboard', 'scope']) {
    const f = fixture();
    f.control.beginPriority('3', true, mode !== 'keyboard');
    if (mode === 'failure') f.control.cancelPriority('3');
    f.prioritize(); f.commit(mode === 'scope' ? 'project/new' : 'all');
    assert.equal(f.calls().length, 0, mode); f.control.dispose();
  }
});

test('background reorder while a priority change is pending becomes the new baseline without playing', () => {
  const f = fixture();
  f.control.beginPriority('3', true);
  f.rows[0].top = 80; f.rows[1].top = 0; f.commit();
  assert.equal(f.calls().length, 0);
  f.prioritize(); f.commit();
  assert.equal(f.rows[3].calls[0].frames[0].transform, 'translateY(160px)');
  f.control.dispose();
});

test('cancelling priority and leaving a scoped view requires successful confirmation before sibling movement', () => {
  const f = fixture(); f.rows[1].dataset.rowPriority = 'true'; f.commit();
  f.control.beginPriority('1', false);
  f.control.confirmPriority('1');
  f.root.children = f.rows.filter(row => row !== f.rows[1]);
  f.root.children.forEach((row, index) => { row.top = index * 80; }); f.commit();
  assert.deepEqual(f.calls().map(call => call.node.dataset.rowMotionId), ['2', '3', '4']);
  f.control.dispose();
});

test('only rows visible at both ends animate, with a maximum of eight near the acted row', () => {
  const f = fixture({ count: 20, height: 1200 });
  f.control.beginPriority('12', true); f.prioritize('12', 1); f.commit();
  assert.equal(f.calls().length, 8);
  assert.ok(f.calls().every(call => Number(call.node.dataset.rowMotionId) < 15));
  f.control.dispose();
  const g = fixture({ count: 10 });
  g.control.beginPriority('8', true); g.prioritize('8', 1); g.commit();
  assert.equal(g.rows[8].calls.length, 0, 'a newly visible row does not fly in from offscreen');
  g.control.dispose();
});

test('real status identity changes fade once, while clock text and later polls do not replay', () => {
  const f = fixture(), status = f.rows[0].children[0];
  status.textContent = '刚刚'; f.commit(); assert.equal(f.statusCalls().length, 0);
  status.dataset.listStatusKey = 'running'; f.commit();
  assert.equal(f.statusCalls().length, 1); assert.equal(status.calls[0].options.duration, 120);
  assert.deepEqual(status.calls[0].frames, [{ opacity: .45 }, { opacity: 1 }]);
  f.commit(); assert.equal(f.statusCalls().length, 1);
  status.dataset.listStatusKey = 'waiting_input'; f.commit();
  assert.equal(f.statusCalls().length, 2);
  status.dataset.listStatusKey = 'time'; f.commit();
  assert.equal(f.statusCalls().length, 3);
  status.textContent = '1 分钟'; f.commit(); assert.equal(f.statusCalls().length, 3);
  f.control.dispose();
});

test('new badges on an existing row fade; newly mounted or offscreen rows stay still', () => {
  const f = fixture({ count: 10 });
  const status = new Node(); status.dataset = { listStatus: 'secondary', listStatusKey: 'unread' };
  f.rows[0].children.push(status);
  f.rows[8].children[0].dataset.listStatusKey = 'running';
  const row = new Node(), badge = new Node();
  row.dataset = { rowMotionId: 'fresh', rowPriority: 'false' }; row.top = 400;
  badge.dataset = { listStatus: 'primary', listStatusKey: 'running' }; row.children = [badge];
  f.root.children.push(row); f.commit();
  assert.equal(status.calls.length, 1); assert.equal(f.rows[8].children[0].calls.length, 0); assert.equal(badge.calls.length, 0);
  f.control.dispose();
});

test('scroll, touch, text selection, context menu, reduced motion and overlays skip stale priority animation', () => {
  for (const condition of ['scroll', 'pointer', 'touch', 'selection', 'contextmenu', 'reduced', 'overlay', 'inert', 'swipe', 'hidden']) {
    const f = fixture(); f.control.beginPriority('3', true);
    if (condition === 'scroll') { f.panel.scrollTop = 20; f.panel.fire('scroll'); }
    if (condition === 'pointer') f.root.fire('pointerdown', { pointerId: 1 });
    if (condition === 'touch') f.root.fire('touchstart');
    if (condition === 'selection') { f.select(true); f.document.fire('selectionchange'); }
    if (condition === 'contextmenu') f.root.fire('contextmenu');
    if (condition === 'reduced') { f.media.matches = true; f.media.fire('change'); }
    if (condition === 'overlay') f.overlay(true);
    if (condition === 'inert') f.inert(true);
    if (condition === 'swipe') f.swipe(true);
    if (condition === 'hidden') { f.document.hidden = true; f.document.fire('visibilitychange'); }
    f.prioritize(); f.commit(); assert.equal(f.calls().length, 0, condition);
    f.control.dispose();
  }
});

test('a fresh interaction cancels an active animation without claiming or preventing the event', () => {
  const f = fixture(); f.control.beginPriority('3', true); f.prioritize(); f.commit();
  const event = f.root.fire('pointerdown', { pointerId: 4 });
  assert.equal(event.defaultPrevented, false); assert.equal(f.control.isMoving(), false);
  assert.ok(f.calls().every(call => call.animation.cancelled));
  assert.ok(f.rows.every(row => !row.attrs.has('data-list-moving')));
  f.document.fire('pointerup', { pointerId: 4 });
  f.control.dispose();
});

test('an anchor correction is measured before FLIP and its asynchronous scroll event does not cancel it', () => {
  const f = fixture(); f.control.beginPriority('3', true); f.prioritize();
  // TaskList first restores its visible ID anchor, then calls commit.
  f.panel.scrollTop = 80; f.rows.forEach(row => { row.top -= 80; }); f.commit();
  assert.equal(f.control.isMoving(), true);
  f.panel.fire('scroll'); assert.equal(f.control.isMoving(), true);
  f.panel.scrollTop = 100; f.panel.fire('scroll'); assert.equal(f.control.isMoving(), false);
  f.control.dispose();
});

test('finishing, losing the window, reduced motion and disposal release transforms and every listener', () => {
  for (const end of ['finish', 'blur', 'reduce', 'dispose']) {
    const f = fixture(); f.control.beginPriority('3', true); f.prioritize(); f.commit();
    if (end === 'finish') for (const call of f.calls()) call.animation.fire('finish');
    if (end === 'blur') f.browser.fire('blur');
    if (end === 'reduce') { f.media.matches = true; f.media.fire('change'); }
    if (end === 'dispose') f.control.dispose();
    assert.equal(f.control.isMoving(), false, end);
    assert.ok(f.rows.every(row => !row.attrs.has('data-list-moving')), end);
    f.control.dispose(); f.control.dispose();
    for (const target of [f.root, f.panel, f.document, f.browser, f.media]) assert.equal(target.listeners.length, 0, end);
  }
});

test('missing or failing WAAPI falls back to the already committed row order', () => {
  for (const animate of [undefined, () => { throw new Error('unsupported'); }]) {
    const f = fixture(); f.rows.forEach(row => { row.animate = animate; });
    f.control.beginPriority('3', true); f.prioritize(); assert.doesNotThrow(() => f.commit());
    assert.equal(f.rows[3].top, 80); assert.equal(f.control.isMoving(), false); f.control.dispose();
  }
});


test('Codex pin changes cannot confirm a pending Pocket priority change', () => {
  const f = fixture();
  f.rows[3].dataset.rowPinned = 'true'; // Legacy effective pin already true.
  f.control.beginPriority('3', true);
  f.rows[3].dataset.codexPinned = 'true';
  f.rows[0].top = 80; f.rows[1].top = 0; f.commit();
  assert.equal(f.calls().length, 0, 'native pin state does not complete the Pocket action');
  f.prioritize('3', 1); f.commit();
  assert.equal(f.rows[3].calls.length, 1, 'the later Pocket state transition still owns its motion');
  f.control.dispose();
});

test('clearing priority animates independently while a Codex pin stays set', () => {
  const f = fixture();
  f.rows[1].dataset.rowPriority = 'true';
  f.rows[1].dataset.rowPinned = 'true';
  f.rows[1].dataset.codexPinned = 'true';
  f.commit();
  f.control.beginPriority('1', false);
  f.rows[1].dataset.rowPriority = 'false';
  f.rows[1].top = 160; f.rows[2].top = 80; f.commit();
  assert.deepEqual(f.calls().map(call => call.node.dataset.rowMotionId), ['1', '2']);
  assert.equal(f.rows[1].dataset.codexPinned, 'true');
  assert.equal(f.rows[1].dataset.rowPinned, 'true');
  f.control.dispose();
});

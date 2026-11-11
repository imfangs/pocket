import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveReadingAnchor } from '../src/liveReadingAnchor.ts';

function fixture() {
  let enabled = true;
  const root = { scrollTop: 140, getBoundingClientRect: () => ({ top: 50, bottom: 550 }), querySelectorAll: () => nodes };
  const row = (id, y, hidden = false) => ({ dataset: { messageId: id }, y,
    getBoundingClientRect() { return { top: 50 + this.y - root.scrollTop, bottom: 150 + this.y - root.scrollTop, width: hidden ? 0 : 300, height: hidden ? 0 : 100 }; } });
  const nodes = [row('first', 100), row('shared', 220), row('later', 440), row('last', 700)];
  const anchor = createLiveReadingAnchor({ root: () => root, enabled: () => enabled });
  return { root, nodes, anchor, enabled: value => { enabled = value; } };
}

test('a source adding a prefix keeps the same visible row offset', () => {
  const { root, nodes, anchor } = fixture(); anchor.prepare();
  nodes.forEach(node => { node.y += 500; });
  assert.equal(anchor.restore(), true); assert.equal(root.scrollTop, 640);
  assert.equal(nodes[0].getBoundingClientRect().top, 10);
  assert.equal(anchor.restore(), false);
});

test('reading after notification takes over before DOM changes', () => {
  const { root, nodes, anchor } = fixture(); anchor.prepare();
  root.scrollTop = 440; anchor.updateReading();
  nodes.forEach(node => { node.y += 500; }); anchor.restore();
  assert.equal(root.scrollTop, 940); assert.equal(nodes[2].getBoundingClientRect().top, 50);
});

test('a second feed notification also yields to the newer reading position', () => {
  const { root, nodes, anchor } = fixture(); anchor.prepare();
  root.scrollTop = 440; anchor.prepare(); anchor.updateReading();
  nodes.forEach(node => { node.y += 200; }); anchor.restore();
  assert.equal(root.scrollTop, 640);
});

test('a replacement user ID can fall back to another shared visible row, never matching by text', () => {
  const { root, nodes, anchor } = fixture(); anchor.prepare();
  nodes[0].dataset.messageId = 'replacement'; nodes.forEach(node => { node.y += 180; });
  assert.equal(anchor.restore(), true); assert.equal(root.scrollTop, 320);
  anchor.prepare(); nodes.forEach(node => { node.dataset.messageId += '-other'; });
  const before = root.scrollTop; assert.equal(anchor.restore(), false); assert.equal(root.scrollTop, before);
});

test('native browser anchoring is not replayed and following/history mode cancels old anchors', () => {
  const { root, nodes, anchor, enabled } = fixture(); anchor.prepare(); anchor.updateReading();
  nodes.forEach(node => { node.y += 500; }); root.scrollTop += 500;
  anchor.restore(); assert.equal(root.scrollTop, 640);
  anchor.prepare(); enabled(false); anchor.updateReading(); nodes.forEach(node => { node.y += 500; });
  assert.equal(anchor.restore(), false); assert.equal(root.scrollTop, 640);
});

test('conflicting IDs cannot move the reader to a different occurrence', () => {
  const { root, nodes, anchor } = fixture();
  nodes[0].dataset.messageId = nodes[1].dataset.messageId;
  anchor.prepare(); nodes.shift(); nodes.forEach(node => { node.y += 200; });
  assert.equal(anchor.restore(), true); assert.equal(root.scrollTop, 340, 'the unique later row remains the anchor');
  anchor.prepare(); nodes[2].dataset.messageId = nodes[1].dataset.messageId;
  nodes[0].dataset.messageId += '-changed';
  const before = root.scrollTop; assert.equal(anchor.restore(), false); assert.equal(root.scrollTop, before);
});

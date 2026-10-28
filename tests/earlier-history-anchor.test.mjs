import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEarlierHistoryAnchor, restoreEarlierHistoryAnchor } from '../src/earlierHistoryAnchor.ts';
function fixture() {
  const root = { scrollTop: 140, getBoundingClientRect: () => ({ top: 50, bottom: 550 }), querySelectorAll: () => nodes };
  const row = (id, y, hidden = false) => ({ dataset: { messageId: id }, y,
    getBoundingClientRect() { return { top: 50 + this.y - root.scrollTop, bottom: 150 + this.y - root.scrollTop, width: hidden ? 0 : 300, height: hidden ? 0 : 100 }; } });
  const nodes = [row('shared-assistant', 5, true), row('native-user', 100), row('shared-assistant', 220), row('other', 700)];
  return { root, nodes };
}
test('the first shared visible identity can follow a different native user ID', () => {
  const { root } = fixture();
  assert.deepEqual(captureEarlierHistoryAnchor(root), { id: 'native-user', offset: -40 });
  assert.deepEqual(captureEarlierHistoryAnchor(root, new Set(['shared-assistant'])), { id: 'shared-assistant', offset: 80 });
  assert.equal(captureEarlierHistoryAnchor(root, new Set(['same-text-but-different-id'])), null);
});
test('prepend restores the same visible offset, skipping the hidden live copy', () => {
  const { root, nodes } = fixture(), anchor = captureEarlierHistoryAnchor(root, new Set(['shared-assistant']));
  nodes.slice(1).forEach(node => { node.y += 500; });
  restoreEarlierHistoryAnchor(root, anchor);
  assert.equal(root.scrollTop, 640);
  assert.equal(nodes[2].getBoundingClientRect().top - root.getBoundingClientRect().top, 80);
});

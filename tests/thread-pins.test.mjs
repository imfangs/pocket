import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveNewerPins } from '../src/threadPins.ts';

const catalog = threads => ({ threads, groups: [], projects: [], sourceInfo: null, sourceError: null });
const pinned = { id: 'one', pinned: true, pinnedOrder: -1, pinRevision: 5, pinSource: 'pocket', note: 'Old note' };

test('a late save or batch response cannot overwrite a newer pin but still updates the note', () => {
  const incoming = catalog([{ ...pinned, pinned: false, pinnedOrder: 2, pinRevision: 4, pinSource: 'codex', note: 'Saved note' }]);
  assert.deepEqual(preserveNewerPins(catalog([pinned]), incoming).threads[0], { ...pinned, note: 'Saved note' });
});
test('a newer restore generation can remove a Pocket override and return to the source pin', () => {
  const incoming = catalog([{ ...pinned, pinned: false, pinnedOrder: -1, pinRevision: 6, pinSource: 'codex' }]);
  assert.equal(preserveNewerPins(catalog([pinned]), incoming), incoming);
});
test('legacy responses without a pin generation preserve known pin state and never affect other tasks', () => {
  const incoming = catalog([{ id: 'one', title: 'Updated title', pinned: false }, { id: 'two', pinned: false }]);
  const result = preserveNewerPins(catalog([pinned]), incoming);
  assert.equal(result.threads[0].pinned, true); assert.equal(result.threads[0].title, 'Updated title');
  assert.equal(result.threads[1], incoming.threads[1]);
});
test('equal generations accept source updates without cloning an unchanged catalog', () => {
  const incoming = catalog([{ ...pinned, note: 'Current note' }]);
  assert.equal(preserveNewerPins(catalog([pinned]), incoming), incoming);
});

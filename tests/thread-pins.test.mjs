import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveNewerThreadMetadata } from '../src/threadMetadata.ts';

const catalog = threads => ({ threads, groups: [], projects: [], sourceInfo: null, sourceError: null });
const pinned = { id: 'one', pinned: true, pinnedOrder: -1, pinRevision: 5, pinSource: 'pocket', note: 'Old note' };

test('a late save or catalog response cannot overwrite a newer pin but still updates the note', () => {
  const incoming = catalog([{ ...pinned, pinned: false, pinnedOrder: 2, pinRevision: 4, pinSource: 'codex', note: 'Saved note' }]);
  assert.deepEqual(preserveNewerThreadMetadata(catalog([pinned]), incoming).threads[0], { ...pinned, note: 'Saved note' });
});
test('a newer restore generation can remove a Pocket override and return to the source pin', () => {
  const incoming = catalog([{ ...pinned, pinned: false, pinnedOrder: -1, pinRevision: 6, pinSource: 'codex' }]);
  assert.equal(preserveNewerThreadMetadata(catalog([pinned]), incoming), incoming);
});
test('legacy responses without a pin generation preserve known pin state and never affect other tasks', () => {
  const incoming = catalog([{ id: 'one', title: 'Updated title', pinned: false }, { id: 'two', pinned: false }]);
  const result = preserveNewerThreadMetadata(catalog([pinned]), incoming);
  assert.equal(result.threads[0].pinned, true); assert.equal(result.threads[0].title, 'Updated title');
  assert.equal(result.threads[1], incoming.threads[1]);
});
test('equal generations accept source updates without cloning an unchanged catalog', () => {
  const incoming = catalog([{ ...pinned, note: 'Current note' }]);
  assert.equal(preserveNewerThreadMetadata(catalog([pinned]), incoming), incoming);
});

test('late catalog, note and open results cannot restore a title older than a successful native rename', () => {
  const renamed = { ...pinned, title: '新名称', titleRevision: 12 };
  const incoming = catalog([{ ...renamed, title: '原标题', titleRevision: 11, note: '说明已保存', lastOpenedAt: 100 }]);
  const actual = preserveNewerThreadMetadata(catalog([renamed]), incoming).threads[0];
  assert.equal(actual.title, '新名称');
  assert.equal(actual.titleRevision, 12);
  assert.equal(actual.note, '说明已保存');
  assert.equal(actual.lastOpenedAt, 100);
});

test('title and pin versions advance independently, including legacy replies without one generation', () => {
  const current = { ...pinned, title: 'Known title', titleRevision: 12 };
  const freshPin = { ...current, title: 'Old title', titleRevision: 11, pinned: false, pinRevision: 6 };
  assert.deepEqual(preserveNewerThreadMetadata(catalog([current]), catalog([freshPin])).threads[0],
    { ...freshPin, title: current.title, titleRevision: 12 });
  const freshTitle = { ...current, title: 'New native title', titleRevision: 13, pinned: false, pinRevision: 4 };
  assert.deepEqual(preserveNewerThreadMetadata(catalog([current]), catalog([freshTitle])).threads[0],
    { ...freshTitle, pinned: true, pinRevision: 5 });
  const legacy = { ...current, title: 'Stale legacy title', titleRevision: undefined };
  assert.equal(preserveNewerThreadMetadata(catalog([current]), catalog([legacy])).threads[0].title, current.title);
  const newest = catalog([{ ...current, title: 'New native title', titleRevision: 13, pinRevision: 6 }]);
  assert.equal(preserveNewerThreadMetadata(catalog([current]), newest), newest);
});

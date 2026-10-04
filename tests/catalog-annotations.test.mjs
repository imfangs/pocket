import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NavigatorStore } from '../server/store.mjs';

test('bulk catalog preserves inherited groups, explicit removal, notes and missing sources', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-catalog-'));
  const store = new NavigatorStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const source = {
    threads: ['inherited', 'removed', 'edited', 'missing'].map(id => ({ id, projectId: 'project', title: id })),
    projects: [{ id: 'project', name: 'Project' }], sourceInfo: { scope: 'synthetic' },
  };
  store.sync(source);
  const groupId = store.groups()[0].id;
  store.patchThread('removed', { expectedRevision: 0, groupIds: [] }, false);
  store.patchThread('edited', { expectedRevision: 0, intent: 'later', note: '保留说明', reviewAt: '2026-10-05' }, false);
  store.patchThread('missing', { expectedRevision: 0, note: '来源消失也保留' }, false);
  store.sync({ ...source, threads: source.threads.filter(t => t.id !== 'missing') });

  const catalog = store.catalog();
  assert.equal(catalog.threads.length, 4);
  for (const thread of catalog.threads) {
    const original = store.thread(thread.id);
    assert.deepEqual(thread, { ...original, ...store.annotation(thread.id, original) });
  }
  const byId = new Map(catalog.threads.map(t => [t.id, t]));
  assert.deepEqual(byId.get('inherited').groupIds, [groupId]);
  assert.deepEqual(byId.get('removed').groupIds, []);
  assert.equal(byId.get('edited').note, '保留说明');
  assert.equal(byId.get('edited').revision, 1);
  assert.equal(byId.get('edited').reviewAt, '2026-10-05');
  assert.equal(byId.get('missing').missing, true);
  assert.equal(byId.get('missing').note, '来源消失也保留');
});

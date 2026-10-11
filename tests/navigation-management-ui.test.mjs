import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationViewCount, normalizeNavigationPrefs } from '../src/navigationModel.ts';
import { emptyListContent, threadListStates } from '../src/listPresentation.ts';
import { modalCloseDecision } from '../src/modalInteraction.ts';
import { creationDirectories, creationDirectoryChoices, creationLocation, searchCreationDirectories } from '../src/creationLocations.ts';

const thread = { id: 'one', archived: false, separator: false, missing: false, pinned: false, intent: 'later', lastOpenedAt: 1, groupIds: [], updatedAt: 1 };
test('sidebar view counts include separator records while excluding archived conversations from normal views', () => {
  const catalog = { threads: [thread, { ...thread, id: 'separator', separator: true }, { ...thread, id: 'archived', archived: true }], groups: [] };
  assert.equal(navigationViewCount(catalog, 'recent'), 2);
  assert.equal(navigationViewCount(catalog, 'archived'), 1);
  assert.equal(navigationViewCount(catalog, 'all'), 2);
});
test('old arrangement and group preferences return to all while preserving supported pin order', () => {
  for (const view of ['group', 'unassigned', 'active', 'later', 'reference', 'unknown'])
    assert.deepEqual(normalizeNavigationPrefs({ view, groupId: 'old-group', sort: 'pinned', sortVersion: 2 }),
      { view: 'all', sort: 'pinned', sortVersion: 2 });
  for (const view of ['all', 'unread', 'running', 'pinned', 'recent', 'archived'])
    assert.equal(normalizeNavigationPrefs({ view }).view, view);
  for (const value of [null, undefined, 'broken', 42, { view: 'all', sort: 'review', sortVersion: 2 }])
    assert.deepEqual(normalizeNavigationPrefs(value), { view: 'all', sort: 'updated', sortVersion: 2 });
});
test('row state labels describe evidence rather than treating ordinary idle as unread', () => {
  assert.deepEqual(threadListStates(thread), []);
  assert.deepEqual(threadListStates({ ...thread, needsInput: true }, true).map(state => state.key), ['draft', 'unread']);
  assert.deepEqual(threadListStates({ ...thread, needsInput: true, archived: true }).map(state => state.key), ['archived']);
  assert.deepEqual(threadListStates({ ...thread, needsInput: true, missing: true }).map(state => state.key), ['missing']);
});
test('empty views offer a relevant next step, and unavailable unread state is never presented as empty', () => {
  assert.equal(emptyListContent({ view: 'all', query: '' }).action, 'create');
  assert.equal(emptyListContent({ view: 'recent', query: '' }).action, 'showAll');
  assert.equal(emptyListContent({ view: 'all', query: 'search' }).action, 'clearQuery');
  assert.equal(emptyListContent({ view: 'all', query: '', hasFilters: true }).action, 'clearFilters');
  const unread = emptyListContent({ view: 'unread', query: '', unreadAvailable: false });
  assert.equal(unread.action, 'refresh'); assert.match(unread.title, /无法读取/);
});
test('modal backdrop clicks cannot discard unsaved input and busy operations disable closing', () => {
  assert.equal(modalCloseDecision(false, true, true), 'ignore');
  assert.equal(modalCloseDecision(false, true), 'confirm');
  assert.equal(modalCloseDecision(true, false), 'ignore');
  assert.equal(modalCloseDecision(false, false, true), 'close');
});
test('directory search only filters choices and never changes a native project selection', () => {
  const locations = [{ id: 'one', cwd: '/one/Shared', projectId: 'native-one', label: 'Shared' }, { id: 'two', cwd: '/one/Shared', projectId: 'native-two', label: 'Shared' }, { id: 'other', cwd: '/other/folder', label: 'Other' }];
  const directories = creationDirectories(locations), choices = creationDirectoryChoices(directories);
  assert.deepEqual(searchCreationDirectories(choices, 'ONE shared').map(choice => choice.directory.cwd), ['/one/Shared']);
  assert.deepEqual(searchCreationDirectories(choices, 'other').map(choice => choice.directory.cwd), ['/other/folder']);
  assert.equal(creationLocation(directories, '/one/Shared', 'two'), locations[1]);
  assert.equal(creationLocation(directories, '/one/Shared', ''), null);
  assert.deepEqual(searchCreationDirectories(choices, 'missing'), []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { navigationViewCount, normalizeNavigationPrefs, sidebarNavigationCounts } from '../src/navigationModel.ts';
import { filterThreads } from '../src/model.ts';
import { projectNavigationItems, UNASSIGNED_PROJECT } from '../src/projectNavigation.ts';
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
test('sidebar counts match full menu destinations, including dual flags, legacy pins and native project identities', () => {
  const rows = [
    { id: 'plain', projectId: 'first' },
    { id: 'both', projectId: 'first', pocketPriority: true, codexPinned: true },
    { id: 'priority', projectId: 'second', pocketPriority: true },
    { id: 'codex', projectId: 'second', codexPinned: true },
    { id: 'legacy-pocket', projectId: 'first', pinned: true, pinSource: 'pocket' },
    { id: 'legacy-codex', projectId: null, pinned: true, pinSource: 'codex' },
    { id: 'explicit-off', projectId: 'first', pinned: true, pocketPriority: false, codexPinned: false },
    { id: 'separator', projectId: 'first', separator: true },
    { id: 'missing', projectId: null, missing: true },
    { id: 'archived', projectId: 'first', archived: true, pocketPriority: true, codexPinned: true },
    { id: 'excluded', projectId: 'second', sourceExcluded: true, pocketPriority: true, codexPinned: true },
  ].map(row => ({ ...thread, ...row }));
  const before = structuredClone(rows);
  const counts = sidebarNavigationCounts(rows);
  assert.equal(counts.all, 9);
  assert.equal(counts.priority, 3);
  assert.equal(counts.codexPinned, 3);
  assert.deepEqual([...counts.projects], [['first', 5], ['second', 2], [UNASSIGNED_PROJECT, 2]]);
  for (const [view, count] of [['all', counts.all], ['priority', counts.priority], ['codex-pinned', counts.codexPinned]])
    assert.equal(count, filterThreads(rows, view, '', '', 'smart').length, view);
  const projects = ['first', 'second', 'empty'].map((id, order) => ({ id, name: 'Same name', paths: ['/same/path'], order, separator: false }));
  for (const item of projectNavigationItems(projects, rows))
    assert.equal(counts.projects.get(item.id) || 0, filterThreads(rows, 'all', '', item.id, 'smart').length, item.id);
  assert.deepEqual(rows, before);
});
test('sidebar counts retain cached scopes through source failure and update after archive or priority changes', () => {
  const catalog = { threads: [{ ...thread, projectId: 'one', pocketPriority: true }], sourceError: null };
  const original = sidebarNavigationCounts(catalog.threads);
  const unavailable = { ...catalog, sourceError: 'temporarily unavailable', sourceInfo: null };
  assert.deepEqual(sidebarNavigationCounts(unavailable.threads), original);
  assert.equal(sidebarNavigationCounts([{ ...catalog.threads[0], pocketPriority: false }]).priority, 0);
  assert.deepEqual(sidebarNavigationCounts([{ ...catalog.threads[0], archived: true }]),
    { all: 0, priority: 0, codexPinned: 0, hidden: 0, projects: new Map() });
});
test('retired views and invalid preferences migrate to independent smart navigation', () => {
  const defaults = { scope: 'all', project: '', activity: 'all', sort: 'smart', sortVersion: 4 };
  for (const view of ['group', 'unassigned', 'active', 'later', 'reference', 'unknown', 'pinned', 'recent'])
    assert.deepEqual(normalizeNavigationPrefs({ view, groupId: 'old-group', sort: 'pinned', sortVersion: 2 }), defaults);
  for (const scope of ['all', 'priority', 'codex-pinned', 'archived'])
    assert.deepEqual(normalizeNavigationPrefs({ view: scope }), { ...defaults, scope });
  for (const value of [null, undefined, 'broken', 42, { view: 'all', sort: 'review', sortVersion: 2 }])
    assert.deepEqual(normalizeNavigationPrefs(value), defaults);
});
test('v3 activity and creation views retain a persisted project and migrate separate filters', () => {
  const defaults = { scope: 'all', project: 'project-a', activity: 'all', sort: 'smart', sortVersion: 4 };
  assert.deepEqual(normalizeNavigationPrefs({ view: 'all', project: 'project-a', sortVersion: 3 }), defaults);
  for (const activity of ['unread', 'running'])
    assert.deepEqual(normalizeNavigationPrefs({ view: activity, project: 'project-a', sortVersion: 3 }), { ...defaults, activity });
  assert.deepEqual(normalizeNavigationPrefs({ view: 'created', project: 'project-a', sortVersion: 3 }), { ...defaults, sort: 'created' });
  for (const scope of ['priority', 'codex-pinned']) {
    assert.deepEqual(normalizeNavigationPrefs({ view: scope, project: 'project-a', sortVersion: 3 }), { ...defaults, scope, project: '' });
    assert.deepEqual(normalizeNavigationPrefs({ scope, view: 'running', sortVersion: 3 }), { ...defaults, scope, project: '', activity: 'running' });
  }
  assert.equal(emptyListContent({ view: 'all', query: '', projectScope: 'project-a' }).action, 'showAll');
});
test('row state labels describe evidence rather than treating ordinary idle as unread', () => {
  assert.deepEqual(threadListStates(thread), []);
  assert.deepEqual(threadListStates({ ...thread, needsInput: true }, true).map(state => state.key), ['draft', 'unread']);
  assert.deepEqual(threadListStates({ ...thread, needsInput: true, archived: true }).map(state => state.key), ['archived']);
  assert.deepEqual(threadListStates({ ...thread, needsInput: true, missing: true }).map(state => state.key), ['missing']);
});
test('empty views offer a relevant next step, and unavailable unread state is never presented as empty', () => {
  assert.equal(emptyListContent({ view: 'all', query: '' }).action, 'create');
  assert.equal(emptyListContent({ view: 'created', query: '' }).action, 'create');
  assert.equal(emptyListContent({ view: 'created', query: '', projectScope: 'reports' }).action, 'showAll');
  assert.equal(emptyListContent({ view: 'created', query: 'search' }).action, 'clearQuery');
  assert.equal(emptyListContent({ view: 'created', query: 'search', projectScope: 'reports' }).action, 'searchAll');
  assert.equal(emptyListContent({ view: 'recent', query: '' }).action, 'showAll');
  for (const view of ['priority', 'codex-pinned']) {
    const empty = emptyListContent({ view, query: '' });
    assert.equal(empty.action, 'showAll');
    assert.equal(empty.description, '');
    assert.match(empty.title, view === 'priority' ? /关注/ : /置顶/);
    assert.equal(emptyListContent({ view, query: 'search' }).action, 'clearQuery');
  }
  assert.equal(emptyListContent({ view: 'all', query: 'search' }).action, 'clearQuery');
  assert.equal(emptyListContent({ view: 'all', query: 'search', projectScope: 'project-a' }).action, 'searchAll');
  assert.equal(emptyListContent({ view: 'all', query: 'search', projectScope: 'project-a' }).actionLabel, '在全部会话搜索');
  assert.equal(emptyListContent({ view: 'archived', query: 'search', projectScope: 'project-a' }).action, 'clearQuery');
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

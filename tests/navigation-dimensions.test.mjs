import test from 'node:test';
import assert from 'node:assert/strict';
import { changeNavigation, navigationActivityCounts, navigationTitle, normalizeNavigationPrefs } from '../src/navigationModel.ts';
import { filterThreads } from '../src/model.ts';
import { emptyListContent, threadListPresentation, threadListStates } from '../src/listPresentation.ts';
import { hasUnreadContent } from '../src/unread.ts';
import { needsUserInput, smartThreadScore } from '../src/smartOrder.ts';

const now = Date.UTC(2026, 9, 19);
const base = { id: 'base', title: 'Weekly report', cwd: '/side/reports', projectName: 'Reports', projectId: 'reports',
  archived: false, sourceExcluded: false, missing: false, separator: false, pocketPriority: false, codexPinned: false,
  createdAt: now - 10000, updatedAt: now, lastMessageAt: now, needsInput: false };
const prefs = normalizeNavigationPrefs(null);
const ids = rows => rows.map(row => row.id);
const select = (rows, state, query = '', statuses) => filterThreads(rows, state.scope, query, state.project,
  state.sort, statuses, { now }, state.activity);

test('scope, runtime filter and creation order compose without replacing the title', () => {
  const rows = [
    { ...base, id: 'old-priority', pocketPriority: true, codexPinned: true, createdAt: now - 20000 },
    { ...base, id: 'new-priority', pocketPriority: true, createdAt: now - 1 },
    { ...base, id: 'plain-new', createdAt: now },
    { ...base, id: 'idle-priority', pocketPriority: true, createdAt: now + 1 },
  ];
  const statuses = new Map(rows.map(row => [row.id, row.id === 'idle-priority' ? 'idle' : 'running']));
  let state = changeNavigation(prefs, { type: 'scope', scope: 'priority' });
  state = changeNavigation(state, { type: 'activity', activity: 'running' });
  assert.equal(navigationTitle(state, []), '关注');
  assert.deepEqual(ids(select(rows, state, '', statuses)), ['old-priority', 'new-priority']);
  state = changeNavigation(state, { type: 'sort' });
  assert.deepEqual(ids(select(rows, state, '', statuses)), ['new-priority', 'old-priority']);
  assert.equal(navigationTitle(state, []), '关注');
  state = changeNavigation(state, { type: 'sort' });
  assert.equal(state.activity, 'running');
  assert.deepEqual(ids(select(rows, state, '', statuses)), ['old-priority', 'new-priority']);
});

test('project, unread and normalized query intersect, with counts scoped to the same search', () => {
  const rows = [
    { ...base, id: 'unread', needsInput: true, hasUnreadTurn: true },
    { ...base, id: 'running', needsInput: true, hasUnreadTurn: true },
    { ...base, id: 'waiting-unread', hasUnreadTurn: true },
    { ...base, id: 'waiting-read', needsInput: true, hasUnreadTurn: false },
    { ...base, id: 'other-project', projectId: 'other', needsInput: true },
    { ...base, id: 'different-query', title: 'Daily notes', needsInput: true },
    { ...base, id: 'excluded', sourceExcluded: true, needsInput: true },
  ];
  const statuses = new Map([['running', 'running'], ['waiting-unread', 'waiting_input'], ['waiting-read', 'waiting_approval']]);
  let state = changeNavigation(prefs, { type: 'project', project: 'reports' });
  state = changeNavigation(state, { type: 'activity', activity: 'unread' });
  const query = 'ＷＥＥＫＬＹ reports';
  assert.deepEqual(ids(select(rows, state, query, statuses)).sort(), ['unread', 'waiting-unread']);
  assert.deepEqual(navigationActivityCounts(rows, state, query, statuses), { unread: 2, running: 1 });
  assert.equal(navigationTitle(state, [{ id: 'reports', name: 'Reports' }]), 'Reports');
  state = changeNavigation(state, { type: 'activity', activity: 'running' });
  assert.deepEqual(ids(select(rows, state, query, statuses)), ['running']);
  assert.deepEqual(navigationActivityCounts(rows, state, query, statuses), { unread: 2, running: 1 });
});

test('menu changes keep activity and sort while archive safely clears inapplicable activity', () => {
  let state = { ...prefs, activity: 'unread', sort: 'created' };
  for (const scope of ['priority', 'codex-pinned', 'all']) {
    state = changeNavigation(state, { type: 'scope', scope });
    assert.deepEqual(state, { ...prefs, scope, activity: 'unread', sort: 'created' });
  }
  state = changeNavigation(state, { type: 'project', project: 'reports' });
  assert.equal(state.activity, 'unread'); assert.equal(state.sort, 'created');
  state = changeNavigation(state, { type: 'activity', activity: 'unread' });
  assert.equal(state.activity, 'all'); assert.equal(state.project, 'reports'); assert.equal(state.sort, 'created');
  state = changeNavigation(state, { type: 'activity', activity: 'running' });
  state = changeNavigation(state, { type: 'scope', scope: 'archived' });
  assert.deepEqual(state, { ...prefs, scope: 'archived', sort: 'created' });
  assert.equal(changeNavigation(state, { type: 'activity', activity: 'running' }), state);
  assert.deepEqual(ids(select([{ ...base, id: 'archived', archived: true }], state)), ['archived']);
});

test('v4 preferences round trip all independent dimensions and reject unknown values', () => {
  for (const scope of ['all', 'priority', 'codex-pinned']) for (const activity of ['all', 'unread', 'running']) for (const sort of ['smart', 'created', 'activity']) {
    const state = { ...prefs, scope, project: scope === 'all' ? 'reports' : '', activity, sort };
    assert.deepEqual(normalizeNavigationPrefs(JSON.parse(JSON.stringify(state))), state);
  }
  assert.deepEqual(normalizeNavigationPrefs({ sortVersion: 4, scope: 'archived', activity: 'unread', sort: 'created', project: 'reports' }),
    { ...prefs, scope: 'archived', sort: 'created' });
  assert.deepEqual(normalizeNavigationPrefs({ sortVersion: 4, scope: 'broken', project: 'x'.repeat(257), activity: 'idle', sort: 'title' }), prefs);
  assert.deepEqual(normalizeNavigationPrefs({ sortVersion: 4, scope: 'priority', view: 'unread', activity: 'running', sort: 'created' }),
    { ...prefs, scope: 'priority', activity: 'running', sort: 'created' });
  assert.deepEqual(normalizeNavigationPrefs({ sortVersion: 4, scope: 'archived', activity: 'running', sort: 'activity' }),
    { ...prefs, scope: 'archived', sort: 'activity' });
});

test('creation and activity sorting replace only each other and toggle back to smart', () => {
  const initial = { ...prefs, scope: 'priority', activity: 'running',
    priorityReturn: { scope: 'all', project: 'reports' } };
  let state = changeNavigation(initial, { type: 'sort', sort: 'activity' });
  assert.deepEqual(state, { ...initial, sort: 'activity' });
  state = normalizeNavigationPrefs(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(state, { ...initial, sort: 'activity' });
  state = changeNavigation(state, { type: 'sort', sort: 'created' });
  assert.deepEqual(state, { ...initial, sort: 'created' });
  state = changeNavigation(state, { type: 'sort', sort: 'activity' });
  state = changeNavigation(state, { type: 'sort', sort: 'activity' });
  assert.deepEqual(state, initial);
  // Existing callers that omit a target still toggle creation order.
  state = changeNavigation({ ...initial, sort: 'activity' }, { type: 'sort' });
  assert.deepEqual(state, { ...initial, sort: 'created' });
  assert.deepEqual(changeNavigation(state, { type: 'sort' }), initial);
});

test('activity sort persists across projects, priority returns and archive navigation', () => {
  const initial = { ...prefs, project: 'reports', activity: 'running', sort: 'activity' };
  const priority = changeNavigation(initial, { type: 'togglePriority' });
  assert.deepEqual(changeNavigation(normalizeNavigationPrefs(priority), { type: 'togglePriority' }), initial);
  const nextProject = changeNavigation(initial, { type: 'project', project: 'other' });
  assert.deepEqual(nextProject, { ...initial, project: 'other' });
  assert.deepEqual(changeNavigation(nextProject, { type: 'scope', scope: 'archived' }),
    { ...prefs, scope: 'archived', sort: 'activity' });
});

test('priority shortcut lists only Pocket attention and restores the previous project without reverting other dimensions', () => {
  const rows = [
    { ...base, id: 'report-priority', pocketPriority: true, createdAt: now - 20000 },
    { ...base, id: 'other-priority', pocketPriority: true, projectId: 'other', createdAt: now - 1 },
    { ...base, id: 'codex-only', codexPinned: true },
    { ...base, id: 'neither' },
    { ...base, id: 'archived-priority', archived: true, pocketPriority: true },
    { ...base, id: 'excluded-priority', sourceExcluded: true, pocketPriority: true },
  ];
  const before = structuredClone(rows);
  const statuses = new Map(rows.map(row => [row.id, 'running']));
  let state = { ...prefs, project: 'reports' };
  state = changeNavigation(state, { type: 'togglePriority' });
  assert.deepEqual(state, { ...prefs, scope: 'priority', priorityReturn: { scope: 'all', project: 'reports' } });
  state = changeNavigation(state, { type: 'activity', activity: 'running' });
  state = changeNavigation(state, { type: 'sort' });
  assert.deepEqual(ids(select(rows, state, 'weekly', statuses)), ['other-priority', 'report-priority']);
  assert.equal(navigationTitle(state, []), '关注');
  state = normalizeNavigationPrefs(JSON.parse(JSON.stringify(state)));
  state = changeNavigation(state, { type: 'togglePriority' });
  assert.deepEqual(state, { ...prefs, project: 'reports', activity: 'running', sort: 'created' });
  assert.deepEqual(ids(select(rows, state, 'weekly', statuses)), ['codex-only', 'neither', 'report-priority']);
  assert.deepEqual(rows, before);
});

test('priority shortcut returns to Codex pins and menu navigation discards the previous return destination', () => {
  const original = { ...prefs, scope: 'codex-pinned', activity: 'unread', sort: 'created' };
  const attention = changeNavigation(original, { type: 'togglePriority' });
  assert.deepEqual(changeNavigation(normalizeNavigationPrefs(attention), { type: 'togglePriority' }), original);
  for (const change of [{ type: 'scope', scope: 'all' }, { type: 'scope', scope: 'priority' }, { type: 'project', project: 'reports' }]) {
    const next = changeNavigation(attention, change);
    assert.equal(next.priorityReturn, undefined);
    assert.equal(next.activity, 'unread'); assert.equal(next.sort, 'created');
  }
  const menuAttention = changeNavigation(attention, { type: 'scope', scope: 'priority' });
  assert.deepEqual(changeNavigation(menuAttention, { type: 'togglePriority' }), { ...prefs, activity: 'unread', sort: 'created' });
  const archived = { ...prefs, scope: 'archived' };
  assert.equal(changeNavigation(archived, { type: 'togglePriority' }), archived);
});

test('priority return preferences accept only bounded active destinations and cannot alter other scopes', () => {
  const attention = { ...prefs, scope: 'priority' };
  for (const back of [null, true, 'reports', {}, { scope: 'priority', project: '' }, { scope: 'archived', project: '' },
    { scope: 'all', project: {} }, { scope: 'all', project: 'x'.repeat(257) }])
    assert.deepEqual(normalizeNavigationPrefs({ ...attention, priorityReturn: back }), attention);
  assert.deepEqual(normalizeNavigationPrefs({ ...attention, priorityReturn: { scope: 'all', project: 'reports' } }),
    { ...attention, priorityReturn: { scope: 'all', project: 'reports' } });
  assert.deepEqual(normalizeNavigationPrefs({ ...attention, priorityReturn: { scope: 'codex-pinned', project: 'stale', activity: 'running' } }),
    { ...attention, priorityReturn: { scope: 'codex-pinned', project: '' } });
  for (const scope of ['all', 'codex-pinned', 'archived'])
    assert.deepEqual(normalizeNavigationPrefs({ ...prefs, scope, priorityReturn: { scope: 'all', project: 'reports' } }), { ...prefs, scope });
  assert.deepEqual(normalizeNavigationPrefs({ view: 'priority', sortVersion: 3, priorityReturn: { scope: 'all', project: 'reports' } }), attention);
});

test('read flags, waiting states and list labels share one precise unread predicate', () => {
  for (const hasUnreadTurn of [undefined, null, false, true]) for (const needsInput of [false, true])
    for (const status of [undefined, 'idle', 'unknown', 'running', 'waiting_input', 'waiting_approval']) {
      const row = { ...base, hasUnreadTurn, needsInput };
      const statuses = new Map([[row.id, status]]);
      const expected = status !== 'running' && hasUnreadTurn !== false &&
        (status === 'waiting_input' || status === 'waiting_approval' ? hasUnreadTurn === true : needsInput);
      assert.equal(hasUnreadContent(row, status), expected, JSON.stringify({ hasUnreadTurn, needsInput, status }));
      assert.equal(filterThreads([row], 'unread', '', '', 'updated', statuses).length === 1, expected);
      assert.equal(threadListStates(row, false, status).some(state => state.key === 'unread'), expected);
    }
  for (const exclusion of ['sourceExcluded', 'archived', 'missing', 'separator']) {
    const row = { ...base, needsInput: true, hasUnreadTurn: true, [exclusion]: true };
    assert.equal(hasUnreadContent(row, 'waiting_input'), false, exclusion);
    assert.equal(threadListStates(row, false, 'waiting_input').some(state => state.key === 'unread'), false, exclusion);
  }
});

test('waiting keeps its primary badge and attention rank without falsely marking a read task unread', () => {
  for (const status of ['waiting_input', 'waiting_approval']) {
    const read = { ...base, needsInput: false, hasUnreadTurn: false };
    const unread = { ...read, hasUnreadTurn: true };
    assert.equal(needsUserInput(read, status), true);
    assert.equal(smartThreadScore(read, { now, runtimeStates: new Map([[read.id, status]]) }),
      smartThreadScore(unread, { now, runtimeStates: new Map([[unread.id, status]]) }));
    assert.deepEqual(threadListPresentation(read, false, status), { primaryState: { key: status, label: status === 'waiting_input' ? '等待回答' : '等待确认' }, secondaryStates: [] });
    const presentation = threadListPresentation(unread, false, status);
    assert.equal(presentation.primaryState.key, status);
    assert.deepEqual(presentation.secondaryStates, [{ key: 'unread', label: '未读' }]);
  }
});

test('empty filtered scopes clear only the activity and preserve project, sort and query', () => {
  const state = { ...prefs, project: 'reports', activity: 'unread', sort: 'created' };
  for (const query of ['', 'weekly']) {
    const content = emptyListContent({ view: state.scope, projectScope: state.project, activity: state.activity, query, unreadAvailable: true });
    assert.equal(content.action, 'clearFilters');
    assert.equal(content.actionLabel, '取消未读筛选');
    assert.deepEqual(changeNavigation(state, { type: 'clearActivity' }), { ...state, activity: 'all' });
  }
  const unavailable = emptyListContent({ view: 'priority', activity: 'running', query: '', runtimeAvailable: false });
  assert.equal(unavailable.action, 'clearFilters');
  assert.equal(unavailable.actionLabel, '取消运行筛选');
});

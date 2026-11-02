import test from 'node:test';
import assert from 'node:assert/strict';
import { filterThreads } from '../src/model.ts';
import { changeNavigation, normalizeNavigationPrefs, sidebarNavigationCounts, navigationTitle } from '../src/navigationModel.ts';
import { preserveNewerThreadMetadata } from '../src/threadMetadata.ts';
import { hasHiddenState, updateThreadHidden } from '../src/hiddenThreads.ts';
import { emptyListContent } from '../src/listPresentation.ts';
import { projectNavigationItems, UNASSIGNED_PROJECT } from '../src/projectNavigation.ts';

const base = { id: 'thread', title: '会话', cwd: '/synthetic', projectId: 'project', projectName: '合成项目', archived: false,
  pocketHidden: false, hiddenRevision: 1, pocketPriority: true, codexPinned: true, pinned: true,
  pinRevision: 1, titleRevision: 1, createdAt: 1, updatedAt: 1, lastMessageAt: 1, needsInput: true };
const catalog = threads => ({ threads, groups: [], projects: [], sourceInfo: null, sourceError: null });
const select = (rows, view) => filterThreads(rows, view, '', '', 'smart', new Map(rows.map(row => [row.id, 'running'])));

test('hidden conversations appear only in their collection, including hidden archives', () => {
  const rows = [base, { ...base, id: 'hidden', pocketHidden: true }, { ...base, id: 'archive', archived: true },
    { ...base, id: 'hidden-archive', pocketHidden: true, archived: true }, { ...base, id: 'excluded', sourceExcluded: true, pocketHidden: true }];
  for (const view of ['all', 'priority', 'codex-pinned', 'pinned', 'created', 'running', 'unread', 'recent', 'archived'])
    assert.ok(select(rows, view).every(row => !row.pocketHidden), view);
  assert.deepEqual(select(rows, 'hidden').map(row => row.id).sort(), ['hidden', 'hidden-archive']);
  assert.equal(rows[1].archived, false);
  assert.equal(rows[1].pocketPriority, true);
  assert.equal(rows[1].codexPinned, true);
});

test('menu counts and unassigned project exclude hidden rows from ordinary destinations', () => {
  const rows = [base, { ...base, id: 'hidden', pocketHidden: true, projectId: null },
    { ...base, id: 'hidden-archive', pocketHidden: true, archived: true }, { ...base, id: 'archive', archived: true }];
  const counts = sidebarNavigationCounts(rows);
  assert.deepEqual({ all: counts.all, priority: counts.priority, pinned: counts.codexPinned, hidden: counts.hidden },
    { all: 1, priority: 1, pinned: 1, hidden: 2 });
  assert.deepEqual([...counts.projects], [['project', 1]]);
  assert.ok(!projectNavigationItems([], rows).some(item => item.id === UNASSIGNED_PROJECT));
});

test('hidden navigation clears unrelated activity and restores as a two-character collection', () => {
  const next = changeNavigation({ ...normalizeNavigationPrefs(null), activity: 'running', project: 'project', sort: 'created' }, { type: 'scope', scope: 'hidden' });
  assert.equal(next.activity, 'all'); assert.equal(next.project, ''); assert.equal(next.sort, 'created');
  assert.equal(navigationTitle(next, []), '隐藏');
  assert.deepEqual(normalizeNavigationPrefs(JSON.parse(JSON.stringify(next))), next);
  assert.equal(changeNavigation(next, { type: 'togglePriority' }), next);
  assert.equal(changeNavigation(next, { type: 'activity', activity: 'unread' }), next);
  assert.equal(emptyListContent({ view: 'hidden', query: '' }).title, '没有隐藏的会话');
});

test('late or partial metadata cannot undo a known hidden projection; a newer restore can', () => {
  const known = { ...base, pocketHidden: true, hiddenRevision: 4 };
  for (const incoming of [{ ...base, title: '较新名称', titleRevision: 3 }, { ...base, pocketHidden: undefined, hiddenRevision: undefined }]) {
    const merged = preserveNewerThreadMetadata(catalog([known]), catalog([incoming])).threads[0];
    assert.equal(merged.pocketHidden, true); assert.equal(merged.hiddenRevision, 4);
    if (incoming.titleRevision === 3) assert.equal(merged.title, '较新名称');
  }
  const restored = preserveNewerThreadMetadata(catalog([known]), catalog([{ ...base, pocketHidden: false, hiddenRevision: 5 }])).threads[0];
  assert.equal(restored.pocketHidden, false); assert.equal(restored.hiddenRevision, 5);
  assert.equal(hasHiddenState({ pocketHidden: true, hiddenRevision: -1 }), false);
});

test('visibility mutations send explicit booleans and preserve intent after a metadata refresh', async () => {
  const calls = [];
  const result = await updateThreadHidden(base, async (path, method, body) => { calls.push({ path, method, body }); return { ...base, pocketHidden: true, hiddenRevision: 2 }; });
  assert.equal(result.pocketHidden, true);
  assert.deepEqual(calls, [{ path: '/api/tasks/thread/hidden', method: 'POST', body: { hidden: true } }]);
  await updateThreadHidden({ ...base, pocketHidden: true }, async (_path, _method, body) => {
    assert.deepEqual(body, { hidden: true }); return { ...base, pocketHidden: true, hiddenRevision: 3 };
  }, { hidden: true });
});

test('a lost mutation response is confirmed by one read, never a second POST', async () => {
  const methods = [];
  const confirmed = await updateThreadHidden(base, async (_path, method) => {
    methods.push(method); if (method === 'POST') throw new Error('network timeout');
    return catalog([{ ...base, pocketHidden: true, hiddenRevision: 2 }]);
  });
  assert.equal(confirmed.pocketHidden, true); assert.deepEqual(methods, ['POST', 'GET']);
  const rejected = [];
  await assert.rejects(updateThreadHidden(base, async (_path, method) => { rejected.push(method); throw Object.assign(new Error('forbidden'), { status: 403 }); }), /forbidden/);
  assert.deepEqual(rejected, ['POST']);
});

test('wrong identity, revision rollback and changed source never apply a visibility receipt', async () => {
  for (const response of [{ ...base, id: 'other', pocketHidden: true, hiddenRevision: 2 },
    { ...base, pocketHidden: true, hiddenRevision: 0 }, { ...base, pocketHidden: false, hiddenRevision: 2 }])
    await assert.rejects(updateThreadHidden(base, async () => response), /尚未确认/);
  for (const fail of [false, true]) {
    let current = true; const calls = [];
    await assert.rejects(updateThreadHidden(base, async (_path, method) => {
      calls.push(method); current = false;
      if (fail) throw new Error('lost reply');
      return { ...base, pocketHidden: true, hiddenRevision: 2 };
    }, { isCurrent: () => current }), /来源已变化/);
    assert.deepEqual(calls, ['POST']);
  }
});

test('scope must agree in direct responses and lost-response catalog checks, even before the app observes a change', async () => {
  const options = { scope: 'source-a', isCurrent: () => true };
  await assert.rejects(updateThreadHidden(base, async () => ({ ...base, pocketHidden: true, hiddenRevision: 2, visibilityScope: 'source-b' }), options), /来源已变化/);
  const calls = [];
  await assert.rejects(updateThreadHidden(base, async (_path, method) => {
    calls.push(method); if (method === 'POST') throw new Error('network');
    return { ...catalog([{ ...base, pocketHidden: true, hiddenRevision: 2 }]), sourceInfo: { pocketRead: { scope: 'source-b' } } };
  }, options), /尚未确认/);
  assert.deepEqual(calls, ['POST', 'GET']);
  const result = await updateThreadHidden(base, async (_path, _method, body) => {
    assert.deepEqual(body, { hidden: true, scope: 'source-a' });
    return { ...base, pocketHidden: true, hiddenRevision: 2, visibilityScope: 'source-a' };
  }, options);
  assert.equal(result.pocketHidden, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { filterThreads } from '../src/model.ts';

const now = Date.UTC(2026, 9, 18, 12);
const day = 86_400_000;
const base = {
  id: 'plain', title: 'Weekly report', cwd: '/side/reports', projectId: 'reports', projectName: 'Reports',
  archived: false, sourceExcluded: false, missing: false, separator: false,
  pinned: false, pocketPriority: false, codexPinned: false, pinnedOrder: -1,
  createdAt: now - 100 * day, updatedAt: now, lastMessageAt: null,
};
const ids = rows => rows.map(row => row.id);

test('recently created orders the complete visible scope by creation regardless of rank and activity', () => {
  const oldPriority = { ...base, id: 'old-priority', pocketPriority: true, codexPinned: true,
    needsInput: true, lastOpenedAt: now, lastMessageAt: now };
  const newer = { ...base, id: 'newer', createdAt: now - day, updatedAt: 1 };
  const oldest = { ...base, id: 'oldest', createdAt: now - 1000 * day };
  const rows = [oldPriority, oldest, newer];
  const states = new Map([[oldPriority.id, 'waiting_input'], [oldest.id, 'running']]);
  const ranking = { now, draftIds: new Set([oldPriority.id]),
    pocketActivity: new Map([[oldPriority.id, { visitedAt: now, createdAt: now }]]) };
  for (const sort of ['smart', 'updated', 'pinned']) {
    assert.deepEqual(ids(filterThreads(rows, 'created', '', '', sort, states, ranking)), ['newer', 'old-priority', 'oldest']);
  }
  assert.equal(filterThreads(rows, 'all', '', '', 'smart', states, ranking)[0], oldPriority);
  assert.equal(filterThreads(rows, 'unread', '', '', 'smart', states, ranking)[0], oldPriority);
});

test('missing or invalid creation timestamps stay after valid dates without borrowing update or message times', () => {
  const rows = [
    { ...base, id: 'tie-b', createdAt: now },
    { ...base, id: 'tie-a', createdAt: now },
    ...[undefined, null, NaN, Infinity, -Infinity, 0, -1, '2026-10-18', 9e15]
      .map((createdAt, index) => ({ ...base, id: `unknown-${index}`, createdAt, updatedAt: now + day, lastMessageAt: now + day })),
    { ...base, id: 'older', createdAt: now - day },
  ];
  const expected = ['tie-a', 'tie-b', 'older', ...Array.from({ length: 9 }, (_, i) => `unknown-${i}`)];
  assert.deepEqual(ids(filterThreads(rows, 'created', '', '', 'smart')), expected);
  assert.deepEqual(ids(filterThreads([...rows].reverse(), 'created', '', '', 'smart')), expected);
});

test('creation order keeps normalized search, project scope and archive/source exclusions', () => {
  const rows = [
    { ...base, id: 'matching-old', createdAt: now - 30 * day },
    { ...base, id: 'matching-new', createdAt: now },
    { ...base, id: 'other-project', projectId: 'other', createdAt: now + 1 },
    { ...base, id: 'other-title', title: 'Meeting notes', createdAt: now + 2 },
    { ...base, id: 'unassigned', projectId: null, createdAt: now + 3 },
    { ...base, id: 'archived', archived: true, createdAt: now + 4 },
    { ...base, id: 'hidden', sourceExcluded: true, createdAt: now + 5 },
  ];
  assert.deepEqual(ids(filterThreads(rows, 'created', 'ＷＥＥＫＬＹ reports', 'reports', 'smart')), ['matching-new', 'matching-old']);
  assert.deepEqual(ids(filterThreads(rows, 'created', '', '__unassigned__', 'smart')), ['unassigned']);
  assert.deepEqual(ids(filterThreads(rows, 'created', '', '', 'smart')), ['unassigned', 'other-title', 'other-project', 'matching-new', 'matching-old']);
});

test('creation sorting leaves source records and runtime observations unchanged', () => {
  const older = Object.freeze({ ...base, id: 'older' });
  const newer = Object.freeze({ ...base, id: 'newer', createdAt: now });
  const rows = Object.freeze([older, newer]);
  const states = new Map([['older', 'running']]);
  const result = filterThreads(rows, 'created', '', '', 'smart', states);
  assert.deepEqual(result, [newer, older]);
  assert.equal(result[0], newer);
  assert.deepEqual(rows, [older, newer]);
  assert.deepEqual([...states], [['older', 'running']]);
});

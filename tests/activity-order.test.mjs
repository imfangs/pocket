import test from 'node:test';
import assert from 'node:assert/strict';
import { filterThreads } from '../src/model.ts';

const now = Date.UTC(2026, 9, 22, 12);
const day = 86_400_000;
const base = {
  id: 'plain', title: 'Weekly report', cwd: '/side/reports', projectId: 'reports', projectName: 'Reports',
  archived: false, sourceExcluded: false, missing: false, separator: false,
  pinned: false, pocketPriority: false, codexPinned: false, pinnedOrder: -1,
  createdAt: now - 100 * day, updatedAt: now, lastMessageAt: null,
};
const ids = rows => rows.map(row => row.id);

test('activity order follows messages regardless of creation, settings, visits and smart rank', () => {
  const oldPriority = Object.freeze({ ...base, id: 'old-priority', pocketPriority: true, codexPinned: true,
    createdAt: now, updatedAt: now, lastOpenedAt: now, lastMessageAt: now - day, hasUnreadTurn: true, needsInput: true });
  const newestMessage = Object.freeze({ ...base, id: 'newest-message', updatedAt: 1, lastMessageAt: now });
  const empty = Object.freeze({ ...base, id: 'empty', createdAt: now, lastOpenedAt: now });
  const rows = Object.freeze([oldPriority, empty, newestMessage]);
  const states = new Map([[oldPriority.id, 'waiting_input'], [empty.id, 'running']]);
  const ranking = { now, draftIds: new Set([oldPriority.id, empty.id]),
    pocketActivity: new Map([[oldPriority.id, { visitedAt: now, createdAt: now }], [empty.id, { visitedAt: now }]]) };
  assert.equal(filterThreads(rows, 'all', '', '', 'smart', states, ranking)[0], oldPriority);
  const sorted = filterThreads(rows, 'all', '', '', 'activity', states, ranking);
  assert.deepEqual(sorted, [newestMessage, oldPriority, empty]);
  assert.deepEqual(rows, [oldPriority, empty, newestMessage]);
  assert.equal(sorted[0], newestMessage);
  assert.deepEqual([...states], [[oldPriority.id, 'waiting_input'], [empty.id, 'running']]);
});

test('unknown message times stay last, with valid creation dates and IDs breaking ties', () => {
  const rows = [
    { ...base, id: 'message-tie-b', lastMessageAt: now, createdAt: now - day },
    { ...base, id: 'message-tie-a', lastMessageAt: now, createdAt: now - day },
    { ...base, id: 'message-tie-newer', lastMessageAt: now, createdAt: now },
    { ...base, id: 'older-message', lastMessageAt: now - day, createdAt: now },
    { ...base, id: 'unknown-recent-creation', createdAt: now },
    ...[undefined, null, NaN, Infinity, -Infinity, 0, -1, '2026-10-22', 9e15]
      .map((lastMessageAt, index) => ({ ...base, id: `unknown-${index}`, lastMessageAt, createdAt: lastMessageAt })),
  ];
  const expected = ['message-tie-newer', 'message-tie-a', 'message-tie-b', 'older-message',
    'unknown-recent-creation', ...Array.from({ length: 9 }, (_, index) => `unknown-${index}`)];
  assert.deepEqual(ids(filterThreads(rows, 'all', '', '', 'activity')), expected);
  assert.deepEqual(ids(filterThreads([...rows].reverse(), 'all', '', '', 'activity')), expected);
});

test('activity order retains project, priority, runtime and search filters and supports archives', () => {
  const rows = [
    { ...base, id: 'matching-old', pocketPriority: true, lastMessageAt: now - day },
    { ...base, id: 'matching-new', pocketPriority: true, lastMessageAt: now },
    { ...base, id: 'idle', pocketPriority: true, lastMessageAt: now + 1 },
    { ...base, id: 'plain', lastMessageAt: now + 2 },
    { ...base, id: 'other-project', pocketPriority: true, projectId: 'other', lastMessageAt: now + 3 },
    { ...base, id: 'other-title', pocketPriority: true, title: 'Meeting notes', lastMessageAt: now + 4 },
    { ...base, id: 'archived', archived: true, lastMessageAt: now + 5 },
    { ...base, id: 'archived-unknown', archived: true, createdAt: NaN },
    { ...base, id: 'excluded', sourceExcluded: true, lastMessageAt: now + 6 },
  ];
  const states = new Map(rows.map(row => [row.id, row.id === 'idle' ? 'idle' : 'running']));
  assert.deepEqual(ids(filterThreads(rows, 'priority', 'ＷＥＥＫＬＹ reports', 'reports', 'activity', states, undefined, 'running')),
    ['matching-new', 'matching-old']);
  const archived = filterThreads(rows, 'archived', '', '', 'activity');
  assert.deepEqual(ids(archived), ['archived', 'archived-unknown']);
  assert.deepEqual(filterThreads(rows, 'archived', '', '', 'smart'), archived);
});

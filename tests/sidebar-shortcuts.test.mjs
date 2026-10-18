import test from 'node:test';
import assert from 'node:assert/strict';
import { filterThreads } from '../src/model.ts';

const now = Date.UTC(2026, 9, 18, 12);
const base = {
  id: 'plain', title: 'Weekly report', cwd: '/side/reports', projectId: 'reports', projectName: 'Reports',
  archived: false, sourceExcluded: false, missing: false, separator: false,
  pinned: false, pinSource: 'pocket', pinnedOrder: -1, pocketPriority: false, codexPinned: false,
  createdAt: 0, updatedAt: now, lastMessageAt: null,
};
const list = (rows, view, query = '', project = '') => filterThreads(rows, view, query, project, 'smart', undefined, { now });
const ids = rows => rows.map(row => row.id);

test('shortcut membership follows independent Pocket and Codex facts, preserving their overlap', () => {
  const rows = [
    base,
    { ...base, id: 'pocket', pocketPriority: true },
    { ...base, id: 'codex', codexPinned: true },
    { ...base, id: 'both', pocketPriority: true, codexPinned: true },
    { ...base, id: 'archived', pocketPriority: true, codexPinned: true, archived: true },
    { ...base, id: 'hidden', pocketPriority: true, codexPinned: true, sourceExcluded: true },
  ];
  const before = structuredClone(rows);
  assert.deepEqual(ids(list(rows, 'priority')), ['both', 'pocket']);
  assert.deepEqual(ids(list(rows, 'codex-pinned')), ['both', 'codex']);
  assert.deepEqual(ids(list(rows, 'pinned')), ['both', 'pocket', 'codex']);
  assert.deepEqual(rows, before);
});

test('shortcut membership retains the existing legacy snapshot fallback', () => {
  const { pocketPriority, codexPinned, ...legacy } = base;
  const rows = [
    { ...legacy, id: 'pocket', pinned: true, pinSource: 'pocket' },
    { ...legacy, id: 'codex', pinned: true, pinSource: 'codex' },
    { ...legacy, id: 'unset', pinned: false },
  ];
  assert.deepEqual(ids(list(rows, 'priority')), ['pocket']);
  assert.deepEqual(ids(list(rows, 'codex-pinned')), ['codex']);
});

test('recent activity can outrank a stale double-marked conversation inside either shortcut', () => {
  const stale = { ...base, id: 'stale-both', pocketPriority: true, codexPinned: true };
  const recent = { ...base, id: 'recent', createdAt: now, lastMessageAt: now };
  assert.deepEqual(ids(list([stale, { ...recent, pocketPriority: true }], 'priority')), ['recent', 'stale-both']);
  assert.deepEqual(ids(list([stale, { ...recent, codexPinned: true }], 'codex-pinned')), ['recent', 'stale-both']);
});

test('search and project scope narrow shortcut membership without admitting unrelated rows', () => {
  const rows = [
    { ...base, id: 'matching', pocketPriority: true, codexPinned: true },
    { ...base, id: 'other-project', pocketPriority: true, codexPinned: true, projectId: 'other' },
    { ...base, id: 'other-title', title: 'Meeting notes', pocketPriority: true, codexPinned: true },
    base,
  ];
  for (const view of ['priority', 'codex-pinned']) {
    assert.deepEqual(ids(list(rows, view, 'ＷＥＥＫＬＹ reports', 'reports')), ['matching']);
    assert.deepEqual(ids(list(rows, view, 'not found')), []);
  }
});

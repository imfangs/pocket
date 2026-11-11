import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prioritizedReadThreads, readPriorityScore, transcriptPrefetchCandidates,
  transcriptPrefetchLimit, unreadPrefetchBoost,
} from '../src/prefetchPriority.ts';
import { smartThreadOrder, smartThreadScore } from '../src/smartOrder.ts';
import { hasUnreadContent } from '../src/unread.ts';

const day = 86400000;
const now = Date.UTC(2026, 9, 30, 8);
const scope = 'synthetic-scope';
const id = value => `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, '0')}`;
const content = (overrides = {}) => ({
  known: true, scope, revision: 1, version: 'a'.repeat(64), messageId: 'synthetic-message', ...overrides,
});
const thread = (value, overrides = {}) => ({
  id: id(value), title: `Synthetic ${value}`, archived: false, missing: false,
  separator: false, sourceExcluded: false, pinned: false, pinnedOrder: -1,
  codexPinned: false, pocketPriority: false, pocketUnread: false,
  createdAt: now - 90 * day, updatedAt: now - day, lastMessageAt: now - day,
  pocketContent: content(), ...overrides,
});
const ids = items => items.map(item => item.id);

test('read urgency reuses the list score and adds only the finite effective-unread bonus', () => {
  assert.equal(unreadPrefetchBoost, 200);
  for (const pocketUnread of [false, true]) {
    for (const status of [undefined, 'idle', 'unknown', 'running', 'waiting_input', 'waiting_approval']) {
      const item = thread(1, { pocketUnread, pocketPriority: true, codexPinned: true });
      const options = {
        now, runtimeStates: new Map(status ? [[item.id, status]] : []),
        draftIds: new Set([item.id]),
        pocketActivity: new Map([[item.id, { createdAt: now - 60000, visitedAt: now }]]),
      };
      const base = smartThreadScore(item, options);
      const expected = hasUnreadContent(item, status) ? base + 200 : base;
      assert.equal(readPriorityScore(item, options), expected, `${pocketUnread}, ${status}`);
    }
  }
});

test('fresh running state suppresses unread urgency without changing the stored unread flag', () => {
  const item = Object.freeze(thread(1, { pocketUnread: true, needsInput: true, hasUnreadTurn: true }));
  const runtimeStates = new Map([[item.id, 'running']]);
  const options = { now, runtimeStates };
  assert.equal(readPriorityScore(item, options), smartThreadScore(item, options));
  assert.equal(item.pocketUnread, true);
  runtimeStates.set(item.id, 'idle');
  assert.equal(readPriorityScore(item, options), smartThreadScore(item, options) + 200);
  runtimeStates.delete(item.id);
  assert.equal(readPriorityScore(item, options), smartThreadScore(item, options) + 200);

  for (const status of ['waiting_input', 'waiting_approval']) {
    const readQuestion = thread(2, { needsInput: true, hasUnreadTurn: true, pocketUnread: false });
    const waiting = { now, runtimeStates: new Map([[readQuestion.id, status]]) };
    assert.equal(readPriorityScore(readQuestion, waiting), smartThreadScore(readQuestion, waiting),
      'an unanswered question is not necessarily unread');
  }
});

test('legacy unread snapshots retain the shared predicate compatibility rules', () => {
  const unread = thread(1, { pocketUnread: undefined, needsInput: true });
  const explicitRead = thread(2, { pocketUnread: undefined, needsInput: true, hasUnreadTurn: false });
  assert.equal(readPriorityScore(unread, { now }), smartThreadScore(unread, { now }) + 200);
  assert.equal(readPriorityScore(explicitRead, { now }), smartThreadScore(explicitRead, { now }));
  const running = { now, runtimeStates: new Map([[unread.id, 'running']]) };
  assert.equal(readPriorityScore(unread, running), smartThreadScore(unread, running));
});

test('recent visits, creation, drafts and both independent priorities still contribute to read ranking', () => {
  const base = thread(1);
  const variants = [
    ['Pocket priority', { pocketPriority: true }, {}, 90],
    ['Codex pin', { codexPinned: true }, {}, 60],
    ['both priorities', { pocketPriority: true, codexPinned: true }, {}, 150],
    ['draft', {}, { draftIds: new Set([base.id]) }, 85],
    ['running', {}, { runtimeStates: new Map([[base.id, 'running']]) }, 70],
    ['Pocket creation', {}, { pocketActivity: new Map([[base.id, { createdAt: now }]]) }, 45],
    ['Pocket visit', {}, { pocketActivity: new Map([[base.id, { visitedAt: now }]]) }, 55],
  ];
  for (const [label, updates, extra, gain] of variants) {
    const candidate = { ...base, ...updates }, options = { now, ...extra };
    assert.ok(Math.abs(readPriorityScore(candidate, options) - readPriorityScore(base, { now }) - gain) < 1e-10, label);
    assert.equal(readPriorityScore(candidate, options), smartThreadScore(candidate, options), label);
  }
  assert.ok(readPriorityScore({ ...base, lastMessageAt: now }, { now }) > readPriorityScore(base, { now }));
  assert.ok(readPriorityScore({ ...base, createdAt: now }, { now }) > readPriorityScore(base, { now }));
});

test('unread is a bounded rank factor rather than an unconditional bucket above active work', () => {
  const oldUnread = thread(1, { pocketUnread: true, lastMessageAt: now - 90 * day });
  const active = thread(2, { createdAt: now, lastMessageAt: now, pocketPriority: true, codexPinned: true });
  const options = {
    now, runtimeStates: new Map([[active.id, 'running']]), draftIds: new Set([active.id]),
    pocketActivity: new Map([[active.id, { createdAt: now, visitedAt: now }]]),
  };
  assert.deepEqual(ids(prioritizedReadThreads([oldUnread, active], options)), [active.id, oldUnread.id]);
  assert.ok(Number.isFinite(readPriorityScore(oldUnread, options)));
});

test('the current detail takes hard priority before the requested limit is applied', () => {
  const selected = thread(9, { lastMessageAt: 0, createdAt: 0 });
  const urgent = thread(1, { pocketUnread: true, lastMessageAt: now, pocketPriority: true });
  const ordinary = thread(2);
  const options = { now, selectedId: selected.id };
  assert.ok(readPriorityScore(urgent, options) > readPriorityScore(selected, options));
  assert.deepEqual(ids(prioritizedReadThreads([urgent, ordinary, selected], options)), [selected.id, urgent.id, ordinary.id]);
  assert.deepEqual(ids(prioritizedReadThreads([urgent, selected], options, 1)), [selected.id]);
  assert.deepEqual(prioritizedReadThreads([urgent, selected], options, 0), []);
});

test('invalid, unavailable and source-excluded records cannot take a read slot even when selected', () => {
  const eligible = thread(1);
  const blocked = [
    thread(2, { id: 'not-a-thread-id' }), thread(3, { archived: true }),
    thread(4, { missing: true }), thread(5, { separator: true }),
    thread(6, { sourceExcluded: true }), thread(7),
  ];
  for (const selected of blocked) {
    const options = { now, selectedId: selected.id, excludedThreadIds: [id(7)] };
    assert.deepEqual(ids(prioritizedReadThreads([...blocked, eligible], options)), [eligible.id]);
    assert.deepEqual(ids(transcriptPrefetchCandidates([...blocked, eligible], scope, options)), [eligible.id]);
  }
});

test('state priority defaults to a bounded 32-item list', () => {
  const threads = Array.from({ length: 40 }, (_, index) => thread(index + 1)).reverse();
  const ordered = smartThreadOrder(threads, { now });
  assert.deepEqual(prioritizedReadThreads(threads, { now }), ordered.slice(0, 32));
  assert.deepEqual(prioritizedReadThreads(threads, { now }, 2), ordered.slice(0, 2));
});

test('transcript candidates reject unknown, foreign or malformed content identities before ranking', () => {
  const invalidContent = [
    undefined, null, {}, content({ known: false }), content({ scope: 'other-scope' }),
    content({ revision: 0 }), content({ revision: -1 }), content({ revision: 1.5 }),
    content({ revision: Number.MAX_SAFE_INTEGER + 1 }), content({ version: undefined }),
    content({ version: 'unknown' }), content({ version: 'g'.repeat(64) }),
    content({ messageId: undefined }), content({ messageId: '' }), content({ messageId: 'x'.repeat(513) }),
  ];
  const blocked = invalidContent.map((pocketContent, index) => thread(index + 100, {
    pocketContent, pocketUnread: true, pocketPriority: true, codexPinned: true, lastMessageAt: now,
  }));
  const eligible = [thread(1), thread(2, { pocketContent: content({ messageId: null }) })];
  assert.deepEqual(transcriptPrefetchCandidates([...blocked, ...eligible], scope, { now }),
    eligible.map(item => ({ id: item.id, content: item.pocketContent })));
});

test('transcript selection excludes the current detail and applies the eight-item cap after eligibility', () => {
  assert.equal(transcriptPrefetchLimit, 8);
  const selected = thread(99, { pocketUnread: true, lastMessageAt: now });
  const eligible = Array.from({ length: 12 }, (_, index) => thread(index + 1));
  const blocked = Array.from({ length: 12 }, (_, index) => thread(index + 100, {
    pocketUnread: true, lastMessageAt: now, pocketContent: content({ scope: 'other-scope' }),
  }));
  const options = { now, selectedId: selected.id, excludedThreadIds: [eligible[0].id] };
  const result = transcriptPrefetchCandidates([...blocked, selected, ...eligible].reverse(), scope, options);
  assert.equal(result.length, 8);
  assert.deepEqual(ids(result), eligible.slice(1, 9).map(item => item.id));
  assert.ok(result.every(item => item.id !== selected.id));
});

test('equal read ranks keep the list stable tie order independently of catalog input order', () => {
  const threads = [thread(4), thread(2), thread(9), thread(1)];
  const expected = ids(smartThreadOrder(threads, { now }));
  const permutations = [threads, [...threads].reverse(), [...threads.slice(1), threads[0]]];
  for (const input of permutations) {
    assert.deepEqual(ids(prioritizedReadThreads(input, { now })), expected);
    assert.deepEqual(ids(transcriptPrefetchCandidates(input, scope, { now })), expected);
  }
});

test('ranking and projection leave catalog, input state and content identities unchanged', () => {
  const threads = Object.freeze([thread(2, { pocketUnread: true }), thread(1)].map(item => Object.freeze({
    ...item, pocketContent: Object.freeze({ ...item.pocketContent, unrelated: 'not-a-cache-contract-field' }),
  })));
  const options = Object.freeze({
    now, selectedId: null, excludedThreadIds: Object.freeze([]),
    runtimeStates: new Map([[id(1), 'running']]), draftIds: new Set([id(2)]),
    pocketActivity: new Map([[id(2), Object.freeze({ createdAt: now, visitedAt: now })]]),
  });
  const before = structuredClone({ threads, options });
  prioritizedReadThreads(threads, options);
  const candidates = transcriptPrefetchCandidates(threads, scope, options);
  assert.deepEqual({ threads, options }, before);
  for (const candidate of candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['content', 'id', 'refresh']);
    assert.deepEqual(Object.keys(candidate.content).sort(), ['known', 'messageId', 'revision', 'scope', 'version']);
    assert.notEqual(candidate.content, threads.find(item => item.id === candidate.id).pocketContent);
  }
  candidates[0].content.revision = 100;
  assert.deepEqual({ threads, options }, before, 'consumer metadata changes cannot rewrite catalog content identity');
});

test('unread and freshly running candidates carry bounded repeat policies without changing list rank or the window', () => {
  const unread = thread(1, { pocketUnread: true }), running = thread(2), ordinary = thread(3);
  const before = structuredClone([unread, running, ordinary]);
  const result = transcriptPrefetchCandidates([unread, running, ordinary], scope,
    { now, runtimeStates: new Map([[running.id, 'running']]) });
  assert.equal(result.find(item => item.id === unread.id).refresh, 'unread');
  assert.equal(result.find(item => item.id === running.id).refresh, 'running');
  assert.equal(result.find(item => item.id === ordinary.id).refresh, undefined);
  assert.deepEqual([unread, running, ordinary], before);
  assert.ok(result.length <= transcriptPrefetchLimit);
});

test('fresh running can inspect unknown content but never a known conflicting source or malformed identity', () => {
  const noVersion = thread(1, { pocketContent: undefined }), unknown = thread(2, { pocketContent: { known: false } });
  const foreign = thread(3, { pocketContent: { known: false, scope: 'foreign' } });
  const malformed = thread(4, { pocketContent: content({ revision: 0 }) });
  const states = new Map([noVersion, unknown, foreign, malformed].map(item => [item.id, 'running']));
  const result = transcriptPrefetchCandidates([noVersion, unknown, foreign, malformed], scope, { now, runtimeStates: states });
  assert.deepEqual(new Set(ids(result)), new Set([noVersion.id, unknown.id]));
  assert.ok(result.every(item => item.content === null && item.refresh === 'running'));
  assert.equal(transcriptPrefetchCandidates([noVersion], scope, { now }).length, 0, 'unknown content alone grants no background read');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPocketReadStateStore } from '../src/pocketReadState.ts';
import { filterThreads } from '../src/model.ts';
import { navigationActivityCounts, normalizeNavigationPrefs } from '../src/navigationModel.ts';
import { threadListStates } from '../src/listPresentation.ts';
import { needsUserInput, smartThreadScore } from '../src/smartOrder.ts';
import { hasUnreadContent } from '../src/unread.ts';

const now = Date.UTC(2026, 9, 22);
const content = revision => ({ scope: 'source-a', revision, version: String(revision).repeat(64), messageId: 'assistant', known: true });
const row = { id: 'one', title: 'One', projectId: 'project', archived: false, missing: false, separator: false,
  createdAt: now - 10000, lastMessageAt: now, updatedAt: now, hasUnreadTurn: true, needsInput: true, pocketContent: content(1) };
const prefs = { ...normalizeNavigationPrefs(null), project: 'project', activity: 'unread' };
const projection = (store, value) => ({ ...value, pocketUnread: store.unread(value) });
function storageFixture() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key), key: index => [...values.keys()][index] ?? null, get length() { return values.size; } };
}

test('visible reading survives reload and drives count, filter, badge and rank despite stale native unread', () => {
  const storage = storageFixture();
  const options = { storage, machine: () => 'ged', browser: () => undefined };
  let store = createPocketReadStateStore(options);
  store.observeCatalog([row], 'source-a');
  const before = projection(store, row);
  const beforeScore = smartThreadScore(before, { now });
  assert.equal(navigationActivityCounts([before], prefs, '').unread, 1);
  store.markSeen(row.id, content(1));
  store = createPocketReadStateStore(options);
  store.observeCatalog([row], 'source-a');
  const after = projection(store, row);
  assert.equal(after.hasUnreadTurn, true);
  assert.equal(after.needsInput, true);
  assert.equal(navigationActivityCounts([after], prefs, '').unread, 0);
  assert.deepEqual(filterThreads([after], prefs.scope, '', prefs.project, prefs.sort, undefined, { now }, prefs.activity), []);
  assert.equal(threadListStates(after).some(state => state.key === 'unread'), false);
  assert.equal(needsUserInput(after), false);
  assert.ok(smartThreadScore(after, { now }) < beforeScore);
  assert.equal(after.lastMessageAt, row.lastMessageAt);
});

test('a desktop read updates count, filter, badge and rank together without answering pending requests', () => {
  const storage = storageFixture();
  const options = { storage, machine: () => 'ged', browser: () => undefined };
  let store = createPocketReadStateStore(options);
  store.observeCatalog([row], 'source-a');
  const before = projection(store, row), beforeScore = smartThreadScore(before, { now });
  const desktopRead = { ...row, desktopReadContent: content(1) };
  const projectedBeforeEffect = projection(store, desktopRead);
  assert.equal(navigationActivityCounts([projectedBeforeEffect], prefs, '').unread, 0);
  store.observeCatalog([desktopRead], 'source-a');
  store = createPocketReadStateStore(options);
  store.observeCatalog([row], 'source-a');
  const after = projection(store, row);
  assert.equal(navigationActivityCounts([after], prefs, '').unread, 0);
  assert.deepEqual(filterThreads([after], prefs.scope, '', prefs.project, prefs.sort, undefined, { now }, prefs.activity), []);
  assert.equal(threadListStates(after).some(state => state.key === 'unread'), false);
  assert.ok(smartThreadScore(after, { now }) < beforeScore);
  for (const status of ['waiting_input', 'waiting_approval']) {
    assert.equal(needsUserInput(after, status), true);
    assert.equal(threadListStates(after, false, status).some(state => state.key === status), true);
  }
  const incoming = { ...row, pocketContent: content(2), desktopReadContent: content(1), hasUnreadTurn: false };
  store.observeCatalog([incoming]);
  const newReply = projection(store, incoming);
  assert.equal(navigationActivityCounts([newReply], prefs, '').unread, 1);
  assert.equal(threadListStates(newReply).some(state => state.key === 'unread'), true);
});

test('running excludes new content from unread presentation without consuming its reading watermark', () => {
  const store = createPocketReadStateStore({ storage: storageFixture(), machine: () => 'ged', browser: () => undefined });
  store.observeCatalog([row], 'source-a'); store.markSeen(row.id, content(1));
  const incoming = { ...row, pocketContent: content(2), desktopReadContent: content(1), hasUnreadTurn: false, needsInput: false };
  store.observeCatalog([incoming], 'source-a');
  store.observeCatalog([row], 'source-a'); // Late metadata operation response.
  store.markSeen(row.id, content(1)); // Late observation of the old rendered answer.
  const projected = projection(store, incoming);
  const statuses = new Map([[row.id, 'running']]);
  assert.equal(hasUnreadContent(projected, 'running'), false);
  assert.deepEqual(navigationActivityCounts([projected], prefs, '', statuses), { unread: 0, running: 1 });
  assert.equal(filterThreads([projected], 'all', '', 'project', 'smart', statuses, { now }, 'unread').length, 0);
  assert.equal(filterThreads([projected], 'all', '', 'project', 'smart', statuses, { now }, 'running').length, 1);
  assert.deepEqual(threadListStates(projected, false, 'running').map(state => state.key), ['running']);
  assert.equal(needsUserInput(projected, 'running'), false);
  assert.equal(smartThreadScore(projected, { now, runtimeStates: statuses }),
    smartThreadScore({ ...projected, pocketUnread: false }, { now, runtimeStates: statuses }));
  assert.equal(store.unread(incoming), true, 'running is presentation only, not a read receipt');

  statuses.set(row.id, 'idle');
  assert.deepEqual(navigationActivityCounts([projected], prefs, '', statuses), { unread: 1, running: 0 });
  assert.equal(filterThreads([projected], 'all', '', 'project', 'smart', statuses, { now }, 'unread').length, 1);
  assert.deepEqual(threadListStates(projected, false, 'idle').map(state => state.key), ['unread']);
  assert.equal(needsUserInput(projected, 'idle'), true);
});

test('reading during a run stays read on completion but an appended reply becomes unread afterwards', () => {
  const store = createPocketReadStateStore({ storage: storageFixture(), machine: () => 'ged', browser: () => undefined });
  store.observeCatalog([row], 'source-a');
  assert.equal(hasUnreadContent(projection(store, row), 'running'), false);
  store.markSeen(row.id, content(1));
  const read = projection(store, row);
  assert.equal(hasUnreadContent(read, 'idle'), false);
  assert.equal(navigationActivityCounts([read], prefs, '', new Map([[row.id, 'idle']])).unread, 0);
  assert.deepEqual(threadListStates(read, false, 'idle'), []);

  const appended = { ...row, pocketContent: content(2) };
  store.observeCatalog([appended]);
  const unread = projection(store, appended);
  assert.equal(store.unread(appended), true);
  assert.equal(hasUnreadContent(unread, 'running'), false);
  assert.equal(hasUnreadContent(unread, 'idle'), true);
});

test('absent and unknown runtime evidence preserve unread content without inventing a completed state', () => {
  const store = createPocketReadStateStore({ storage: storageFixture(), machine: () => 'ged', browser: () => undefined });
  store.observeCatalog([row], 'source-a');
  for (const status of [undefined, 'unknown']) {
    const projected = projection(store, row);
    const statuses = status ? new Map([[row.id, status]]) : undefined;
    assert.deepEqual(navigationActivityCounts([projected], prefs, '', statuses), { unread: 1, running: 0 });
    assert.equal(filterThreads([projected], 'all', '', 'project', 'smart', statuses, { now }, 'unread').length, 1);
    assert.deepEqual(threadListStates(projected, false, status).map(state => state.key),
      status ? ['unknown', 'unread'] : ['unread']);
    assert.equal(store.unread(row), true);
  }
});

test('reading a question clears unread while preserving pending answer or approval and attention rank', () => {
  for (const status of ['waiting_input', 'waiting_approval']) {
    const unread = { ...row, pocketUnread: true }, read = { ...row, pocketUnread: false };
    const runtimeStates = new Map([[row.id, status]]);
    assert.equal(hasUnreadContent(read, status), false);
    assert.equal(needsUserInput(read, status), true);
    assert.equal(smartThreadScore(read, { now, runtimeStates }), smartThreadScore(unread, { now, runtimeStates }));
    assert.equal(threadListStates(read, false, status).some(state => state.key === status), true);
    assert.equal(threadListStates(read, false, status).some(state => state.key === 'unread'), false);
  }
});

test('scope exclusions override local unread and legacy APIs retain the old fallback', () => {
  for (const flag of ['sourceExcluded', 'missing', 'archived', 'separator']) {
    assert.equal(hasUnreadContent({ ...row, [flag]: true, pocketUnread: true }), false);
    assert.equal(needsUserInput({ ...row, [flag]: true, pocketUnread: true }, 'waiting_input'), false);
  }
  assert.equal(hasUnreadContent(row), true);
  assert.equal(hasUnreadContent({ ...row, hasUnreadTurn: false }), false);
  assert.equal(hasUnreadContent(row, 'running'), false);
});

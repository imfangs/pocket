import test from 'node:test';
import assert from 'node:assert/strict';
import { canAdoptReadingPreview, conversationReadModel } from '../src/conversationReadModel.ts';
import { cachePreviewReadingProtected } from '../src/cachePreviewRead.ts';

const content = (revision, version = 'a', scope = 'scope') => ({ known: true, scope, revision, version: version.repeat(64), messageId: `message-${revision}` });
const source = (revision, checkedAt = 10, extra = {}) => ({ source: 'rollout', checkedAt,
  messages: [{ id: `message-${revision}`, role: 'assistant', turnId: `turn-${revision}`, phase: 'final_answer', text: `Reading version ${revision}` }],
  pocketContent: content(revision), ...extra });
const native = transcript => ({ ...transcript, source: 'desktop', runtime: 'active', canSend: true, canStop: true, activeTurnId: 'old-turn' });
const input = extra => ({ scope: 'ged:scope:thread', readingScope: 'scope', history: null, transcript: null, cachedPreview: null, submitted: [], previewAllowed: true, ...extra });

test('a newer known L1 snapshot replaces old memory text before live observations while raw controls and receipts stay old', () => {
  const old = source(1), cached = source(2, 20, { turnFailures: [{ turnId: 'turn-2', message: 'A readable old failure' }], canSend: true, canStop: true, runtime: 'active' });
  const history = native(old), before = JSON.stringify(history);
  assert.equal(canAdoptReadingPreview(cached, history, old, 'scope'), true);
  const model = conversationReadModel(input({ history, transcript: old, cachedPreview: cached }));
  assert.equal(model.showingDiskPreview, true); assert.equal(model.shownMessages[0].text, 'Reading version 2');
  assert.equal(model.liveDisplay.messages[0].text, 'Reading version 1'); assert.equal(model.canSend, undefined); assert.equal(model.canStop, undefined);
  assert.equal(model.turnFailures[0].turnId, 'turn-2'); assert.equal(JSON.stringify(history), before);
});

test('fresh current-view feed observation always revokes preferred cache rendering', () => {
  const old = source(1), cached = source(2, 20), live = source(3, 30);
  const model = conversationReadModel(input({ history: native(live), transcript: live, cachedPreview: cached, previewAllowed: false }));
  assert.equal(model.showingDiskPreview, false); assert.equal(model.shownMessages[0].text, 'Reading version 3');
  const partial = conversationReadModel(input({ history: native(old), transcript: old, cachedPreview: cached, previewAllowed: false }));
  assert.equal(partial.showingDiskPreview, false);
});

test('wrong scope, unknown versions, older checked time/revision and same-revision conflict cannot displace existing memory', () => {
  const old = source(2, 20), history = native(old);
  for (const cached of [source(3, 30, { pocketContent: content(3, 'a', 'elsewhere') }), source(3, 30, { pocketContent: undefined }),
    source(3, 19), source(1, 30), source(2, 30, { pocketContent: content(2, 'b') }), source(2, 20)])
    assert.equal(canAdoptReadingPreview(cached, history, old, 'scope'), false);
  assert.equal(canAdoptReadingPreview(source(3, 30), { ...history, pocketContent: undefined }, { ...old, pocketContent: undefined }, 'scope'), false);
  assert.equal(canAdoptReadingPreview(source(3, 30), { ...history, checkedAt: NaN }, old, 'scope'), false);
});

test('same complete version can take a later checked reading body, but clocks alone cannot replace unversioned content', () => {
  const old = source(1), same = source(1, 20);
  assert.equal(canAdoptReadingPreview(same, native(old), old, 'scope'), true);
  assert.equal(canAdoptReadingPreview(same, native({ ...old, pocketContent: undefined }), null, 'scope'), false);
});

test('equal checked metadata may hand through an exact known newer recorded body that the old native merge hid', () => {
  const old = source(1), saved = source(2, 20), cached = source(2, 20);
  const history = native(old);
  assert.equal(conversationReadModel(input({ history, transcript: saved })).shownMessages[0].text, 'Reading version 1');
  assert.equal(canAdoptReadingPreview(cached, history, saved, 'scope'), true);
  assert.equal(conversationReadModel(input({ history, transcript: saved, cachedPreview: cached })).shownMessages[0].text, 'Reading version 2');
  assert.equal(canAdoptReadingPreview({ ...cached, messages: [{ ...cached.messages[0], text: 'Unproven replacement' }] }, history, saved, 'scope'), false);
});

test('first cache-only content remains readable and cannot manufacture a native activity snapshot', () => {
  const cached = source(1, 20), model = conversationReadModel(input({ cachedPreview: cached }));
  assert.equal(canAdoptReadingPreview(cached, null, null, 'scope'), true);
  assert.equal(model.showingDiskPreview, true); assert.deepEqual(model.liveDisplay.messages, []); assert.equal(model.runtime, undefined);
});

test('initial inspector entry permits the cache body, but established motion, selection and editor interest do not', () => {
  let entering = true, selection = false, portal = false, motions = 1;
  const doc = { hidden: false, activeElement: null, getSelection: () => ({ isCollapsed: !selection, rangeCount: selection ? 1 : 0,
    getRangeAt: () => ({ intersectsNode: () => true }) }), querySelector: () => portal ? {} : null,
    querySelectorAll: () => Array.from({ length: motions }, () => ({})) };
  const root = { ownerDocument: doc, contains: () => false }, conversation = { ownerDocument: doc, contains: () => true, closest: () => entering ? {} : null };
  assert.equal(cachePreviewReadingProtected(root, conversation), false);
  entering = false; assert.equal(cachePreviewReadingProtected(root, conversation), true);
  entering = true; selection = true; assert.equal(cachePreviewReadingProtected(root, conversation), true);
  selection = false; doc.activeElement = { matches: () => true }; assert.equal(cachePreviewReadingProtected(root, conversation), true);
  doc.activeElement = null; portal = true; assert.equal(cachePreviewReadingProtected(root, conversation), true);
  portal = false; motions = 2; assert.equal(cachePreviewReadingProtected(root, conversation), true);
  motions = 0; assert.equal(cachePreviewReadingProtected(root, conversation), false);
});

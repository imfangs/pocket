import test from 'node:test';
import assert from 'node:assert/strict';
import { pocketPriority, codexPinned, hasPriorityState, priorityFields } from '../src/priority.ts';
import { smartThreadScore } from '../src/smartOrder.ts';
import { filterThreads } from '../src/model.ts';
import { preserveNewerThreadMetadata } from '../src/threadMetadata.ts';

const base = { id:'one', title:'会话', pinned:false, pinnedOrder:-1, pinSource:'codex', pinRevision:5,
  codexPinned:false, pocketPriority:false, createdAt:0, updatedAt:0, lastMessageAt:null, archived:false, missing:false, separator:false };
const catalog = threads => ({threads,groups:[],projects:[],sourceInfo:null,sourceError:null});

test('Pocket priority adds the same independent weight whether Codex is pinned or not', () => {
  for (const c of [false,true]) for (const p of [false,true]) {
    const thread={...base,codexPinned:c,pocketPriority:p};
    assert.equal(smartThreadScore(thread,{now:100000}),Number(c)*60+Number(p)*90);
    assert.equal(codexPinned(thread),c);assert.equal(pocketPriority(thread),p);
    assert.equal(hasPriorityState(thread),true);
  }
});

test('a former false override no longer hides the separately reported Codex pin or its weight', () => {
  const oldOverride={...base,pinned:false,pinSource:'pocket',codexPinned:true,pocketPriority:false};
  assert.equal(smartThreadScore(oldOverride,{now:100000}),60);
  assert.equal(filterThreads([oldOverride],'pinned','','','smart').length,1);
  const focused={...oldOverride,pocketPriority:true};
  assert.equal(smartThreadScore(focused,{now:100000})-smartThreadScore(oldOverride,{now:100000}),90);
});

test('legacy snapshots remain readable but cannot authorize the new independent write', () => {
  const {codexPinned: c,pocketPriority:p,...legacy}=base;
  for (const pinSource of ['codex','pocket']) {
    const row={...legacy,pinned:true,pinSource};
    assert.equal(hasPriorityState(row),false);
    assert.equal(pocketPriority(row),pinSource==='pocket');
    assert.equal(codexPinned(row),pinSource==='codex');
  }
});

test('late responses preserve both independent fields and their revision while accepting unrelated edits', () => {
  const known={...base,codexPinned:true,pocketPriority:true,pinned:true,pinSource:'pocket',pinRevision:7};
  const incoming={...base,pinRevision:6,note:'new note'};
  const actual=preserveNewerThreadMetadata(catalog([known]),catalog([incoming])).threads[0];
  assert.deepEqual(priorityFields(actual),priorityFields(known));
  assert.equal(actual.note,'new note');
});

test('partial and old-client payloads cannot attach a new revision to old independent values', () => {
  const known={...base,codexPinned:true,pocketPriority:true,pinRevision:7};
  for (const revision of [undefined,7,8]) for (const absent of ['codexPinned','pocketPriority']) {
    const incoming={...base,pinRevision:revision,note:'saved'};delete incoming[absent];
    const actual=preserveNewerThreadMetadata(catalog([known]),catalog([incoming])).threads[0];
    assert.deepEqual(priorityFields(actual),priorityFields(known));assert.equal(actual.note,'saved');
  }
  const fresh=catalog([{...base,codexPinned:true,pocketPriority:false,pinRevision:8}]);
  assert.equal(preserveNewerThreadMetadata(catalog([known]),fresh),fresh);
});

test('a newer legacy generation cannot combine with older complete fields into a forged projection', () => {
  const {codexPinned:c,pocketPriority:p,...legacy}={...base,pinned:true,pinSource:'pocket',pinRevision:8};
  const actual=preserveNewerThreadMetadata(catalog([legacy]),catalog([base])).threads[0];
  assert.equal(actual.pinRevision,8);assert.equal(hasPriorityState(actual),false);
  assert.equal(Object.hasOwn(actual,'codexPinned'),false);
});

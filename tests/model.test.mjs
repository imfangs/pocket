import test from "node:test";
import assert from "node:assert/strict";
import { filterThreads } from "../src/model.ts";
const t = {
  id: "a",
  title: "药草铺",
  note: "下次验证 背包体验",
  cwd: "/demo",
  projectName: "side",
  projectId: "p",
  archived: false,
  separator: false,
  pinned: true,
  pinnedOrder: 1,
  updatedAt: 1,
  intent: "later",
  groupIds: ["child"],
  lastOpenedAt: 2,
};
test("pinned view honors recent activity and can switch back to native pin order", () => {
  const older = { ...t, id: "older", pinnedOrder: 0, updatedAt: 10 };
  const newer = { ...t, id: "newer", pinnedOrder: 1, updatedAt: 20 };
  const list = (sort) =>
    filterThreads(
      [older, newer],
      "pinned",
      "",
      "",
      sort,
    ).map((x) => x.id);
  assert.deepEqual(list("updated"), ["newer", "older"]);
  assert.deepEqual(list("pinned"), ["older", "newer"]);
});
test("Chinese multi-term search uses visible title and source paths while preserving original identity", () => {
  assert.equal(filterThreads([t], "all", "药草 demo", "", "updated")[0].id, "a");
  assert.equal(filterThreads([t], "all", "没有此词", "", "updated").length, 0);
  assert.equal(filterThreads([t], "all", "child", "", "updated").length, 0);
  assert.equal(filterThreads([t], "all", "背包", "", "updated").length, 0);
});
test("archival preserves later-task metadata while listing it only in the archive view", () => {
  const archived = { ...t, archived: true };
  assert.equal(
    filterThreads([archived], "all", "", "", "updated")
      .length,
    0,
  );
  assert.equal(
    filterThreads([archived], "recent", "", "", "updated")
      .length,
    0,
  );
  assert.equal(
    filterThreads(
      [archived],
      "archived",
      "",
      "",
      "updated",
    ).length,
    1,
  );
  const found = filterThreads([archived], "archived", "", "", "updated")[0];
  assert.equal(found.intent, t.intent);
  assert.equal(found.note, t.note);
  assert.deepEqual(found.groupIds, t.groupIds);
});
test('waiting-for-input view includes only available ended unread tasks, not ordinary idle or archived tasks',()=>{
 const items=[{...t,id:'unread',hasUnreadTurn:true,needsInput:true},{...t,id:'read',needsInput:false},{...t,id:'running',hasUnreadTurn:true,needsInput:false},{...t,id:'archived',needsInput:true,archived:true},{...t,id:'missing',needsInput:true,missing:true}];
 assert.deepEqual(filterThreads(items,'unread','','','updated').map(t=>t.id),['unread']);
});
test('retired title and review sort preferences fall back to recent activity',()=>{
 const items=[{...t,id:'old',title:'A',updatedAt:1,reviewAt:'2020-01-01'},{...t,id:'new',title:'Z',updatedAt:2,reviewAt:null}];
 for(const sort of ['title','review'])assert.equal(filterThreads(items,'all','','',sort)[0].id,'new');
});
test('waiting views and smart ranking use the same fresh attention signals',()=>{
 const items=[{...t,id:'unread',needsInput:true},{...t,id:'executing',needsInput:true},
  {...t,id:'question',needsInput:false},{...t,id:'approval',needsInput:false}];
 const states=new Map([['executing','running'],['question','waiting_input'],['approval','waiting_approval']]);
 assert.deepEqual(filterThreads(items,'unread','','','updated',states).map(t=>t.id),['unread','question','approval']);
});
test('unassigned project scope and archived chronology do not inherit unrelated smart priorities',()=>{
 const now=2000000000000;
 const items=[{...t,id:'independent',projectId:null,pinned:false,createdAt:now-1000,updatedAt:now-1000},
  {...t,id:'assigned',pinned:true,pinSource:'pocket',createdAt:now-10000,updatedAt:now-10000}];
 assert.deepEqual(filterThreads(items,'all','','__unassigned__','smart',undefined,{now}).map(t=>t.id),['independent']);
 assert.deepEqual(filterThreads(items.map(t=>({...t,archived:true})),'archived','','','smart',undefined,{now}).map(t=>t.id),['independent','assigned']);
});
test('search retains Unicode matching and no longer includes hidden group metadata', () => {
  const items = [{ ...t, title: 'ＡＢＣ', id: 'first', updatedAt: 10 }, { ...t, id: 'second', updatedAt: 20 }];
  const search = query => filterThreads(items, 'all', query, '', 'updated').map(t => t.id);
  assert.deepEqual(search('  '), ['second', 'first']);
  assert.deepEqual(search('abc side'), ['first']);
  assert.deepEqual(search('child'), []);
  assert.deepEqual(search('side demo'), ['second', 'first']);
});

test('running view includes only confirmed execution and always excludes unavailable or separator tasks', () => {
  const items = [
    { ...t, id: 'executing', intent: 'none', needsInput: false },
    { ...t, id: 'manual-active', intent: 'active' },
    { ...t, id: 'waiting-input' }, { ...t, id: 'waiting-approval' },
    { ...t, id: 'unknown' }, { ...t, id: 'not-observed' },
    { ...t, id: 'archived', archived: true },
    { ...t, id: 'missing', missing: true },
    { ...t, id: 'separator', separator: true },
  ];
  const states = new Map([
    ['executing', 'running'], ['manual-active', 'idle'],
    ['waiting-input', 'waiting_input'], ['waiting-approval', 'waiting_approval'], ['unknown', 'unknown'],
    ['archived', 'running'], ['missing', 'running'], ['separator', 'running'],
  ]);
  assert.deepEqual(filterThreads(items, 'running', '', '', 'updated', states).map(row => row.id), ['executing']);
  assert.ok(filterThreads(items, 'all', '', '', 'updated', states).some(row => row.id === 'separator'));
});

test('running counts and lists share the same project and normalized multi-term search scope', () => {
  const items = [
    { ...t, id: 'scoped', title: 'ＡＢＣ', projectId: 'p' },
    { ...t, id: 'another-project', title: 'ＡＢＣ', projectId: 'other' },
    { ...t, id: 'another-query', title: 'Different', projectId: 'p' },
    { ...t, id: 'waiting', title: 'ＡＢＣ', projectId: 'p' },
  ];
  const states = new Map(items.map(item => [item.id, item.id === 'waiting' ? 'waiting_input' : 'running']));
  const result = filterThreads(items, 'running', 'abc side', 'p', 'updated', states);
  assert.deepEqual(result.map(row => row.id), ['scoped']);
  assert.equal(result.length, 1);
  assert.equal(filterThreads(items, 'running', 'abc side', '', 'updated', states).length, 2);
  assert.equal(filterThreads(items, 'running', '', 'p', 'updated', states).length, 2);
});

test('running filtering retains recent and native pin ordering without modifying persisted threads or runtime observations', () => {
  const older = Object.freeze({ ...t, id: 'older', pinnedOrder: 0, updatedAt: 10 });
  const pinned = Object.freeze({ ...t, id: 'pinned', pinnedOrder: 1, updatedAt: 20 });
  const newer = Object.freeze({ ...t, id: 'newer', pinned: false, updatedAt: 30 });
  const items = Object.freeze([older, newer, pinned]);
  const states = new Map(items.map(item => [item.id, 'running'])), before = [...states];
  const list = sort => filterThreads(items, 'running', '', '', sort, states);
  assert.deepEqual(list('updated').map(row => row.id), ['newer', 'pinned', 'older']);
  assert.deepEqual(list('pinned').map(row => row.id), ['older', 'pinned', 'newer']);
  assert.equal(list('pinned')[0], older);
  assert.deepEqual(items.map(row => row.id), ['older', 'newer', 'pinned']);
  assert.deepEqual([...states], before);
  assert.equal('runtime' in older, false);assert.equal(older.intent, 'later');
});

test('missing or withdrawn runtime evidence removes running results without inferring idle or changing ordinary views', () => {
  const items = [{ ...t, id: 'one', intent: 'active' }];
  const list = states => filterThreads(items, 'running', '', '', 'updated', states);
  assert.equal(list(new Map([['one', 'running']])).length, 1);
  for (const states of [undefined, new Map(), new Map([['one', 'unknown']]), new Map([['one', 'waiting_input']])])
    assert.deepEqual(list(states), []);
  assert.equal(filterThreads(items, 'all', '', '', 'updated')[0], items[0]);
  assert.equal('runtime' in items[0], false);
});

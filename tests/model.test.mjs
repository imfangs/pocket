import test from "node:test";
import assert from "node:assert/strict";
import { filterThreads, groupPath, descendantIds } from "../src/model.ts";
const groups = [
  { id: "parent", name: "领域", parentId: null },
  { id: "child", name: "游戏", parentId: "parent" },
];
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
      groups,
      "pinned",
      null,
      "",
      "",
      false,
      sort,
    ).map((x) => x.id);
  assert.deepEqual(list("updated"), ["newer", "older"]);
  assert.deepEqual(list("pinned"), ["older", "newer"]);
});
test("hierarchical grouping and Chinese multi-term search preserve one original identity", () => {
  assert.equal(groupPath(groups, "child"), "领域 / 游戏");
  assert.deepEqual([...descendantIds(groups, "parent")], ["parent", "child"]);
  assert.equal(
    filterThreads(
      [t],
      groups,
      "group",
      "parent",
      "游戏 背包",
      "",
      false,
      "updated",
    )[0].id,
    "a",
  );
  assert.equal(
    filterThreads(
      [t],
      groups,
      "group",
      "parent",
      "没有此词",
      "",
      false,
      "updated",
    ).length,
    0,
  );
});
test("archival preserves later-task metadata while listing it only in the archive view", () => {
  const archived = { ...t, archived: true };
  assert.equal(
    filterThreads([archived], groups, "all", null, "", "", false, "updated")
      .length,
    0,
  );
  assert.equal(
    filterThreads([archived], groups, "later", null, "", "", false, "updated")
      .length,
    0,
  );
  assert.equal(
    filterThreads(
      [archived],
      groups,
      "archived",
      null,
      "",
      "",
      false,
      "updated",
    ).length,
    1,
  );
  const found = filterThreads([archived], groups, "archived", null, "", "", false, "updated")[0];
  assert.equal(found.intent, t.intent);
  assert.equal(found.note, t.note);
  assert.deepEqual(found.groupIds, t.groupIds);
});
test('waiting-for-input view includes only available ended unread tasks, not ordinary idle or archived tasks',()=>{
 const items=[{...t,id:'unread',hasUnreadTurn:true,needsInput:true},{...t,id:'read',needsInput:false},{...t,id:'running',hasUnreadTurn:true,needsInput:false},{...t,id:'archived',needsInput:true,archived:true},{...t,id:'missing',needsInput:true,missing:true}];
 assert.deepEqual(filterThreads(items,groups,'unread',null,'','',false,'updated').map(t=>t.id),['unread']);
});
test('retired title and review sort preferences fall back to recent activity',()=>{
 const items=[{...t,id:'old',title:'A',updatedAt:1,reviewAt:'2020-01-01'},{...t,id:'new',title:'Z',updatedAt:2,reviewAt:null}];
 for(const sort of ['title','review'])assert.equal(filterThreads(items,groups,'all',null,'','',false,sort)[0].id,'new');
});
test('search keeps Unicode matching and sees renamed group paths on the next catalog', () => {
  const items = [{ ...t, title: 'ＡＢＣ', id: 'first', updatedAt: 10 }, { ...t, id: 'second', updatedAt: 20 }];
  const search = (groups, query) => filterThreads(items, groups, 'all', null, query, '', false, 'updated').map(t => t.id);
  assert.deepEqual(search(groups, '  '), ['second', 'first']);
  assert.deepEqual(search(groups, 'abc 游戏'), ['first']);
  const renamed = groups.map(g => g.id === 'child' ? { ...g, name: '阅读' } : g);
  assert.deepEqual(search(renamed, '游戏'), []);
  assert.deepEqual(search(renamed, '领域 阅读'), ['second', 'first']);
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
  for (const showSeparators of [false, true])
    assert.deepEqual(filterThreads(items, groups, 'running', null, '', '', showSeparators, 'updated', states).map(row => row.id), ['executing']);
  assert.deepEqual(filterThreads(items, groups, 'active', null, '', '', false, 'updated', states).map(row => row.id), ['manual-active']);
});

test('running counts and lists share the same project and normalized multi-term search scope', () => {
  const items = [
    { ...t, id: 'scoped', title: 'ＡＢＣ', projectId: 'p' },
    { ...t, id: 'another-project', title: 'ＡＢＣ', projectId: 'other' },
    { ...t, id: 'another-query', title: 'Different', projectId: 'p' },
    { ...t, id: 'waiting', title: 'ＡＢＣ', projectId: 'p' },
  ];
  const states = new Map(items.map(item => [item.id, item.id === 'waiting' ? 'waiting_input' : 'running']));
  const result = filterThreads(items, groups, 'running', null, 'abc 游戏', 'p', false, 'updated', states);
  assert.deepEqual(result.map(row => row.id), ['scoped']);
  assert.equal(result.length, 1);
  assert.equal(filterThreads(items, groups, 'running', null, 'abc 游戏', '', false, 'updated', states).length, 2);
  assert.equal(filterThreads(items, groups, 'running', null, '', 'p', false, 'updated', states).length, 2);
});

test('running filtering retains recent and native pin ordering without modifying persisted threads or runtime observations', () => {
  const older = Object.freeze({ ...t, id: 'older', pinnedOrder: 0, updatedAt: 10 });
  const pinned = Object.freeze({ ...t, id: 'pinned', pinnedOrder: 1, updatedAt: 20 });
  const newer = Object.freeze({ ...t, id: 'newer', pinned: false, updatedAt: 30 });
  const items = Object.freeze([older, newer, pinned]);
  const states = new Map(items.map(item => [item.id, 'running'])), before = [...states];
  const list = sort => filterThreads(items, groups, 'running', null, '', '', false, sort, states);
  assert.deepEqual(list('updated').map(row => row.id), ['newer', 'pinned', 'older']);
  assert.deepEqual(list('pinned').map(row => row.id), ['older', 'pinned', 'newer']);
  assert.equal(list('pinned')[0], older);
  assert.deepEqual(items.map(row => row.id), ['older', 'newer', 'pinned']);
  assert.deepEqual([...states], before);
  assert.equal('runtime' in older, false);assert.equal(older.intent, 'later');
});

test('missing or withdrawn runtime evidence removes running results without inferring idle or changing ordinary views', () => {
  const items = [{ ...t, id: 'one', intent: 'active' }];
  const list = states => filterThreads(items, groups, 'running', null, '', '', false, 'updated', states);
  assert.equal(list(new Map([['one', 'running']])).length, 1);
  for (const states of [undefined, new Map(), new Map([['one', 'unknown']]), new Map([['one', 'waiting_input']])])
    assert.deepEqual(list(states), []);
  assert.equal(filterThreads(items, groups, 'all', null, '', '', false, 'updated')[0], items[0]);
  assert.equal(filterThreads(items, groups, 'active', null, '', '', false, 'updated')[0], items[0]);
  assert.equal('runtime' in items[0], false);
});

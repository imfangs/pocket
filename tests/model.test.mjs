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
test("an intentionally saved later task stays discoverable after original archival", () => {
  const archived = { ...t, archived: true };
  assert.equal(
    filterThreads([archived], groups, "all", null, "", "", false, "updated")
      .length,
    0,
  );
  assert.equal(
    filterThreads([archived], groups, "later", null, "", "", false, "updated")
      .length,
    1,
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
});

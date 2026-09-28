import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("..", import.meta.url)),
  esbuild: { jsx: "automatic" },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
  appType: "custom",
});
after(() => vite.close());


const { default: MessageMarkdown } = await vite.ssrLoadModule("/src/MessageMarkdown.tsx");
const render = (text) => renderToStaticMarkup(createElement(MessageMarkdown, { text }));

test("conversation Markdown renders GFM structure and readable code without executing it", () => {
  const html = render([
    "## 计划", "", "**重点**与*强调*，~~删除~~和 `inline()`。", "",
    "- 第一项", "- [x] 已完成", "", "> 引用", "",
    "| 名称 | 状态 |", "| --- | --- |", "| 发布 | 完成 |", "",
    "```js", "const value = '<script>not executable</script>';", "```",
  ].join("\n"));
  for (const expected of ["<h2>计划</h2>", "<strong>重点</strong>", "<em>强调</em>",
    "<del>删除</del>", "<code>inline()</code>", "<blockquote>", "<table>",
    "<th>名称</th>", "type=\"checkbox\"", "disabled=\"\"", "class=\"language-js\"",
    "&lt;script&gt;not executable&lt;/script&gt;"])
    assert.ok(html.includes(expected), `Missing rendered structure: ${expected}`);
  assert.equal(html.includes("<script>"), false);
});

test("conversation Markdown omits raw HTML and unsafe or Mac-local navigation", () => {
  const html = render([
    "<script>window.bad = true</script>", "",
    '<iframe src="https://example.com/private"></iframe>', "",
    "[unsafe](javascript:alert%281%29)", "",
    "[data](data:text/html,hello)", "",
    "[本机文件](/Users/example/private.md)", "",
    "[正文](https://example.com/article)",
  ].join("\n"));
  assert.doesNotMatch(html, /<script|<iframe|javascript:|data:text|href="\/Users/);
  assert.ok(html.includes('href="https://example.com/article"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes("本机文件"));
});

test("conversation image Markdown offers a link without requesting the image", () => {
  const html = render("![架构图](https://example.com/diagram.png)\n\n![本地图](/private/image.png)");
  assert.doesNotMatch(html, /<img|<link|src=/);
  assert.ok(html.includes('href="https://example.com/diagram.png"'));
  assert.ok(html.includes("查看图片"));
  assert.ok(html.includes("本地图"));
});

test("turn elapsed rendering handles hours, frozen completion and missing times", async () => {
  const { default: TurnDuration, elapsedDuration, formatDuration } = await vite.ssrLoadModule("/src/TurnDuration.tsx");
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(3599999), "59:59");
  assert.equal(formatDuration(3661000), "1:01:01");
  const timing = { turnId: "a", status: "inProgress", startedAt: 1000, observedAt: 9000, durationMs: null };
  assert.equal(elapsedDuration(timing, 2000), 10000);
  assert.equal(elapsedDuration({ ...timing, status: "completed", durationMs: 1234 }, 99999), 1234);
  assert.equal(elapsedDuration({ ...timing, startedAt: null }), null);
  assert.match(renderToStaticMarkup(createElement(TurnDuration, { timing, live: false })), /已记录/);
  assert.equal(renderToStaticMarkup(createElement(TurnDuration, { timing: { ...timing, status: "completed" }, live: false })), "");
});

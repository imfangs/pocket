import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fromMarkdown } from "mdast-util-from-markdown";
import { createServer } from "vite";

const vite = await createServer({ configFile: false, esbuild: { jsx: "automatic" }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: "custom" });
after(() => vite.close());
const { closedMermaidFence } = await vite.ssrLoadModule("/src/mermaidMarkdown.ts");
const { default: MessageMarkdown } = await vite.ssrLoadModule("/src/MessageMarkdown.tsx");
const { renderMermaid } = await vite.ssrLoadModule("/src/mermaidRender.ts");
const { DIAGRAM_LIMITS, validDiagramResult, diagramDataUrl } = await vite.ssrLoadModule("/src/mermaidPolicy.ts");
const { createDiagramRenderer } = await vite.ssrLoadModule("/src/mermaidRenderer.ts");
const { readableDiagramTransform } = await vite.ssrLoadModule("/src/imageViewerGestures.ts");
const collect = node => node.type === "code" ? [node] : (node.children ?? []).flatMap(collect);

test("long diagrams open at reading width from the top instead of shrinking all labels", () => {
  assert.deepEqual(readableDiagramTransform({ width: 320, height: 640, imageWidth: 160, imageHeight: 640, centerX: 0, centerY: 0 }), { scale: 2, x: 0, y: 320 });
  assert.deepEqual(readableDiagramTransform({ width: 320, height: 640, imageWidth: 320, imageHeight: 100, centerX: 0, centerY: 0 }), { scale: 1, x: 0, y: 0 });
});

test("only parser-consumed matching Mermaid closers render, including containers and line endings", () => {
  for (const source of ["```mermaid\nA-->B\n```", "~~~~mermaid\nA-->B\n~~~~~", "> ```mermaid\n> A-->B\n> ```", "- ```mermaid\n  A-->B\n  ```", "```mermaid\rA-->B\r```", "```mermaid\r\nA-->B\r\n```", "```mermaid\n\n```", "```mermaid\n```", "  ```mermaid\n  A-->B\n  ```"]) {
    assert.equal(closedMermaidFence(collect(fromMarkdown(source))[0], source), true, source);
  }
  for (const source of ["```mermaid\nA-->B", "```mermaid\nA-->B\n", "```mermaid\nA-->B\n> ```", "```mermaid\nA-->B\n>> ```", "```mermaid\nA-->B\n    ```", "````mermaid\nA-->B\n```", "```mermaid\nA-->B\n~~~", "```js\nA-->B\n```", "    A-->B"]) {
    assert.equal(closedMermaidFence(collect(fromMarkdown(source))[0], source), false, source);
  }
});

test("Markdown keeps Mermaid source readable before hydration and regular code unchanged", () => {
  const render = source => renderToStaticMarkup(createElement(MessageMarkdown, { text: source }));
  assert.match(render("```mermaid\nflowchart LR\nA-->B\n```"), /data-diagram-state="deferred"/);
  assert.match(render("```mermaid\nflowchart LR\nA-->B"), /data-diagram-state="incomplete"/);
  assert.match(render("```mermaid\nA[&lt;script&gt;]\n```"), /复制图表源码/);
  assert.doesNotMatch(render("```js\nconst mermaid = true;\n```"), /mermaid-block|图表源码/);
  assert.doesNotMatch(render("`mermaid`"), /mermaid-block/);
});

for (const name of ["flow", "sequence", "state"]) test(`the exact renderer draws Chinese ${name} and returns a self-contained themed inert image`, async () => {
  const source = await readFile(new URL(`./fixtures/mermaid/chinese-${name}.mmd`, import.meta.url), "utf8");
  let rendering = 0;
  const result = await renderMermaid(source, 320, () => rendering++);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(rendering, 1); assert.equal(validDiagramResult(result), true);
  assert.match(result.svg, /<tspan/);
  assert.doesNotMatch(result.svg, /<script\b|<foreignObject\b|<image\b|\son\w+=|<a\b/i);
  const light = decodeURIComponent(diagramDataUrl(result.svg, false).split(",").slice(1).join(","));
  const dark = decodeURIComponent(diagramDataUrl(result.svg, true).split(",").slice(1).join(","));
  assert.match(light, /--pele-bg:#fafaf8/); assert.match(dark, /--pele-bg:#20201f/);
  assert.match(dark, /<style>svg\{/); assert.equal(source, await readFile(new URL(`./fixtures/mermaid/chinese-${name}.mmd`, import.meta.url), "utf8"));
});

test("unsupported, unfinished syntax and oversized diagrams return source-fallback reasons", async () => {
  assert.deepEqual(await renderMermaid("pie\n\"A\" : 1", 320, () => {}), { ok: false, reason: "unsupported" });
  assert.equal((await renderMermaid("flowchart LR\nA[", 320, () => {})).ok, false);
  assert.deepEqual(await renderMermaid("flowchart LR\n" + "x".repeat(DIAGRAM_LIMITS.source), 320, () => { throw Error("must not render"); }), { ok: false, reason: "limit" });
  assert.deepEqual(await renderMermaid("flowchart LR\n" + "\n".repeat(300), 320, () => {}), { ok: false, reason: "limit" });
  for (const ending of ["\r", "\r\n"]) assert.deepEqual(await renderMermaid("flowchart LR" + ending.repeat(300), 320, () => {}), { ok: false, reason: "limit" });
  const ids = Array.from({ length: 20 }, (_, i) => `N${i}`).join(" & ");
  assert.deepEqual(await renderMermaid(`flowchart LR\n${ids} --> ${ids}`, 320, () => {}), { ok: false, reason: "limit" });
  for (const dimensions of [[NaN, 20], [100, Infinity], [0, 100], [9000, 100], [8000, 8000]]) {
    assert.equal(validDiagramResult({ ok: true, svg: "<svg />", width: dimensions[0], height: dimensions[1] }), false);
  }
});

test("diagram directives cannot enable links, callbacks or external pictures", async () => {
  const sources = [
    'flowchart LR\nA[开始]-->B[完成]\nclick A "javascript:alert(1)"\nclick B "https://external.invalid/"',
    'flowchart LR\nA["<img src=\'https://external.invalid/pixel\' onerror=\'alert(1)\'>"] --> B[完成]',
    'flowchart LR\nA["</text><script>alert(1)</script><text>"]',
    '%%{init: {"securityLevel":"loose","themeCSS":"@import url(https://external.invalid/css)"}}%%\nflowchart LR\nA-->B',
    'flowchart LR\nA@{ img: "https://external.invalid/image.png", label: "图片" } --> B[结束]',
  ];
  for (const source of sources) {
    const result = await renderMermaid(source, 320, () => {});
    if (result.ok) assert.doesNotMatch(result.svg, /<script\b|<foreignObject\b|<image\b|<a\b|\son\w+=|(?:href|src)\s*=\s*["'](?:https?:|javascript:)|@import/i, source);
  }
});

class FakeWorker {
  onmessage = null; onerror = null; calls = []; stopped = false;
  postMessage(message) { this.calls.push(message); }
  terminate() { this.stopped = true; }
  reply(result, id = this.calls.at(-1).id) { this.onmessage?.({ data: { id, result } }); }
  phase() { this.onmessage?.({ data: { id: this.calls.at(-1).id, phase: "rendering" } }); }
}
const good = { ok: true, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>', width: 10, height: 10 };
function setup(t, timers) {
  const workers = [];
  const renderer = createDiagramRenderer(() => { const worker = new FakeWorker(); workers.push(worker); return worker; }, timers);
  t.after(() => renderer.clear()); return { ...renderer, workers };
}
test("renderer deduplicates equal requests, caches by width and bounds its cache", async t => {
  const r = setup(t); const first = r.render("flowchart LR\nA-->B", 320, new AbortController().signal);
  const second = r.render("flowchart LR\nA-->B", 320, new AbortController().signal);
  assert.equal(r.workers[0].calls.length, 1); r.workers[0].reply(good);
  assert.deepEqual(await first, good); assert.deepEqual(await second, good);
  await r.render("flowchart LR\nA-->B", 320, new AbortController().signal);
  assert.equal(r.workers[0].calls.length, 1);
  for (let i = 0; i < 25; i++) { const job = r.render(`source-${i}`, 320, new AbortController().signal); r.workers[0].reply(good); await job; }
  const evicted = r.render("flowchart LR\nA-->B", 320, new AbortController().signal);
  assert.equal(r.workers[0].calls.length, 27); r.workers[0].reply(good); await evicted;
  const resized = r.render("flowchart LR\nA-->B", 720, new AbortController().signal);
  assert.equal(r.workers[0].calls.length, 28); r.workers[0].reply(good); await resized;
});
test("cancelling the final subscriber terminates work; stale workers cannot overwrite the next diagram", async t => {
  const r = setup(t); const controller = new AbortController();
  const first = r.render("first", 320, controller.signal);
  const rejected = assert.rejects(first, { name: "AbortError" }); controller.abort(); await rejected;
  assert.equal(r.workers[0].stopped, true);
  const next = r.render("next", 320, new AbortController().signal);
  r.workers[0].onerror({ preventDefault() {} }); assert.equal(r.workers[1].stopped, false);
  r.workers[0].reply(good); r.workers[1].reply(good); assert.deepEqual(await next, good);
});
test("a cancelled shared subscriber does not kill remaining work", async t => {
  const r = setup(t), controller = new AbortController();
  const first = r.render("shared", 320, controller.signal), second = r.render("shared", 320, new AbortController().signal);
  const rejected = assert.rejects(first, { name: "AbortError" }); controller.abort(); await rejected;
  assert.equal(r.workers[0].stopped, false); r.workers[0].reply(good); assert.deepEqual(await second, good);
});
test("CPU timeout terminates worker, preserves fallback and permits explicit retry", async t => {
  const r = setup(t, { loadingMs: 500, renderingMs: 10, idleMs: 500 });
  const first = r.render("slow", 320, new AbortController().signal); r.workers[0].phase();
  assert.deepEqual(await first, { ok: false, reason: "timeout" }); assert.equal(r.workers[0].stopped, true);
  assert.deepEqual(await r.render("slow", 320, new AbortController().signal), { ok: false, reason: "timeout" });
  const retry = r.render("slow", 320, new AbortController().signal, true); r.workers[1].reply(good); assert.deepEqual(await retry, good);
});
test("scope clear cancels queued work and releases cached private diagrams", async t => {
  const r = setup(t); const first = r.render("one", 320, new AbortController().signal), second = r.render("two", 320, new AbortController().signal);
  r.clear(); assert.equal(r.workers[0].stopped, true);
  assert.deepEqual(await first, { ok: false, reason: "unavailable" }); assert.deepEqual(await second, { ok: false, reason: "unavailable" });
  const next = r.render("one", 320, new AbortController().signal); assert.equal(r.workers.length, 2); r.workers[1].reply(good); await next;
});

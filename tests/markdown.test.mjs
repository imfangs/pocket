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
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
after(() => vite.close());


const { default: MessageMarkdown } = await vite.ssrLoadModule("/src/MessageMarkdown.tsx");
const render = (text) => renderToStaticMarkup(createElement(MessageMarkdown, { text }));

test('Codex memory metadata is hidden without swallowing adjacent prose', () => {
 const html=render('正文。\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:10-12|note=[private provenance]\n</citation_entries>\n<rollout_ids>\n11111111-1111-7111-8111-111111111111\n</rollout_ids>\n</oai-mem-citation>\n\n后文。');
 assert.doesNotMatch(html,/citation_entries|rollout_ids|private provenance|MEMORY.md/);
 assert.match(html,/正文/);assert.match(html,/后文/);
});
test('Codex created task directives become Pocket navigation', () => {
 const html=render('已创建。\n\n::created-thread{threadId="aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"}');
 assert.doesNotMatch(html,/::created-thread|threadId=/);
 assert.match(html,/href="\/?\?task=aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"/);
});
test('Codex display adapters keep code, user text and safe link boundaries', async () => {
 const directive='::created-thread{threadId="aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"}';
 const code=render('`'+directive+'`\n\n```xml\n<oai-mem-citation>example</oai-mem-citation>\n```');
 assert.match(code,/::created-thread/);assert.match(code,/example/);assert.doesNotMatch(code,/href=/);
 const user=renderToStaticMarkup(createElement(MessageMarkdown,{text:directive,codex:false}));
 assert.match(user,/::created-thread/);
 const links=render('[任务](codex://threads/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa)\n\n[错误](codex://threads/../../etc)');
 assert.match(links,/href="\/\?task=aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa"/);assert.doesNotMatch(links,/href="codex:|href=".*etc/);
 const {readableCodexMarkdown}=await vite.ssrLoadModule('/src/codexMarkup.ts');
 assert.equal(readableCodexMarkdown('正文\n<oai-mem-citation>\n<citation_entries>\ntruncated'),'正文\n');
 assert.equal(readableCodexMarkdown('正文\n&lt;oai-mem-citation&gt;secret&lt;/oai-mem-citation&gt;'),'正文\n');
 assert.equal(readableCodexMarkdown('未知 ::my-directive{x="1"}'),'未知 ::my-directive{x="1"}');
});
test('Codex comments, followups and references are readable and never executable', () => {
 const html=render([
  '::code-comment{title="[P1] 检查边界" body="请检查数组长度。" file="/fixture/app.ts" start=12}',
  '- :codex-followup[继续检查]{prompt="检查剩余问题，不要自动发布。"}',
  ':codex-annotation{index="2"}',
  '::inbox-item{title="更新完成" summary="构建通过"}',
  '::automation-update{name="每日检查"}',
  '来源 citeturn123search0 文件 \uE200filecite\uE202turn123file0\uE202L2-L8\uE201',
  'entity["company","OpenAI","AI"]',
  '::created-thread{clientThreadId="pending-id"}',
  '::code-comment{title="<script>alert(1)</script>" body="[bad](javascript:evil)" file="/fixture"}',
 ].join('\n\n'));
 for(const value of ['检查边界','请检查数组长度','app.ts:12','继续检查','不要自动发布','批注 2','更新完成','构建通过','每日检查','来源引用','L2-L8','OpenAI','任务正在准备中']) assert.ok(html.includes(value),value);
 assert.doesNotMatch(html,/::code-comment|:codex-followup|:codex-annotation|::inbox-item|::automation||turn123|<script|href="javascript/);
 assert.doesNotMatch(html,/<li>\s*<\/li>/);
});
test('question display follows the native latest turn and hides a positively newer saved turn', async () => {
 const {currentQuestions}=await vite.ssrLoadModule('/src/currentQuestions.ts');
 const q={turnId:'current',key:'q'},old={turnId:'old',key:'old'};
 const history={source:'desktop',turnTiming:{turnId:'current',startedAt:1000},asyncQuestions:[old,q]};
 assert.deepEqual(currentQuestions(history,null),[q]);
 assert.deepEqual(currentQuestions(history,{turnTiming:{turnId:'new',startedAt:2000}}),[]);
 assert.deepEqual(currentQuestions(history,{turnTiming:{turnId:'old',startedAt:500}}),[q]);
 assert.deepEqual(currentQuestions({...history,source:'rollout'},null),[]);
 assert.deepEqual(currentQuestions(null,{turnTiming:{turnId:'new'}}),[]);
});

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

test("registered local images render lazy previews and viewer buttons without exposing raw file routes", () => {
  const url='/api/tasks/aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa/images/'+'a'.repeat(64);
  const text='![本地图](</workspace/a b.jpg>)';
  const html=renderToStaticMarkup(createElement(MessageMarkdown,{text,images:{'/workspace/a b.jpg':url}}));
  assert.ok(html.includes(`src="${url}"`));assert.ok(!html.includes(`href="${url}"`));assert.match(html, /<button[^>]*aria-haspopup="dialog"/);
  assert.ok(html.includes('loading="lazy"'));assert.ok(html.includes('查看大图：本地图'));
  assert.doesNotMatch(html,/src="\/workspace|href="\/workspace|rel="preload"/);
  assert.doesNotMatch(render(`![fake](${url})`),/<img/);
  const external=renderToStaticMarkup(createElement(MessageMarkdown,{text,images:{'/workspace/a b.jpg':'https://example.com/private.jpg'}}));
  assert.doesNotMatch(external,/<img/);
});

test("an unknown head explains why the queue is paused rather than promising automatic delivery", async () => {
  const {default:Outbox}=await vite.ssrLoadModule('/src/Outbox.tsx');
  const html=renderToStaticMarkup(createElement(Outbox,{threadId:'test',items:[{id:'one',text:'pending',revision:0,status:'unknown'}],disabled:false,allowSend:true,drafts:new Map(),refresh:async()=>{}}));
  assert.ok(html.includes('首条结果待核对，队列已暂停'));
  assert.ok(html.includes('核对状态'));assert.ok(!html.includes('本轮结束后依次发送'));
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
  const live = renderToStaticMarkup(createElement(TurnDuration, { timing, live: true }));
  assert.doesNotMatch(live, /已用/);
  assert.match(live, /<time aria-label="本轮用时 0:08">0:08<\/time>/);
  assert.equal(renderToStaticMarkup(createElement(TurnDuration, { timing: { ...timing, status: "completed" }, live: false })), "");
});

test('file components and future Codex components become readable without exposing control syntax', async () => {
 const {readableCodexMarkdown}=await vite.ssrLoadModule('/src/codexMarkup.ts');
 const path='/workspace/简历 文件.docx';
 const directive=`:codex-file-citation{path="${path}" purpose="output"}`;
 const text=readableCodexMarkdown(directive);
 assert.doesNotMatch(text,/codex-file-citation|purpose=/);
 assert.match(text,/简历 文件/);
 assert.match(render(directive),/简历 文件/);
 assert.doesNotMatch(render(directive),/href="\/workspace|codex-file-citation|purpose=/);
 assert.equal(readableCodexMarkdown('`'+directive+'`'),'`'+directive+'`');
 assert.equal(readableCodexMarkdown('```text\n'+directive+'\n```'),'```text\n'+directive+'\n```');
 assert.equal(readableCodexMarkdown(':codex-file-citation{path="/workspace/unfinished'), '文件信息正在载入…');
 const future=render(':codex-future-panel{title="结果说明" body="请在电脑中查看" path="/workspace/private"}');
 assert.match(future,/结果说明/);assert.match(future,/此内容请在 Codex 查看/);
 assert.doesNotMatch(future,/codex-future-panel|path=|href=/);
 assert.doesNotMatch(render(':codex-file-citation{path="javascript:alert(1)"}'),/javascript:|href=/);
 const comment=render('::code-comment{title="检查 `value`" body="不要执行代码" file="/workspace/file.ts"}');
 assert.match(comment,/不要执行代码/);assert.doesNotMatch(comment,/::code-comment/);
});


test('escaped and hidden components remain literal while multiline streaming tails get a readable placeholder', async () => {
 const {readableCodexMarkdown}=await vite.ssrLoadModule('/src/codexMarkup.ts');
 for(const prefix of ['\\:', '\\::', ':\\:', ':::']) {
  const source=prefix+'codex-file-citation{path="/workspace/example.docx"}';
  assert.equal(readableCodexMarkdown(source),source);
 }
 const hidden='<div>\n:codex-future-view{title="Hidden title" body="Hidden body"}\n</div>';
 assert.equal(readableCodexMarkdown(hidden),hidden);assert.doesNotMatch(render(hidden),/Hidden title|Hidden body/);
 for(const source of [':codex-file-citation {path="/workspace/file.docx"', ':codex-file-citation{\npath="/workspace/file.docx"', ':codex-file-citation{path="/workspace/brace}file.docx'])
  assert.equal(readableCodexMarkdown(source),'文件信息正在载入…');
});

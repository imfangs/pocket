import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import ExcelJS from 'exceljs';
import { strToU8 } from 'fflate-modern';
import { png, contentTypes, zip, syntheticWord, syntheticPresentation } from './helpers/office-preview-fixtures.mjs';

const vite = await createServer({ configFile: false, esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => vite.close());
const [{ parseOfficePreviewBytes: parse }, archive, images, word, { createOfficePreviewParser, OFFICE_PREVIEW_LIMITS: limits }, { OfficeFileContent }] = await Promise.all([
  vite.ssrLoadModule('/src/officePreviewParse.ts'), vite.ssrLoadModule('/src/officePreviewArchive.ts'), vite.ssrLoadModule('/src/officePreviewImages.ts'),
  vite.ssrLoadModule('/src/officePreviewWord.ts'), vite.ssrLoadModule('/src/officePreview.ts'), vite.ssrLoadModule('/src/officePreviewContent.tsx'),
]);
const render = data => renderToStaticMarkup(createElement(OfficeFileContent, { data }));
test('synthetic DOCX preserves headings, emphasis, lists, tables and safe images without private capabilities', async () => {
  const data = await parse(syntheticWord(), 'docx'), html = render(data);
  assert.equal(data.kind, 'docx'); assert.deepEqual(data.warnings, []);
  assert.match(html, /<h1>合成标题<\/h1>/); assert.match(html, /<strong>重点正文<\/strong>/); assert.match(html, /<ul><li>列表项目<\/li><\/ul>/);
  assert.match(html, /表格内容/); assert.match(html, /<table>/); assert.match(html, /src="data:image\/png;base64,/);
  assert.match(html, /href="https:\/\/example.com\/article"/); assert.match(html, /私人能力链接/);
  assert.doesNotMatch(html, /href="https:\/\/pocket|<script|dangerouslySetInnerHTML/);
});

test('synthetic XLSX exposes sheets, cached formula values, rich text and safe literal cell content', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('第一张'), other = workbook.addWorksheet('Other');
  sheet.getCell('A1').value = '标题'; sheet.getCell('B1').value = { formula: '1+2', result: 3 };
  sheet.getCell('C1').value = { formula: 'WEBSERVICE("https://external.invalid/")' };
  sheet.getCell('A2').value = { richText: [{ text: '富' }, { text: '文本' }] };
  sheet.getCell('B2').value = { text: '显示文字', hyperlink: 'https://external.invalid/tracker' };
  sheet.getCell('C2').value = '<script>alert(1)</script>';
  other.getCell('A1').value = '第二张内容';
  const data = await parse(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx');
  assert.equal(data.sheets.length, 2); assert.deepEqual(data.sheets[0].rows[0], ['标题', '3', '=WEBSERVICE("https://external.invalid/")']);
  assert.deepEqual(data.sheets[0].rows[1], ['富文本', '显示文字', '<script>alert(1)</script>']);
  assert.deepEqual(data.sheets[1].rows, [['第二张内容']]);
  const html = render(data); assert.match(html, /aria-pressed="true"[^>]*>第一张/); assert.match(html, /文件中保存的单元格结果/);
  assert.match(html, /=WEBSERVICE\(&quot;https:\/\/external.invalid\/&quot;\)/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/); assert.doesNotMatch(html, /href=|<script/);
});

test('bounded XLSX preview discloses oversized row and column ranges', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Bounded');
  sheet.getCell('A1').value = 'visible'; sheet.getCell('BA301').value = 'outside preview';
  const data = await parse(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx');
  assert.deepEqual(data.warnings, ['partial']); assert.equal(data.sheets[0].rows.length, limits.rows);
  assert.equal(data.sheets[0].rows[0].length, limits.columns); assert.equal(data.sheets[0].rowCount, 301);
  assert.match(render(data), /下载原文件可查看完整内容/);
});

test('XLSX metadata cannot expand merges, column layouts or named ranges into implicit cell objects', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Sheet'); sheet.getCell('A1').value = 'saved value';
  const files = archive.readBoundedOfficeArchive(new Uint8Array(await workbook.xlsx.writeBuffer())).files;
  const workbookXml = new TextDecoder().decode(files.get('xl/workbook.xml'));
  files.set('xl/workbook.xml', strToU8(workbookXml.replace('</workbook>', '<definedNames><definedName name="Huge">Sheet!$A$1:$XFD$1048576</definedName></definedNames></workbook>')));
  const sheetXml = new TextDecoder().decode(files.get('xl/worksheets/sheet1.xml'));
  files.set('xl/worksheets/sheet1.xml', strToU8(sheetXml.replace('</sheetData>', '</sheetData><cols><col min="1" max="2147483647"/></cols><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells>')));
  const source = zip(Object.fromEntries(files)), unchanged = source.slice(), data = await parse(source, 'xlsx');
  assert.deepEqual(data.sheets[0].rows, [['saved value']]); assert.equal(data.sheets[0].columnCount, 1);
  assert.deepEqual(data.warnings, []); assert.deepEqual(source, unchanged, 'The original bytes remain available unchanged');
});

test('XLSX input sheets and implicit source columns are bounded before output clipping', async () => {
  const many = new ExcelJS.Workbook();
  for (let i = 0; i <= limits.sheets; i++) many.addWorksheet('Sheet' + i).getCell('A1').value = 'one';
  await rejectsCode(parse(new Uint8Array(await many.xlsx.writeBuffer()), 'xlsx'), 'limit');
  const wide = new ExcelJS.Workbook();
  for (let i = 0; i < 4; i++) wide.addWorksheet('Wide' + i).getCell('XFD1').value = 'one';
  await rejectsCode(parse(new Uint8Array(await wide.xlsx.writeBuffer()), 'xlsx'), 'limit');
});

test('a sheet omitted by the total cell budget is not mislabeled as empty', async () => {
  const workbook = new ExcelJS.Workbook();
  for (let i = 0; i < 3; i++) { const sheet = workbook.addWorksheet('Sheet' + i); sheet.getCell('A1').value = 'saved'; sheet.getCell('AX300').value = 'bounds'; }
  const data = await parse(new Uint8Array(await workbook.xlsx.writeBuffer()), 'xlsx'), omitted = data.sheets[2];
  assert.equal(omitted.rows.length, 0); assert.equal(omitted.rowCount, 300); assert.equal(omitted.columnCount, 50);
  const html = render({ ...data, sheets: [omitted] }); assert.match(html, /下载原文件可查看完整内容/); assert.doesNotMatch(html, /空工作表/);
});

test('synthetic PPTX follows presentation order and renders content cards, line breaks, images and tables', async () => {
  const data = await parse(syntheticPresentation(), 'pptx');
  assert.equal(data.totalSlides, 2); assert.equal(data.slides[0].blocks[0].text, '演示标题 & 内容');
  assert.equal(data.slides[0].blocks[0].heading, true); assert.equal(data.slides[0].blocks[1].text, '项目一\n下一行');
  assert.equal(data.slides[0].blocks[1].bullet, true); assert.equal(data.slides[1].blocks[0].text, '最后一页');
  assert.equal(data.slides[0].blocks.find(block => block.type === 'image').image.width, 1);
  assert.deepEqual(data.slides[0].blocks.find(block => block.type === 'table').rows, [['演示表格']]);
  const html = render(data); assert.match(html, /排版可能与 PowerPoint 不同/); assert.match(html, /office-preview-slide/);
  assert.match(html, /演示表格/); assert.doesNotMatch(html, /https?:\/\/[^" ]*\/image/);
});

test('ZIP lists normalized directory entries and verifies bytes without nested extraction', async () => {
  const nested = zip({ 'inside.txt': 'not opened' });
  const data = await parse(zip({ 'folder/': new Uint8Array(), 'folder/note.txt': 'body', 'folder/nested.zip': nested }), 'archive');
  assert.deepEqual(data.entries.map(entry => entry.name), ['folder/', 'folder/note.txt', 'folder/nested.zip']);
  assert.equal(data.entries[1].size, 4); assert.equal(data.entries.length, 3); assert.equal(data.expandedSize, 4 + nested.length);
  assert.match(render(data), /压缩包文件列表/); assert.doesNotMatch(render(data), /not opened/);
  assert.equal(archive.normalizeOfficeEntryName('folder\\note.txt'), 'folder/note.txt');
  assert.equal(archive.normalizeOfficeEntryName('folder/./note.txt'), 'folder/note.txt');
});

test('untrusted HTML has no script, raw attributes, arbitrary image source, protocol or private link capability', () => {
  const collector = images.createOfficeImageCollector(), image = collector.add(png);
  const html = '<h2 onclick="run()">Heading</h2><script>secret()</script><style>evil</style><iframe src="/api/tasks/a"></iframe>' +
    '<p><img src="https://external.invalid/pixel"><img src="/api/tasks/a/files/b"><img src="data:image/svg+xml;base64,PHN2Zy8+"><img src="safe-image" onerror="run()"></p>' +
    '<a href="javascript:alert(1)">js</a><a href="https://pocket.test/%61pi/machines/x/tasks/a/files/b">private</a>' +
    '<a href="https://example.com/article">safe</a><a href="mailto:hello@example.com">mail</a>';
  const nodes = word.officeWordNodes(html, new Map([['safe-image', image]]));
  const output = render({ kind: 'docx', nodes, warnings: [] });
  assert.match(output, /<h2>Heading/); assert.match(output, /data:image\/png/); assert.match(output, /https:\/\/example.com\/article/); assert.match(output, /mailto:hello@example.com/);
  assert.doesNotMatch(output, /<script|<style|<iframe|onclick|onerror|secret\(\)|external.invalid|data:image\/svg|href="(?:javascript|https:\/\/pocket)/);
  for (const url of ['file:///secret', '/api/tasks/a', 'codex://threads/a', 'data:text/html,x', 'https://pocket.test/%2561pi/tasks/a', 'https://x:secret@example.com/', 'mailto:x@example.com?body=%0AInjected']) assert.equal(word.safeOfficeHref(url), undefined, url);
});

test('embedded images require real raster signatures, bounded dimensions and matching data URI MIME', () => {
  assert.equal(images.officeImageInfo(png).width, 1);
  assert.equal(images.officeImageInfo(strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  const oversized = png.slice(); new DataView(oversized.buffer).setUint32(16, 999999); assert.equal(images.officeImageInfo(oversized), null);
  const collector = images.createOfficeImageCollector(), image = collector.add(png);
  assert.equal(images.safeOfficeImage(image), true); assert.equal(images.safeOfficeImage({ ...image, src: image.src.replace('image/png', 'image/jpeg') }), false);
  assert.equal(images.safeOfficeImage({ ...image, src: 'https://external.invalid/pixel' }), false);
  assert.equal(images.safeOfficeImage({ ...image, src: 'data:image/svg+xml;base64,PHN2Zy8+' }), false);
  collector.add(new Uint8Array(limits.imageBytes + 1)); assert.equal(collector.omitted, true);
  const pixels = images.createOfficeImageCollector(), large = () => {
    const bytes = png.slice(), view = new DataView(bytes.buffer); view.setUint32(16, 4096); view.setUint32(20, 2048); return bytes;
  };
  assert.ok(pixels.add(large())); assert.ok(pixels.add(large())); assert.equal(pixels.add(large()), null); assert.equal(pixels.omitted, true);
});

const corruptCentral = (bytes, edit) => {
  const copy = bytes.slice(), view = new DataView(copy.buffer); let central = -1;
  for (let i = 0; i + 46 <= copy.length; i++) if (view.getUint32(i, true) === 0x02014b50) { central = i; break; }
  assert.ok(central >= 0); edit(view, central, copy); return copy;
};
const rejectsCode = (promise, code) => assert.rejects(promise, error => error?.name === 'OfficePreviewError' && error.code === code);

test('ZIP limits reject count, declared expansion, actual forged expansion, CRC and directory traversal', async () => {
  await rejectsCode(parse(new Uint8Array(limits.compressedBytes + 1), 'archive'), 'limit');
  await rejectsCode(parse(zip(Object.fromEntries(Array.from({ length: limits.entries + 1 }, (_, i) => [`${i}.txt`, '']))), 'archive'), 'limit');
  await rejectsCode(parse(zip({ large: new Uint8Array(limits.entryBytes + 1) }), 'archive'), 'limit');
  await rejectsCode(parse(zip(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`big${i}`, new Uint8Array(limits.entryBytes)]))), 'archive'), 'limit');
  const bomb = corruptCentral(zip({ bomb: new Uint8Array(2 * 1024 * 1024) }), (view, offset) => {
    const local = view.getUint32(offset + 42, true); view.setUint32(offset + 24, 10, true); view.setUint32(local + 22, 10, true);
  });
  await rejectsCode(parse(bomb, 'archive'), 'limit');
  await rejectsCode(parse(corruptCentral(zip({ item: 'abc' }), (view, offset) => {
    const local = view.getUint32(offset + 42, true); view.setUint32(offset + 16, 0, true); view.setUint32(local + 14, 0, true);
  }), 'archive'), 'invalid');
  for (const name of ['../secret', '/absolute', 'drive:c/file', 'nested/../../outside']) await rejectsCode(parse(zip({ [name]: 'text' }), 'archive'), 'invalid');
  await rejectsCode(parse(zip({ 'same': 'one', './same': 'two' }), 'archive'), 'invalid');
});

test('Office XML rejects DTD/entity, malformed structures, excessive nesting and cell input before engines', async () => {
  const doc = source => zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': source });
  await rejectsCode(parse(doc('<!DOCTYPE x [<!ENTITY e SYSTEM "https://external.invalid/">]><x>&e;</x>'), 'docx'), 'unsupported');
  await rejectsCode(parse(zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': '<x/>', 'word/style.payload': ' '.repeat(600) + '<!DOCTYPE x [<!ENTITY e SYSTEM "https://external.invalid/">]><x>&e;</x>' }), 'docx'), 'unsupported');
  await rejectsCode(parse(zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': '<x/>', 'word/_rels/document.xml.rels': '<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="style.payload"/></r:Relationships>', 'word/style.payload': 'forgiving prefix <!DOCTYPE x [<!ENTITY e SYSTEM "https://external.invalid/">]><x>&e;</x>' }), 'docx'), 'unsupported');
  await rejectsCode(parse(zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': '<x/>', '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/main.payload"/></Relationships>', 'word/main.payload': 'junk <x>' + '<x/>'.repeat(limits.xmlNodes + 1) + '</x>' }), 'docx'), 'limit');
  await rejectsCode(parse(zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': '<x/>', '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/main#x.payload"/></Relationships>', 'word/main#x.payload': 'junk <!DOCTYPE x><x/>' }), 'docx'), 'unsupported');
  await rejectsCode(parse(zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': '<x/>', '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="x" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/main.payload" TargetMode="External"/></Relationships>', 'word/main.payload': 'junk <!DOCTYPE x><x/>' }), 'docx'), 'unsupported');
  await rejectsCode(parse(zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': '<x/>', 'word/style.payload': '<根>' + '<字/>'.repeat(limits.xmlNodes + 1) + '</根>' }), 'docx'), 'limit');
  await rejectsCode(parse(zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': '<x/>', 'xl/drawing.vml': '<!DOCTYPE x><x/>' }), 'docx'), 'unsupported');
  await rejectsCode(parse(doc('<x><bad></x>'), 'docx'), 'invalid');
  await rejectsCode(parse(doc('<x>'.repeat(limits.xmlDepth + 1) + '</x>'.repeat(limits.xmlDepth + 1)), 'docx'), 'limit');
  await rejectsCode(parse(doc('<!-- </x> -->'.repeat(limits.xmlDepth + 1) + '<x>'.repeat(limits.xmlDepth + 1) + '</x>'.repeat(limits.xmlDepth + 1)), 'docx'), 'limit');
  await rejectsCode(parse(doc('<根>' + '<字 属性=">"/>'.repeat(limits.xmlNodes + 1) + '</根>'), 'docx'), 'limit');
  await rejectsCode(parse(zip({ '[Content_Types].xml': contentTypes, 'xl/workbook.xml': '<x/>', 'xl/worksheets/sheet1.xml': '<worksheet>' + '<c/>'.repeat(limits.inputCells + 1) + '</worksheet>' }), 'xlsx'), 'limit');
  await rejectsCode(parse(zip({ '[Content_Types].xml': contentTypes, 'word/document.xml': '<x>' + 't'.repeat(limits.xmlBytes) + '</x>' }), 'docx'), 'limit');
});

class FakeWorker {
  onmessage = null; onerror = null; onmessageerror = null; stopped = false; message;
  postMessage(message) { this.message = message; }
  terminate() { this.stopped = true; }
  reply(data) { this.onmessage?.({ data: { ok: true, data } }); }
}
const validResult = { kind: 'archive', entries: [], expandedSize: 0, warnings: [] };
test('cancelling terminates that worker and stale results cannot change the next preview', async () => {
  const workers = [], run = createOfficePreviewParser(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const controller = new AbortController(), first = run(new Blob(['zip']), 'archive', controller.signal);
  const rejected = assert.rejects(first, { name: 'AbortError' }); controller.abort(); await rejected;
  assert.equal(workers[0].stopped, true);
  const second = run(new Blob(['next']), 'archive', new AbortController().signal);
  workers[0].reply(validResult); assert.equal(workers[1].stopped, false); workers[1].reply(validResult);
  assert.deepEqual(await second, validResult); assert.equal(workers[1].stopped, true);
});
test('parser timeout terminates CPU work and keeps errors bounded without source text', async () => {
  const worker = new FakeWorker(), run = createOfficePreviewParser(() => worker, 5);
  await rejectsCode(run(new Blob(['zip']), 'archive', new AbortController().signal), 'timeout'); assert.equal(worker.stopped, true);
  const other = new FakeWorker(), retry = createOfficePreviewParser(() => other);
  const result = retry(new Blob(['zip']), 'archive', new AbortController().signal);
  other.onmessage({ data: { ok: false, code: 'unexpected PRIVATE SOURCE' } }); await rejectsCode(result, 'invalid'); assert.equal(other.stopped, true);
});

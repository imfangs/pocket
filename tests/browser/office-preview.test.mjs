import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
import { zip, syntheticWord, syntheticPresentation } from '../helpers/office-preview-fixtures.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_OFFICE_PREVIEW_REPORT || '.local/qa/browser-office-preview/scenarios.json');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const workbook = new ExcelJS.Workbook(), first = workbook.addWorksheet('First sheet'), second = workbook.addWorksheet('第二张');
first.getCell('A1').value = 'Saved result'; first.getCell('B1').value = { formula: '1+2', result: 3 };
first.getCell('C1').value = { formula: 'WEBSERVICE("https://external.invalid/collect")' };
second.getCell('A1').value = 'Second sheet content'; second.getCell('A2').value = '<script>bad()</script>';
const bytes = { docx: syntheticWord(), xlsx: new Uint8Array(await workbook.xlsx.writeBuffer()), pptx: syntheticPresentation(), zip: zip({ 'folder/': new Uint8Array(), 'folder/note.txt': 'inside', 'nested.zip': zip({ 'private.txt': 'never rendered' }) }) };
const files = Object.fromEntries(Object.keys(bytes).map((kind, index) => [kind, { name: `Synthetic.${kind}`, path: `/synthetic/preview.${kind}`, url: `/api/tasks/${ids.regular}/files/${String(index + 1).repeat(64)}` }]));
const messageId = 'synthetic-office-preview';
const message = { id: messageId, role: 'assistant', phase: 'final', turnId: 'office-turn', timestamp: Date.now(),
  text: Object.values(files).map(file => `[${file.name}](${file.path})`).join('\n\n'), files: Object.fromEntries(Object.values(files).map(file => [file.path, { name: file.name, url: file.url }])) };
const dialog = page => page.locator('dialog.text-file-viewer[data-rich-file-preview]');
const fileButton = (page, kind) => page.locator(`[data-message-id="${messageId}"] .message-file`).filter({ hasText: files[kind].name }).locator('.message-file-button[aria-haspopup="dialog"]');
async function setup(h, slow = false) {
  h.patchHistory(ids.regular, { messages: [message] }); h.patchTranscript(ids.regular, { messages: [message] });
  const page = await h.open(null), reads = [];
  // WebKit implements worker Blob.arrayBuffer through a browser-internal
  // blob: load. The shared fixture otherwise treats its UUID as a missing
  // static build asset. Continue only native blobs on this synthetic origin.
  await page.context().route(/^blob:https:\/\/pocket\.test\//, route => route.continue());
  await page.route(/\/api\/tasks\/[^/]+\/files\/[1-4]{64}$/, async route => {
    const path = new URL(route.request().url()).pathname, kind = Object.keys(files).find(kind => files[kind].url === path);
    assert.ok(kind, 'Only issued synthetic documents may be read'); reads.push(kind);
    if (slow && kind === 'docx') await new Promise(resolve => setTimeout(resolve, 450));
    try { await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'Cache-Control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: Buffer.from(bytes[kind]) }); }
    catch (error) { if (!slow) throw error; }
  });
  await page.goto(page.url() + '&task=' + ids.regular); await fileButton(page, 'docx').waitFor();
  return { page, reads };
}
async function close(page) { await dialog(page).locator('.text-file-close').click(); await dialog(page).waitFor({ state: 'detached' }); }
for (const engine of engines) for (const [locale, width] of [['zh-CN', 390], ['en-US', 320]]) {
  test(`${engine}: ${locale} ${width}px Office workers show DOCX, saved XLSX values, PPTX cards and ZIP file lists`, { timeout: 45000 }, () => {
    const evidence = {};
    return runScenario({ engine, name: `${locale} ${width}px Office content previews`, create: () => createHarness(engine, { locale, width }),
      run: async h => {
        const { page, reads } = await setup(h);
        await fileButton(page, 'docx').click(); await dialog(page).locator('h1').filter({ hasText: '合成标题' }).waitFor();
        assert.equal(await dialog(page).locator('strong').textContent(), '重点正文'); assert.equal(await dialog(page).locator('li').textContent(), '列表项目');
        assert.equal(await dialog(page).locator('a[href="https://example.com/article"]').count(), 1);
        assert.equal(await dialog(page).locator('a[href*="/api/"]').count(), 0);
        await page.waitForFunction(() => { const image = document.querySelector('dialog[data-rich-file-preview] .office-preview-image'); return image?.complete && image.naturalWidth === 1; });
        evidence.docx = { heading: await dialog(page).locator('h1').textContent(), image: await dialog(page).locator('img').getAttribute('src').then(value => value.slice(0, 22)) };
        await close(page);
        await fileButton(page, 'xlsx').click(); await dialog(page).locator('.office-preview-sheets').waitFor();
        const sheetButtons = dialog(page).locator('.office-preview-sheets button'); assert.equal(await sheetButtons.count(), 2);
        assert.equal(await dialog(page).locator('tbody tr').first().locator('td').nth(1).textContent(), '3');
        assert.match(await dialog(page).textContent(), /=WEBSERVICE\("https:\/\/external.invalid\/collect"\)/);
        await sheetButtons.nth(1).click(); await dialog(page).getByText('Second sheet content', { exact: true }).waitFor();
        assert.equal(await sheetButtons.nth(1).getAttribute('aria-pressed'), 'true'); assert.equal(await dialog(page).locator('script').count(), 0);
        assert.match(await dialog(page).textContent(), /<script>bad\(\)<\/script>/); evidence.xlsx = { sheets: await sheetButtons.allTextContents(), savedResult: '3', missingResult: 'formula source' };
        await close(page);
        await fileButton(page, 'pptx').click(); await dialog(page).locator('.office-preview-slide').first().waitFor();
        assert.equal(await dialog(page).locator('.office-preview-slide').count(), 2); assert.match(await dialog(page).textContent(), /演示表格/);
        assert.match(await dialog(page).locator('.office-preview-slide').first().textContent(), /演示标题 & 内容/); evidence.pptx = { cards: 2 };
        await close(page);
        await fileButton(page, 'zip').click(); await dialog(page).locator('.office-preview-archive tbody tr').first().waitFor();
        assert.equal(await dialog(page).locator('.office-preview-archive tbody tr').count(), 3); assert.doesNotMatch(await dialog(page).textContent(), /never rendered/);
        const geometry = await dialog(page).evaluate(element => ({ scrollWidth: element.scrollWidth, width: element.clientWidth }));
        assert.ok(geometry.scrollWidth <= geometry.width + 1, 'The modal contains all horizontal table overflow');
        evidence.zip = { entries: 3, geometry }; evidence.reads = reads; assert.deepEqual(reads, ['docx', 'xlsx', 'pptx', 'zip']);
        await close(page);
      }, record: result => results.push({ ...result, evidence }) });
  });
}
for (const engine of engines) test(`${engine}: closing a slow Office source cancels it before a new file becomes visible`, { timeout: 30000 }, () => {
  const evidence = {};
  return runScenario({ engine, name: 'Office close and source lifetime', create: () => createHarness(engine), run: async h => {
    const { page, reads } = await setup(h, true); await fileButton(page, 'docx').click(); await dialog(page).waitFor(); await close(page);
    await fileButton(page, 'zip').click(); await dialog(page).locator('.office-preview-archive tbody tr').first().waitFor();
    await page.waitForTimeout(600); assert.equal(await dialog(page).locator('.office-preview-document').count(), 0);
    assert.equal(await dialog(page).locator('h2').textContent(), files.zip.name); evidence.reads = reads; evidence.visible = files.zip.name;
    await close(page);
  }, record: result => results.push({ ...result, evidence }) });
});

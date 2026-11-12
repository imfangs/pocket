import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
import { htmlPreviewSandbox } from '../../shared/html-runtime-policy.mjs';
import { chromium, webkit } from 'playwright';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_READING_REPORT || '.local/qa/interface-expansion-2026-11-09/reading/results.json');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const words = {
  'zh-CN': { retry: '重试', empty: '空文件', source: '源码', preview: '预览', close: '关闭文件预览', imageClose: '关闭图片', imageRetry: '重新加载图片', zoom: '放大图片', reset: '复位图片', diagram: '放大查看图表' },
  'en-US': { retry: 'Retry', empty: 'Empty file', source: 'Source', preview: 'Preview', close: 'Close file preview', imageClose: 'Close image', imageRetry: 'Reload image', zoom: 'Zoom in image', reset: 'Reset image', diagram: 'Enlarge diagram' },
};
const message = (id, text, extra = {}) => ({ id, text, role: 'assistant', phase: 'final', turnId: 'reading', timestamp: Date.now(), ...extra });
const file = name => ({ name, path: '/synthetic/' + name, url: `/api/tasks/${ids.regular}/files/${createHash('sha256').update(name).digest('hex')}` });
// One second of a synthetic navy frame, generated locally with H.264; no external asset.
const videoBytes = Buffer.from('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', 'base64');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const table = '| ' + Array.from({ length: 8 }, (_, i) => `Column ${i}`).join(' | ') + ' |\n| ' + Array(8).fill('---').join(' | ') + ' |\n| ' + Array.from({ length: 8 }, (_, i) => `Evidence ${i}`).join(' | ') + ' |';
const code = 'curl --request GET --header "X-Synthetic-Reading: example" https://synthetic.invalid/recovery/documentation/end-of-line';
const longTitle = '阅读恢复与预览证据'.repeat(8) + ' / ' + 'ResearchAndImplementationNotes'.repeat(5);
const until = async predicate => { const deadline = Date.now() + 8000; while (!predicate()) { if (Date.now() > deadline) throw Error('Synthetic read did not arrive'); await new Promise(done => setTimeout(done, 20)); } };
// WebKit's native media creates local Blob probes before the page is ready.
// Keep those in-memory reads; every HTTP request still uses the closed fixture.
const localBlobLaunch = engine => async options => {
  const browser = await ({ chromium, webkit })[engine].launch(options);
  const createContext = browser.newContext.bind(browser);
  browser.newContext = async settings => {
    const context = await createContext(settings), register = context.route.bind(context);
    context.route = (pattern, handler) => register(pattern, route => {
      const request = route.request();
      return request.method() === 'GET' && request.url().startsWith('blob:https://pocket.test/')
        ? route.continue() : handler(route);
    });
    return context;
  };
  return browser;
};
function flow(engine, locale, width, name, run, options = {}) {
  test(`${engine}: ${locale} ${width}px ${name}`, { timeout: 30000 }, () => {
    const evidence = {};
    return runScenario({ engine, name: `${locale} ${width}px ${name}`, create: () => createHarness(engine, { locale, width, ...options }),
      run: h => run(h, evidence), record: result => results.push({ ...result, evidence }) });
  });
}
const install = (h, f, text = `[Synthetic document](<${f.path}>)`) => h.patchHistory(ids.regular, { messages: [message('document', text, { files: { [f.path]: f } })] });
async function serveFile(page, f, respond) {
  await page.route(`**/files/${f.url.split('/').at(-1)}`, async route => {
    assert.equal(route.request().method(), 'GET');
    const value = await respond();
    await route.fulfill({ status: value.status ?? 200, contentType: 'application/octet-stream',
      headers: { 'X-Pocket-Machine': new URL(page.url()).searchParams.get('machine'), 'Cache-Control': 'no-store' }, body: value.body ?? '' });
  });
}
async function closePreview(page, opener) {
  await page.keyboard.press('Escape'); await page.locator('dialog.text-file-viewer').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.matches('.message-file-button'));
  assert.equal(await opener.evaluate(e => document.activeElement === e), true);
  assert.equal(await page.locator('.conversation-live').count(), 1, 'Escape closes only the reading overlay');
}

for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) {
  for (const width of [320, 390]) {
    flow(engine, locale, width, 'Markdown file code can be reached by Tab and scrolled locally before returning', async (h, evidence) => {
      const f = file('ResearchAndImplementationNotesForReadingRecoveryAndPreview.md');
      install(h, f); const page = await h.open(); let reads = 0;
      await serveFile(page, f, () => { reads++; return { body: '# ' + longTitle + '\n\nKeyboard-readable command:\n\n```sh\n' + code + '\n```' }; });
      const opener = page.locator('.message-file-button'); await opener.click();
      const pre = page.locator('dialog.text-file-viewer pre'); await pre.waitFor();
      evidence.code = await pre.evaluate(e => ({ clientWidth: e.clientWidth, scrollWidth: e.scrollWidth, tabIndex: e.tabIndex }));
      assert.ok(evidence.code.scrollWidth > evidence.code.clientWidth, 'The real command needs horizontal reading');
      await page.locator('.text-file-scroll').focus(); await page.keyboard.press('Tab');
      assert.equal(await pre.evaluate(e => document.activeElement === e), true, 'Tab must enter the code scroll area in both engines');
      await page.keyboard.press('ArrowRight'); await page.waitForTimeout(200);
      evidence.nativeArrowScrollLeft = await pre.evaluate(e => e.scrollLeft);
      // Mobile WebKit leaves ArrowRight inert with explicit tabindex too.
      // Protect explicit keyboard access without replacing native scrolling.
      if (engine === 'chromium') {
        const bounds = await pre.boundingBox(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.wheel(350, 0); await page.waitForTimeout(220);
        evidence.nativeWheelScrollLeft = await pre.evaluate(e => e.scrollLeft);
      } else {
        evidence.nativeWheelUnsupported = 'Playwright: Mouse wheel is not supported in mobile WebKit';
      }
      evidence.horizontalPositionMethod = 'native keyboard/wheel';
      if (engine === 'webkit') {
        // This driver has no mobile WebKit wheel input. Check
        // the real overflow area using its scroll position, without claiming
        // a physical touch gesture or changing the application's key handling.
        await pre.evaluate(e => { e.scrollLeft = 350; }); evidence.horizontalPositionMethod = 'programmatic mobile-WebKit scroll position';
      }
      evidence.scrollLeft = await pre.evaluate(e => e.scrollLeft); assert.ok(evidence.scrollLeft > 0, 'The command can move within its own overflow area');
      assert.equal(await pre.textContent(), code + '\n', 'The code remains literal');
      await closePreview(page, opener); assert.equal(reads, 1);
    });
  }

  flow(engine, locale, 320, 'long headings, inline content and wide tables stay local; folding and selection survive fresh reads', async (h, evidence) => {
    const text = '# ' + longTitle + '\n\nInline `' + 'syntheticIdentifier'.repeat(14) + '` stays readable.\n\n' + table + '\n\n```sh\n' + code + '\n```\n\nSelection anchor stays in this original paragraph.\n\n<details><summary>' + longTitle + '</summary>\n\nNested **reading details**.\n\n</details>';
    const messages = [message('progress-1', '合成过程一 / Reading progress one.', { phase: 'commentary' }), message('progress-2', '合成过程二 / Reading progress two.', { phase: 'commentary' }), message('answer', text)];
    h.patchHistory(ids.regular, { messages }); const page = await h.open(), root = page.locator('.conversation-messages'), row = page.locator('[data-message-id="answer"]');
    await row.locator('h1').waitFor();
    const toggle = page.locator('.progress-disclosure-toggle'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await toggle.click(); await page.waitForTimeout(220); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await row.locator('summary').click(); await row.getByText('Nested reading details.', { exact: true }).waitFor();
    const tbl = row.locator('.markdown-table'); await tbl.focus();
    for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); await page.waitForTimeout(70); }
    evidence.table = await tbl.evaluate(e => ({ clientWidth: e.clientWidth, scrollWidth: e.scrollWidth, scrollLeft: e.scrollLeft }));
    assert.ok(evidence.table.scrollWidth > evidence.table.clientWidth && evidence.table.scrollLeft > 0);
    evidence.geometry = await root.evaluate(e => ({ clientWidth: e.clientWidth, scrollWidth: e.scrollWidth }));
    assert.ok(evidence.geometry.scrollWidth <= evidence.geometry.clientWidth + 1, 'Long content does not widen the conversation');
    const paragraph = row.getByText('Selection anchor stays in this original paragraph.', { exact: true }); await paragraph.scrollIntoViewIfNeeded();
    await paragraph.evaluate(e => { window.readingSelectedNode = e.firstChild; const range = document.createRange(); range.selectNodeContents(e); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
    const before = await root.evaluate(e => e.scrollTop), reads = h.count('history');
    h.patchHistory(ids.regular, { messages: [...messages, message('fresh-answer', 'New synthetic answer.', { turnId: 'next' })] }); await refresh(page); await until(() => h.count('history') > reads); await page.waitForTimeout(220);
    assert.equal(await page.evaluate(() => getSelection().toString()), 'Selection anchor stays in this original paragraph.');
    assert.equal(await paragraph.evaluate(e => e.firstChild === window.readingSelectedNode), true);
    assert.ok(Math.abs(await root.evaluate(e => e.scrollTop) - before) <= 2, 'A fresh read keeps the selected reading position');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await row.locator('details').getAttribute('open'), '');
    await page.evaluate(() => getSelection().removeAllRanges());
    // Establish an unambiguous away-from-latest position before leaving.
    // Synthetic mobile WebKit does not consistently perform PageUp scrolling.
    await page.waitForTimeout(150);
    await root.evaluate(e => { e.scrollTop = Math.round((e.scrollHeight - e.clientHeight) / 3); }); await page.waitForTimeout(180);
    assert.ok(await root.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop > 100), 'Return checks apply to a reader deliberately away from latest');
    const savedPosition = await root.evaluate(e => e.scrollTop);
    evidence.savedPosition = savedPosition;
    await page.locator('[data-inspector-close]').click(); await page.locator('.inspector').waitFor({ state: 'detached' });
    await page.locator(`[data-thread-id="${ids.regular}"]`).click(); await page.locator('.conversation-live').waitFor(); await page.waitForTimeout(250);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'Returning retains the manually expanded process');
    evidence.returnPosition = await root.evaluate(e => e.scrollTop);
    assert.ok(Math.abs(evidence.returnPosition - savedPosition) <= 2, 'Returning restores the reading position');
  });

  flow(engine, locale, 320, 'file failure retry, empty files, safe Markdown and preview-byte download keep the original reader', async (h, evidence) => {
    const f = file('恢复说明与代码测试.md'); install(h, f); const page = await h.open(), opener = page.locator('.message-file-button');
    const draft = page.locator('.conversation-composer textarea'); await draft.fill('Unsent synthetic reading draft'); await draft.blur();
    let reads = 0, body = '';
    await serveFile(page, f, () => ({ status: ++reads === 1 ? 503 : 200, body }));
    await opener.click(); const dialog = page.locator('dialog.text-file-viewer'); await dialog.locator('[role="alert"]').waitFor();
    await dialog.getByRole('button', { name: words[locale].retry, exact: true }).click(); await dialog.getByText(words[locale].empty, { exact: true }).waitFor();
    await closePreview(page, opener);
    body = '# ' + longTitle + '\n\n' + table + '\n\n```html\n<script>literalExample()</script>\n```\n\n![Do not fetch remote image](https://external.invalid/private.png)\n\n[Unregistered file](/synthetic/private.txt)\n\n<script>window.authoredFileScriptRan=true</script>';
    await opener.click(); await dialog.locator('.markdown-table').waitFor();
    assert.equal(await dialog.locator('img,iframe,.message-file-button').count(), 0, 'File Markdown cannot inherit media or file capabilities');
    assert.equal(await dialog.locator('a[href]').count(), 0);
    assert.equal(await page.evaluate(() => !!window.authoredFileScriptRan), false);
    assert.match(await dialog.locator('pre').textContent(), /<script>literalExample\(\)<\/script>/);
    await page.evaluate(() => { window.readingDownloads = []; const create = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { window.readingDownloads.push(blob); return create(blob); }; HTMLAnchorElement.prototype.click = function () {}; });
    await dialog.locator('.text-file-toolbar button').first().click();
    await page.waitForFunction(() => window.readingDownloads.length === 1);
    assert.equal(await page.evaluate(() => window.readingDownloads[0].text()), body);
    assert.equal(reads, 3, 'Downloading reuses the verified preview bytes');
    await closePreview(page, opener); assert.equal(await draft.inputValue(), 'Unsent synthetic reading draft');
    evidence.reads = reads;
  });

  flow(engine, locale, 390, 'inline image and viewer failures retry, zoom reset and nested Escape restore the reader', async (h, evidence) => {
    const imagePath = '/synthetic/card.png', src = `/api/tasks/${ids.regular}/images/${'a'.repeat(64)}`;
    const attachmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', attachmentUrl = `/api/tasks/${ids.regular}/attachments/${attachmentId}`;
    const attachment = { id: attachmentId, name: 'Synthetic image.png', size: png.length, mime: 'image/png', kind: 'image', sha256: createHash('sha256').update(png).digest('hex'), url: attachmentUrl, previewUrl: attachmentUrl + '?preview=1', previewSha256: createHash('sha256').update(png).digest('hex'), previewMime: 'image/png', previewSize: png.length };
    h.patchHistory(ids.regular, { messages: [message('picture', 'Synthetic image:\n\n![Reading card](<' + imagePath + '>)', { images: { [imagePath]: src }, attachments: [attachment] })] });
    const page = await h.open(null); let attempts = 0, failInline = true, failViewer = true;
    await page.route(/^blob:https:\/\/pocket\.test\//, route => route.continue());
    await page.route('**/images/' + 'a'.repeat(64), route => { attempts++; return route.fulfill({ status: failInline ? 503 : 200, contentType: 'image/png', headers: { 'Cache-Control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: failInline ? '' : png }); });
    await page.route('**/attachments/' + attachmentId + '*', route => { attempts++; const failed = !new URL(route.request().url()).search && failViewer; return route.fulfill({ status: failed ? 503 : 200, contentType: 'image/png', headers: { 'Cache-Control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: failed ? '' : png }); });
    await page.goto(page.url() + '&task=' + ids.regular); const picture = page.locator('.message-image');
    const retry = picture.getByRole('button', { name: words[locale].retry, exact: true }); await retry.waitFor(); failInline = false;
    await retry.click(); const opener = page.locator('.attachment-card[aria-haspopup="dialog"]');
    await page.waitForFunction(() => { const e = document.querySelector('.message-image-frame img'); return e?.complete && e.naturalWidth > 0; }); await opener.click();
    const viewer = page.locator('dialog[data-image-viewer]'); await viewer.locator('[role="alert"]').waitFor();
    assert.equal(await viewer.locator('.image-viewer-close').isVisible(), true);
    failViewer = false; await viewer.getByRole('button', { name: words[locale].imageRetry, exact: true }).click();
    await page.waitForFunction(() => { const e = document.querySelector('dialog[data-image-viewer] img'); return e?.complete && e.naturalWidth > 0; }); await viewer.locator('.image-viewer-zoom button').last().click();
    assert.ok(Number(await viewer.locator('img').getAttribute('data-scale')) > 1);
    await viewer.locator('.image-viewer-reset').click(); assert.equal(Number(await viewer.locator('img').getAttribute('data-scale')), 1);
    const scroll = await page.locator('.conversation-messages').evaluate(e => e.scrollTop);
    await page.keyboard.press('Escape'); await viewer.waitFor({ state: 'detached' }); await page.waitForFunction(() => document.activeElement?.matches('.attachment-card'));
    assert.equal(await page.locator('.conversation-live').count(), 1); assert.equal(await opener.evaluate(e => document.activeElement === e), true);
    assert.ok(Math.abs(await page.locator('.conversation-messages').evaluate(e => e.scrollTop) - scroll) <= 1);
    evidence.attempts = attempts;
  });

  flow(engine, locale, 320, 'HTML source switching and guest Escape retain isolation and return to the file entry', async (h, evidence) => {
    const f = file('SyntheticLongDocumentForReadingRecovery.html'); install(h, f); const page = await h.open(), opener = page.locator('.message-file-button');
    const source = '<!doctype html><html><body><h1>Synthetic isolated document</h1><details><summary>Guest details</summary><p>Guest disclosure</p></details><p style="height:1200px">Authored document</p></body></html>';
    await page.route(`**/files/${f.url.split('/').at(-1)}/preview`, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'X-Pocket-Machine': new URL(page.url()).searchParams.get('machine') }, body: JSON.stringify({ schemaVersion: 1, name: f.name, sourceBase64: Buffer.from(source).toString('base64'), images: {}, omittedImages: 0 }) }));
    await opener.click(); const dialog = page.locator('dialog.text-file-viewer'), frame = page.frameLocator('dialog.text-file-viewer iframe');
    await frame.getByRole('heading', { name: 'Synthetic isolated document' }).waitFor();
    assert.equal(await dialog.locator('iframe').getAttribute('sandbox'), htmlPreviewSandbox);
    await frame.locator('summary').click();
    await dialog.getByRole('button', { name: words[locale].source, exact: true }).click(); await dialog.locator('.html-file-source pre').waitFor();
    assert.equal(await dialog.locator('.html-file-source pre').textContent(), source);
    await dialog.getByRole('button', { name: words[locale].preview, exact: true }).click();
    assert.equal(await frame.locator('details').getAttribute('open'), '', 'Switching keeps the authored document instance');
    evidence.isolated = await frame.locator('body').evaluate(e => { try { e.ownerDocument.defaultView.parent.document.body; return false; } catch { return true; } });
    assert.equal(evidence.isolated, true);
    await frame.getByRole('heading').click(); await closePreview(page, opener);
  }, { safeFrameServiceWorkers: true });
}

for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) {
  flow(engine, locale, 320, 'quoted video failure stays readable and retries actual synthetic playback without changing the reading column', async (h, evidence) => {
    const f = file('ReadingRecoveryDemonstrationWithALongEnglishAnd中文Title.mp4');
    install(h, f, '<details><summary>Quoted recovery recording</summary>\n\n> > ![' + longTitle + '](<' + f.path + '>)\n\n</details>');
    const page = await h.open(null); let failed = true, requests = 0;
    await page.route(`**/files/${f.url.split('/').at(-1)}?*`, async route => {
      const request = route.request(); assert.equal(request.method(), 'GET');
      assert.equal(new URL(request.url()).searchParams.get('video'), '1'); requests++;
      if (failed) return route.fulfill({ status: 503, contentType: 'video/mp4', body: '' });
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '');
      const first = Number(range?.[1] || 0), last = Math.min(videoBytes.length - 1, Number(range?.[2] || videoBytes.length - 1));
      await route.fulfill({ status: range ? 206 : 200, contentType: 'video/mp4', headers: { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${first}-${last}/${videoBytes.length}` } : {}) }, body: videoBytes.subarray(first, last + 1) });
    });
    await page.goto(page.url() + '&task=' + ids.regular); await page.locator('summary').click();
    const video = page.locator('video'); await video.evaluate(e => e.load()); await page.locator('.message-video-failure').waitFor();
    evidence.geometry = await page.locator('.message-video').evaluate(e => {
      const frame = e.querySelector('.message-video-frame').getBoundingClientRect(), button = e.querySelector('.message-video-failure button').getBoundingClientRect();
      return { frame: frame.toJSON(), button: button.toJSON(), hit: !!document.elementFromPoint(button.x + button.width / 2, button.bottom - 2)?.closest('.message-video-failure button') };
    });
    assert.ok(evidence.geometry.button.height >= 44 && evidence.geometry.button.bottom <= evidence.geometry.frame.bottom && evidence.geometry.hit);
    failed = false; await page.locator('.message-video-failure button').click();
    await page.waitForFunction(() => { const e = document.querySelector('video'); return e?.readyState >= 2 && !e.error; });
    assert.equal(await page.locator('.message-video-failure').count(), 0);
    const caption = page.locator('.message-video-name'); assert.equal(await caption.getAttribute('title'), longTitle);
    evidence.requests = requests; assert.ok(requests >= 2);
    assert.ok(await page.locator('.conversation-messages').evaluate(e => e.scrollWidth <= e.clientWidth + 1));
    await video.evaluate(e => e.pause());
  }, { launch: localBlobLaunch(engine) });

  flow(engine, locale, 390, 'real Mermaid rendering, source choice, enlargement and invalid fallback recover in place', async (h, evidence) => {
    const diagram = 'flowchart TD\n  Read[Read 合成正文] --> Preview[Preview]\n  Preview --> Close[Close]\n  Close --> Read';
    h.patchHistory(ids.regular, { messages: [message('chart', '```mermaid\n' + diagram + '\n```')] });
    const page = await h.open(), block = page.locator('.mermaid-block');
    await page.waitForFunction(() => document.querySelector('.mermaid-block')?.dataset.diagramState === 'ready');
    evidence.state = await block.getAttribute('data-diagram-state');
    const toggle = block.locator('.diagram-source-toggle'); await toggle.click();
    assert.equal(await block.locator('pre').textContent(), diagram); await toggle.click();
    const opener = block.locator('.diagram-preview'); await opener.click();
    const viewer = page.locator('dialog[data-diagram-viewer]'); await viewer.waitFor();
    await page.waitForFunction(() => { const e = document.querySelector('dialog[data-diagram-viewer] img'); return e?.complete && e.naturalWidth > 0; });
    await page.keyboard.press('Escape'); await viewer.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.conversation-live').count(), 1);
    await page.waitForFunction(() => document.activeElement?.matches('.diagram-preview'));
    h.patchHistory(ids.regular, { messages: [message('chart', '```mermaid\nflowchart TD\n  A -->\n```')] }); await refresh(page);
    await page.waitForFunction(() => document.querySelector('.mermaid-block')?.dataset.diagramState === 'invalid');
    assert.match(await block.locator('pre').textContent(), /A -->/);
    evidence.invalidState = await block.getAttribute('data-diagram-state');
    const retry = block.locator('.diagram-actions button:not(.copy-button)').first(); await retry.click();
    await page.waitForFunction(() => document.querySelector('.mermaid-block')?.dataset.diagramState === 'invalid');
    assert.ok(await page.locator('.conversation-messages').evaluate(e => e.scrollWidth <= e.clientWidth + 1));
  }, { launch: localBlobLaunch(engine) });
}

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
import { syntheticPng, imageSha256 } from './helpers/synthetic-png.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_IMAGE_GALLERY_REPORT || '.local/qa/browser-image-gallery/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const rowId = 'synthetic-gallery';
const sources = Object.fromEntries(['a', 'b', 'd'].map(key => [key, `/api/tasks/${ids.regular}/images/${key.repeat(64)}`]));
const attachmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
sources.c = `/api/tasks/${ids.regular}/attachments/${attachmentId}`;
const paths = { a: '/synthetic/first.png', b: '/synthetic/second.png', d: '/synthetic/other.png' };
const png = syntheticPng();
const attachment = { id: attachmentId, name: 'Third synthetic image.png', size: png.length, mime: 'image/png', kind: 'image', sha256: imageSha256(png), url: sources.c, previewUrl: sources.c + '?preview=1', previewSha256: imageSha256(png), previewMime: 'image/png', previewSize: png.length };
const message = (id, text, extra = {}) => ({ id, role: 'assistant', phase: 'final', text, turnId: 'gallery-turn', timestamp: Date.now(), ...extra });
const imageText = (key, name) => `![${name}](<${paths[key]}>)`;
const gallery = (extra = {}) => message(rowId, `Synthetic ordered gallery.\n\n${imageText('a', 'First image')}\n\n${imageText('b', 'Second image')}`,
  { images: { [paths.a]: sources.a, [paths.b]: sources.b }, attachments: [attachment], ...extra });
const other = () => message('other-gallery-message', imageText('d', 'Other message image'), { images: { [paths.d]: sources.d } });
const install = (h, messages = [gallery(), other()]) => {
  h.patchHistory(ids.regular, { messages }); h.patchTranscript(ids.regular, { messages });
};
const viewer = page => page.locator('dialog[data-image-viewer]');
const row = page => page.locator(`[data-message-id="${rowId}"]`);
const words = locale => locale === 'en-US' ? { previous: 'Previous image', next: 'Next image', retry: 'Reload image' }
  : { previous: '上一张图片', next: '下一张图片', retry: '重新加载图片' };
async function ready(page) {
  await page.waitForFunction(() => { const image = document.querySelector('dialog[data-image-viewer] img');
    return image?.complete && image.naturalWidth === 1200 && image.style.visibility === 'visible'; }, undefined, { timeout: 2000 });
}
async function position(page, index, total = 3) {
  await viewer(page).locator('.image-viewer-counter').waitFor({ timeout: 1500 });
  await page.waitForFunction(({ index, total }) => document.querySelector('.image-viewer-counter')?.textContent === `${index} / ${total}`, { index, total }, { timeout: 1500 });
}
async function sameDialog(page) { assert.equal(await viewer(page).evaluate(element => element === window.galleryDialog), true, 'Navigation retains the open native dialog'); }
async function openGallery(page, index = 1) {
  const opener = index === 2 ? row(page).locator('.attachment-card') : row(page).locator('.message-image-frame[aria-haspopup="dialog"]').nth(index);
  await opener.click(); await viewer(page).waitFor();
  await viewer(page).evaluate(element => { window.galleryDialog = element; });
  return opener;
}
async function start(h, { media } = {}) {
  const page = await h.open(null), reads = [];
  await page.route(/^blob:https:\/\/pocket\.test\//, route => route.continue());
  await page.route(/\/api\/tasks\/[^/]+\/(?:images\/[a-f0-9]{64}|attachments\/[a-f0-9-]{36})(?:\?.*)?$/, async route => {
    const url = new URL(route.request().url()), key = Object.keys(sources).find(key => sources[key] === url.pathname);
    reads.push({ key, type: route.request().resourceType(), path: url.pathname, query: url.search });
    if (!key) throw new Error('Unknown synthetic gallery image');
    if (media && await media({ route, key, reads, url })) return;
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cache-Control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: png });
  });
  await page.goto(page.url() + '&task=' + ids.regular); await row(page).waitFor();
  return { page, reads };
}
async function pointer(page, { target = '.image-viewer-stage', dx = -90, dy = 0, end = 'pointerup', pinch = false } = {}) {
  return page.locator(target).evaluate((element, { dx, dy, end, pinch }) => {
    const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
    const fire = (type, pointerId, clientX, clientY) => {
      const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: pointerId === 1, pointerId, button: 0, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, clientX, clientY });
      element.dispatchEvent(event); return event.defaultPrevented;
    };
    fire('pointerdown', 1, x, y);
    if (pinch) { fire('pointerdown', 2, x + 80, y); fire('pointermove', 2, x + 150, y); fire('pointerup', 2, x + 150, y); }
    const prevented = fire('pointermove', 1, x + dx, y + dy); fire(end, 1, x + dx, y + dy);
    return prevented;
  }, { dx, dy, end, pinch });
}
function flow(engine, locale, width, name, run) {
  test(`${engine}: ${locale} ${width}px ${name}`, { timeout: 22000 }, () => {
    const evidence = {};
    return runScenario({ engine, name: `${locale} ${width}px ${name}`, create: () => createHarness(engine, { locale, width }),
      run: h => run(h, evidence), record: result => results.push({ ...result, evidence }) });
  });
}

for (const engine of engines) {
  flow(engine, 'en-US', 320, 'body and attachment order opens the second image with translated accessible controls', async (h, evidence) => {
    install(h); const { page, reads } = await start(h); await openGallery(page); await position(page, 2); await ready(page);
    assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), sources.b);
    const labels = words('en-US');
    assert.equal(await viewer(page).getByRole('button', { name: labels.previous, exact: true }).count(), 1);
    assert.equal(await viewer(page).getByRole('button', { name: labels.next, exact: true }).count(), 1);
    await viewer(page).getByRole('button', { name: labels.next, exact: true }).click(); await position(page, 3); await ready(page); await sameDialog(page);
    assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), sources.c, 'The original image attachment follows the two body images');
    assert.ok(reads.some(read => read.path === sources.c && !read.query), 'Viewer loads the original attachment rather than its thumbnail');
    evidence.geometry = await viewer(page).locator('.image-viewer-previous,.image-viewer-next,.image-viewer-close,.image-viewer-counter').evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { width: box.width, height: box.height, left: box.left, right: box.right }; }));
    for (const box of evidence.geometry) assert.ok(box.height >= 44 && box.left >= 0 && box.right <= 320, JSON.stringify(box));
  });

  flow(engine, 'zh-CN', 390, 'buttons and arrow keys stop at the first and last image without looping', async h => {
    install(h); const { page } = await start(h); await openGallery(page); await position(page, 2);
    await viewer(page).getByRole('button', { name: words('zh-CN').previous, exact: true }).click(); await position(page, 1); await sameDialog(page);
    assert.equal(await viewer(page).locator('.image-viewer-previous').isDisabled(), true);
    await page.keyboard.press('ArrowLeft'); await position(page, 1);
    await pointer(page, { dx: 90 }); await position(page, 1);
    await page.keyboard.press('ArrowRight'); await position(page, 2); await page.keyboard.press('ArrowRight'); await position(page, 3);
    assert.equal(await viewer(page).locator('.image-viewer-next').isDisabled(), true);
    await page.keyboard.press('ArrowRight'); await pointer(page); await position(page, 3); await sameDialog(page);
    await page.keyboard.press('Shift+ArrowLeft'); await position(page, 3);
  });

  flow(engine, 'zh-CN', 390, 'clear swipe navigates once while zoomed pan stays on the image until reset', async h => {
    install(h); const { page } = await start(h); await openGallery(page, 0); await position(page, 1); await ready(page);
    assert.equal(await pointer(page, { dx: -47 }), true); await position(page, 1);
    await pointer(page, { dx: -80, dy: 70 }); await position(page, 1);
    await pointer(page); await position(page, 2); await ready(page); await sameDialog(page);
    await viewer(page).locator('.image-viewer-zoom button').last().click();
    await page.waitForFunction(() => Number(document.querySelector('dialog[data-image-viewer] img')?.getAttribute('data-scale')) > 1);
    const before = await viewer(page).locator('img').getAttribute('style'); await pointer(page);
    await position(page, 2); assert.ok(Number(await viewer(page).locator('img').getAttribute('data-scale')) > 1);
    await page.waitForFunction(before => document.querySelector('dialog[data-image-viewer] img')?.getAttribute('style') !== before, before, { timeout: 1500 });
    assert.notEqual(await viewer(page).locator('img').getAttribute('style'), before, 'The zoomed image actually pans');
    await viewer(page).locator('.image-viewer-reset').click(); await pointer(page); await position(page, 3); await sameDialog(page);
    assert.equal(Number(await viewer(page).locator('img').getAttribute('data-scale')), 1);
  });

  flow(engine, 'en-US', 320, 'pinch, cancellation and capture loss keep the gallery open without navigation', async h => {
    install(h); const { page } = await start(h); await openGallery(page); await position(page, 2); await ready(page);
    for (const end of ['pointercancel', 'lostpointercapture']) { await pointer(page, { end }); await position(page, 2); await sameDialog(page); }
    await pointer(page, { pinch: true }); await position(page, 2); await sameDialog(page);
    assert.ok(Number(await viewer(page).locator('img').getAttribute('data-scale')) > 1);
    await viewer(page).locator('.image-viewer-reset').click(); await pointer(page, { dx: 90 }); await position(page, 1);
  });

  flow(engine, 'en-US', 320, 'a loading image can be swiped away and its late error cannot fail the next image', async (h, evidence) => {
    install(h); let release, held = false; const gate = new Promise(done => { release = done; });
    const { page, reads } = await start(h, { media: async ({ route, key, url }) => {
      // The attachment preview and original have distinct URLs. Browsers can
      // otherwise share an already-decoded inline image with the viewer,
      // without issuing the second HTTP request needed to hold this load.
      if (key === 'c' && !url.search) {
        held = true; await gate; try { await route.fulfill({ status: 503, contentType: 'image/png', body: '' }); } catch { /* Replaced images may abort their native read. */ } return true;
      } return false;
    } });
    try {
      await openGallery(page, 2); await position(page, 3); await viewer(page).locator('.image-viewer-message [role="status"]').waitFor({ timeout: 1500 });
      const deadline = Date.now() + 1500;
      while (!held && Date.now() < deadline) await page.waitForTimeout(20);
      assert.equal(held, true); assert.equal(await viewer(page).locator('img').count(), 0, 'The loading capability has no image node before its bounded Blob read completes');
      evidence.loadingReads = reads.filter(read => read.key === 'c');
      await pointer(page, { target: '.image-viewer-message p', dx: 90 }); await position(page, 2); await ready(page); await sameDialog(page);
      release(); await page.waitForTimeout(120);
      assert.equal(await viewer(page).locator('[role="alert"]').count(), 0); await ready(page); evidence.oldErrorIgnored = true;
    } finally { release(); }
  });

  flow(engine, 'zh-CN', 390, 'failed inline images remain gallery members and viewer failure text swipes while Retry stays a control', async h => {
    install(h); let retryReads = 0;
    const { page } = await start(h, { media: async ({ route, key }) => {
      if (key !== 'b') return false; retryReads++;
      await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'ged' }, body: JSON.stringify({ error: 'Synthetic unavailable image' }) }); return true;
    } });
    await row(page).locator('.message-image-failed').waitFor(); await openGallery(page, 0); await position(page, 1);
    await page.keyboard.press('ArrowRight'); await viewer(page).locator('[role="alert"]').waitFor();
    assert.equal(await viewer(page).getAttribute('data-gallery-requested-index'), '1');
    await position(page, 1);
    assert.equal(await viewer(page).locator('img[data-image-viewer-current]').getAttribute('data-registered-source'), sources.a, 'A failed candidate keeps the last decoded picture and its own count');
    assert.equal(await row(page).locator('.message-image').count(), 2, 'The failed inline registration survives replacement of its button');
    const before = retryReads; await pointer(page, { target: '.image-viewer-message button' }); await position(page, 1);
    assert.equal(await viewer(page).getAttribute('data-gallery-requested-index'), '1');
    assert.equal(retryReads, before, 'A control drag is neither navigation nor an explicit Retry click');
    await pointer(page, { target: '.image-viewer-message p' }); await position(page, 3); await ready(page); await sameDialog(page);
  });

  flow(engine, 'en-US', 320, 'duplicate references share a gallery item while an adjacent single-image message stays independent', async h => {
    const doubled = gallery({ text: `${imageText('a', 'First image')}\n\n${imageText('a', 'Repeated first image')}\n\n${imageText('b', 'Second image')}` });
    install(h, [doubled, other()]); const { page } = await start(h);
    await row(page).locator('.message-image-frame[aria-haspopup="dialog"]').nth(1).click(); await position(page, 1); await page.keyboard.press('ArrowRight'); await position(page, 2);
    assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), sources.b);
    await page.keyboard.press('Escape'); await viewer(page).waitFor({ state: 'detached' });
    await page.locator('[data-message-id="other-gallery-message"] .message-image-frame').click(); await ready(page);
    assert.equal(await viewer(page).locator('.image-viewer-counter,.image-viewer-next,.image-viewer-previous').count(), 0);
    await pointer(page); assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), sources.d);
  });

  flow(engine, 'zh-CN', 390, 'Mermaid remains a standalone diagram even alongside a message gallery', async h => {
    const diagram = message('standalone-diagram', '```mermaid\nflowchart LR\nA[Start] --> B[Finish]\n```');
    install(h, [gallery(), diagram]); const { page } = await start(h);
    const trigger = page.locator('.diagram-preview'); await trigger.scrollIntoViewIfNeeded(); await trigger.waitFor({ timeout: 5000 }); await trigger.click();
    assert.equal(await viewer(page).getAttribute('data-diagram-viewer'), 'true');
    assert.equal(await viewer(page).locator('.image-viewer-counter,.image-viewer-next,.image-viewer-previous').count(), 0);
    const src = await viewer(page).locator('img').getAttribute('src'); await page.keyboard.press('ArrowRight'); await pointer(page);
    assert.equal(await viewer(page).locator('img').getAttribute('src'), src); await page.keyboard.press('Escape'); await viewer(page).waitFor({ state: 'detached' });
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
  });

  flow(engine, 'en-US', 320, 'source-card reconciliation leaves the open gallery snapshot and dialog intact', async (h, evidence) => {
    install(h); const { page } = await start(h); await openGallery(page); await position(page, 2); await ready(page);
    const changed = [gallery({ text: 'Updated source card without the original inline images.', images: {}, attachments: [] }), other()];
    install(h, changed); await refresh(page);
    await row(page).getByText('Updated source card without the original inline images.', { exact: true }).waitFor();
    assert.equal(await row(page).locator('.message-image,.attachment-card').count(), 0);
    await sameDialog(page); await position(page, 2); await page.keyboard.press('ArrowRight'); await position(page, 3); await ready(page);
    assert.equal(await viewer(page).locator('img').getAttribute('data-registered-source'), sources.c); evidence.snapshotRetained = true;
  });

  flow(engine, 'zh-CN', 390, 'close and conversation switching preserve scroll root, draft, composition and opener focus', async (h, evidence) => {
    const preceding = Array.from({ length: 12 }, (_, index) => message('gallery-prefix-' + index, `Synthetic earlier reading paragraph ${index}. `.repeat(8)));
    install(h, [...preceding, gallery(), other()]); const { page } = await start(h);
    const input = page.locator('.conversation-composer textarea'), opener = row(page).locator('.message-image-frame[aria-haspopup="dialog"]').nth(1);
    await input.fill('Unsent gallery draft'); await input.evaluate(element => { window.galleryInput = element; element.setSelectionRange(2, 8);
      window.galleryCompositionEnds = 0; element.addEventListener('compositionend', () => window.galleryCompositionEnds++);
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' })); });
    await opener.scrollIntoViewIfNeeded(); await page.waitForTimeout(180);
    const scroll = await page.locator('.conversation-messages').evaluate(element => { window.galleryScrollRoot = element; return element.scrollTop; });
    await opener.click(); await position(page, 2); await page.keyboard.press('ArrowRight'); await position(page, 3); await page.keyboard.press('Escape'); await viewer(page).waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
    assert.equal(await input.evaluate(element => element === window.galleryInput && element.selectionStart === 2 && element.selectionEnd === 8), true);
    assert.equal(await input.inputValue(), 'Unsent gallery draft'); assert.equal(await page.evaluate(() => window.galleryCompositionEnds), 0);
    assert.equal(await page.locator('.conversation-messages').evaluate(element => element === window.galleryScrollRoot), true);
    assert.ok(Math.abs(await page.locator('.conversation-messages').evaluate(element => element.scrollTop) - scroll) <= 2);
    await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })));
    await opener.click(); await position(page, 2);
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('pocket-open-task', { detail: id })), ids.empty);
    await viewer(page).waitFor({ state: 'detached' }); await page.locator('.inspector-title-trigger').filter({ hasText: '合成空会话' }).waitFor();
    await page.evaluate(id => window.dispatchEvent(new CustomEvent('pocket-open-task', { detail: id })), ids.regular);
    await page.waitForFunction(() => document.querySelector('.conversation-composer textarea')?.value === 'Unsent gallery draft');
    assert.equal(await viewer(page).count(), 0); assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'), 'No original messages, archive operations or owner controls are issued');
    evidence.returnedScroll = scroll; evidence.syntheticCompositionEnds = 1;
  });
}

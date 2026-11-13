import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
import { syntheticPng } from './helpers/synthetic-png.mjs';

const results = [], sources = Object.fromEntries(['a', 'b', 'c'].map(key => [key, `/api/tasks/${ids.regular}/images/${key.repeat(64)}`]));
const paths = Object.fromEntries(['a', 'b', 'c'].map(key => [key, `/synthetic/motion-${key}.png`]));
const pngs = { a: syntheticPng(), b: syntheticPng({ width: 900, height: 1600 }), c: syntheticPng({ width: 1600, height: 900 }) };
const rowId = 'synthetic-motion-gallery';
const viewer = page => page.locator('dialog[data-image-viewer]');
const current = page => viewer(page).locator('img[data-image-viewer-current]');
const row = page => page.locator(`[data-message-id="${rowId}"]`);
const image = (key, alt) => `![${alt}](${paths[key]})`;
const install = h => {
  const message = { id: rowId, role: 'assistant', phase: 'final', turnId: 'motion-turn', timestamp: Date.now(),
    text: [image('a', 'First image'), image('b', 'Second image'), image('c', 'Third image')].join('\n\n'),
    images: Object.fromEntries(Object.entries(paths).map(([key, path]) => [path, sources[key]])) };
  h.patchHistory(ids.regular, { messages: [message] }); h.patchTranscript(ids.regular, { messages: [message] });
};
async function start(h, handler) {
  await h.addInitScript(() => {
    const animate = Element.prototype.animate;
    window.imageMotionCalls = [];
    Element.prototype.animate = function(frames, options) {
      const animation = animate.call(this, frames, options);
      if (this.classList.contains('image-viewer-canvas')) {
        const call = { frames, options, cancelled: false, finished: false }; window.imageMotionCalls.push(call);
        animation.addEventListener('cancel', () => { call.cancelled = true; });
        animation.addEventListener('finish', () => { call.finished = true; });
      }
      return animation;
    };
  });
  const page = await h.open(null); const reads = [];
  await page.route(/^blob:https:\/\/pocket\.test\//, route => route.continue());
  await page.route(/\/api\/tasks\/[^/]+\/images\/[a-f0-9]{64}$/, async route => {
    const path = new URL(route.request().url()).pathname, key = Object.keys(sources).find(key => sources[key] === path);
    if (!key) throw new Error('Unknown synthetic motion image');
    reads.push(key);
    if (handler && await handler(route, key)) return;
    await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'X-Pocket-Machine': 'ged' }, body: pngs[key] });
  });
  await page.goto(page.url() + '&task=' + ids.regular); await row(page).waitFor();
  return { page, reads };
}
async function shown(page, key, index) {
  await page.waitForFunction(({ key, index }) => {
    const dialog = document.querySelector('dialog[data-image-viewer]'), image = dialog?.querySelector('img[data-image-viewer-current]');
    return image?.getAttribute('data-registered-source') === key && image.complete && image.naturalWidth > 0 && image.style.visibility === 'visible'
      && dialog.getAttribute('data-gallery-index') === String(index);
  }, { key: sources[key], index }, { timeout: 4000 });
}
async function open(page) {
  const trigger = row(page).locator('.message-image-frame[aria-haspopup="dialog"]').first();
  await trigger.click(); await viewer(page).waitFor(); await shown(page, 'a', 0);
  await viewer(page).evaluate(element => { window.originalMotionDialog = element; }); return trigger;
}
async function retained(page, key = 'a') {
  assert.equal(await current(page).getAttribute('data-registered-source'), sources[key]);
  assert.equal(await current(page).evaluate(element => element.complete && element.naturalWidth > 0 && element.style.visibility === 'visible'), true);
  assert.equal(await viewer(page).evaluate(element => element === window.originalMotionDialog), true);
}
function flow(engine, name, run, options = { width: 390, locale: 'en-US' }) {
  test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine, options), run, record: result => results.push(result) }));
}
after(() => {
  const path = resolve(process.env.POCKET_IMAGE_VIEWER_MOTION_REPORT || '.local/qa/image-viewer-motion-2026-11-13/browser.json');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ passed: results.length > 0 && results.every(result => result.passed), scenarios: results }, null, 2) + '\n');
});
for (const engine of engines) {
  flow(engine, 'returning to an already displayed picture cancels a pending next load without a permanent loading notice', async h => {
    install(h); let release; const gate = new Promise(done => { release = done; });
    const { page } = await start(h, async (route, key) => {
      if (key !== 'b') return false; await gate;
      try { await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'X-Pocket-Machine': 'ged' }, body: pngs.b }); } catch {} return true;
    });
    try {
      await open(page); await viewer(page).locator('.image-viewer-next').click();
      await viewer(page).locator('.image-viewer-message [role="status"]').waitFor();
      assert.equal(await viewer(page).getAttribute('data-gallery-requested-index'), '1');
      await viewer(page).locator('.image-viewer-previous').click(); await shown(page, 'a', 0);
      assert.equal(await viewer(page).getAttribute('data-gallery-requested-index'), '0');
      await page.waitForFunction(() => !document.querySelector('dialog[data-image-viewer] .image-viewer-message'), undefined, { timeout: 1000 });
      assert.equal(await viewer(page).getAttribute('aria-label'), 'View Image: First image');
      release(); await page.waitForTimeout(200); await retained(page);
      assert.equal(await viewer(page).locator('.image-viewer-message').count(), 0);
    } finally { release(); }
  });
  flow(engine, 'weak network retains the decoded current picture and caption until the next picture is decoded', async h => {
    install(h); let release; const gate = new Promise(done => { release = done; });
    const { page } = await start(h, async (route, key) => {
      if (key !== 'b') return false; await gate;
      try { await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'X-Pocket-Machine': 'ged' }, body: pngs.b }); } catch {} return true;
    });
    try {
      await open(page); await viewer(page).locator('.image-viewer-next').click(); await viewer(page).locator('[role="status"]').filter({ hasText: 'Loading image' }).waitFor();
      await page.waitForTimeout(200); await retained(page);
      assert.equal(await viewer(page).getAttribute('aria-label'), 'View Image: First image');
      assert.equal(await viewer(page).locator('.image-viewer-counter').textContent(), '1 / 3');
      release(); await shown(page, 'b', 1); assert.equal(await viewer(page).getAttribute('aria-label'), 'View Image: Second image');
      assert.equal(await current(page).evaluate(element => element.naturalHeight), 1600);
      const calls = await page.evaluate(() => window.imageMotionCalls);
      assert.ok(calls.some(call => call.options.duration === 180));
      assert.ok(calls.some(call => call.options.duration === 180 && call.frames[0].transform?.includes('10px')));
      await retained(page, 'b');
    } finally { release(); }
  });
  flow(engine, 'zoom during a slow next picture takes over and late data cannot replace the picture being inspected', async h => {
    install(h); let release; const gate = new Promise(done => { release = done; });
    const { page } = await start(h, async (route, key) => {
      if (key !== 'b') return false; await gate;
      try { await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'X-Pocket-Machine': 'ged' }, body: pngs.b }); } catch {} return true;
    });
    try {
      await open(page); await viewer(page).locator('.image-viewer-next').click();
      await viewer(page).getByRole('button', { name: 'Zoom in Image', exact: true }).click();
      assert.ok(Number(await current(page).getAttribute('data-scale')) > 1);
      assert.equal(await viewer(page).getAttribute('data-gallery-requested-index'), '0');
      assert.equal(await viewer(page).locator('.image-viewer-canvas').getAttribute('data-image-motion'), null);
      release(); await page.waitForTimeout(250); await retained(page); assert.equal(await viewer(page).getAttribute('aria-label'), 'View Image: First image');
    } finally { release(); }
  });
  flow(engine, 'late decode from a superseded gallery request never overwrites the current picture or its label', async h => {
    install(h);
    await h.addInitScript(source => {
      const decode = HTMLImageElement.prototype.decode;
      window.releaseOldViewerDecode = [];
      HTMLImageElement.prototype.decode = function() {
        const decoded = decode.call(this);
        if (this.getAttribute('data-registered-source') !== source || !this.hasAttribute('data-image-viewer-candidate')) return decoded;
        return decoded.then(() => new Promise(done => { window.releaseOldViewerDecode.push(done); }));
      };
    }, sources.b);
    const { page } = await start(h); await open(page); await viewer(page).locator('.image-viewer-next').click();
    await page.waitForFunction(() => window.releaseOldViewerDecode.length > 0); await retained(page);
    await viewer(page).locator('.image-viewer-next').click(); await shown(page, 'c', 2);
    await page.evaluate(() => window.releaseOldViewerDecode.forEach(done => done())); await page.waitForTimeout(100);
    await retained(page, 'c'); assert.equal(await viewer(page).getAttribute('aria-label'), 'View Image: Third image');
  });
  flow(engine, 'reduced motion cuts immediately, changing preference cancels, and close keeps the original opener focus', async h => {
    install(h); const { page } = await start(h); await page.emulateMedia({ reducedMotion: 'reduce' });
    const opener = await open(page); await viewer(page).locator('.image-viewer-next').click(); await shown(page, 'b', 1);
    assert.deepEqual(await page.evaluate(() => window.imageMotionCalls), []);
    await page.emulateMedia({ reducedMotion: 'no-preference' }); await viewer(page).locator('.image-viewer-previous').click(); await shown(page, 'a', 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches && window.imageMotionCalls.at(-1)?.cancelled, undefined, { timeout: 1000 });
    assert.equal(await viewer(page).locator('.image-viewer-canvas').getAttribute('data-image-motion'), null);
    await page.keyboard.press('Escape'); await viewer(page).waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
    assert.equal(await page.evaluate(() => document.querySelector('dialog[data-image-viewer]')), null);
  }, { width: 320, locale: 'en-US' });
  flow(engine, 'a failed candidate keeps the current picture, and Retry loads only the candidate before a successful replacement', async h => {
    install(h); let allowed = false;
    const { page, reads } = await start(h, async (route, key) => {
      if (key !== 'b' || allowed) return false;
      await route.fulfill({ status: 503, contentType: 'application/json', headers: { 'X-Pocket-Machine': 'ged' }, body: JSON.stringify({ error: 'Synthetic next-image failure' }) }); return true;
    });
    await open(page); await viewer(page).locator('.image-viewer-next').click(); await viewer(page).locator('[role="alert"]').waitFor();
    await retained(page); assert.equal(await viewer(page).locator('.image-viewer-counter').textContent(), '1 / 3');
    const before = reads.filter(key => key === 'b').length; allowed = true;
    await viewer(page).getByRole('button', { name: 'Reload image', exact: true }).click(); await shown(page, 'b', 1);
    assert.ok(reads.filter(key => key === 'b').length > before); await retained(page, 'b');
    assert.equal(await viewer(page).locator('[role="alert"]').count(), 0);
    assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'));
  }, { width: 320, locale: 'en-US' });
}

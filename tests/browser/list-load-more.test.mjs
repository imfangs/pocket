import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_LIST_MORE_REPORT || '.local/qa/browser-list-more/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});

async function directoryHarness(engine, options = {}) {
  let harness;
  const now = Date.now(), directoryCalls = [];
  const threadId = index => index === 0 ? ids.regular : `a7600000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
  const rows = () => Array.from({ length: 240 }, (_, index) => ({
    ...harness.metadata(ids.regular), id: threadId(index), title: `合成会话 ${String(index).padStart(3, '0')}`,
    createdAt: now - 3600000 - index * 1000, updatedAt: now - index * 1000, lastMessageAt: now - index * 1000,
    projectId: index < 120 ? 'fixture-a' : 'fixture-b', projectName: index < 120 ? '合成项目 A' : '合成项目 B',
    pocketPriority: index < 120, codexPinned: false, pinned: false, hasUnreadTurn: false, needsInput: false,
    runtime: 'idle', pocketContent: { ...harness.metadata(ids.regular).pocketContent,
      messageId: index === 0 ? harness.metadata(ids.regular).pocketContent.messageId : null },
  }));
  const launch = async options => {
    const browser = await ({ chromium, webkit })[engine].launch(options), newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options), register = context.route.bind(context);
      context.route = (pattern, handler) => register(pattern, async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== 'https://pocket.test') return handler(route);
        const path = url.pathname.replace(/^\/api\/machines\/ged\//, '/api/');
        const respond = body => route.fulfill({ status: 200, contentType: 'application/json',
          headers: { 'cache-control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: JSON.stringify(body) });
        if (path === '/api/catalog' && request.method() === 'GET' || path === '/api/sync' && request.method() === 'POST') {
          directoryCalls.push({ method: request.method(), action: path, at: Date.now() });
          return respond({ threads: rows(), groups: [], projects: ['a', 'b'].map((id, index) => ({
            id: `fixture-${id}`, name: `合成项目 ${id.toUpperCase()}`, paths: ['/synthetic'], order: index, separator: false,
          })), sourceInfo: { syncedAt: now, active: 240, archived: 0, total: 240,
            scope: 'synthetic', pocketRead: { available: true, scope: 'smoke-ged' } },
          sourceError: null, csrfToken: 'synthetic-token' });
        }
        if (path === '/api/task-statuses' && request.method() === 'GET') {
          directoryCalls.push({ method: 'GET', action: path, at: Date.now() });
          return respond({ available: true, checkedAt: Date.now(), states: rows().map(row => ({
            threadId: row.id, status: 'idle', checkedAt: Date.now(),
          })) });
        }
        const target = /^\/api\/tasks\/(a7600000-0000-4000-8000-\d{12})\/(transcript|history)$/.exec(path);
        if (target && request.method() === 'GET') {
          directoryCalls.push({ method: 'GET', action: target[2], at: Date.now() });
          return respond({ source: 'rollout', runtime: 'idle', canSend: false, canQueue: false,
            canAttemptSend: false, hint: '', messages: [], checkedAt: Date.now(), hasMore: false,
            outbox: [], pendingRequests: [], asyncQuestions: [], latestTurnId: null, latestTurnStatus: 'completed',
            activeTurnId: null, pocketContent: rows().find(row => row.id === target[1])?.pocketContent });
        }
        return handler(route);
      });
      return context;
    };
    return browser;
  };
  harness = await createHarness(engine, { ...options, launch });
  return Object.assign(harness, { directoryCalls });
}

const panel = page => page.locator('.list-panel');
const count = page => page.locator('.task-select[data-thread-id]').count();
async function untilCount(page, expected) {
  await page.waitForFunction(expected => document.querySelectorAll('.task-select[data-thread-id]').length === expected,
    expected, { timeout: 5000 });
}
async function sortBy(page, mode) {
  await page.locator('.thread-sort-trigger').click();
  await page.locator(`.thread-sort-menu [data-sort-choice="${mode}"]`).click();
  await page.locator('.thread-sort-menu').waitFor({ state: 'detached' });
  await page.waitForTimeout(150);
}
async function selectScope(page, scope) {
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.locator(`.sidebar [data-view="${scope}"]`).click();
  await page.locator('.sidebar.mobile-open').waitFor({ state: 'detached' });
  await page.waitForTimeout(150);
}
async function bottom(page) {
  await panel(page).evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(180);
}
const visibleAnchor = (root, id) => {
  const viewport = root.getBoundingClientRect();
  const row = [...root.querySelectorAll('.task-select[data-thread-id]')].find(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && (id ? node.dataset.threadId === id : rect.bottom > viewport.top && rect.top < viewport.bottom);
  });
  return { id: row?.dataset.threadId, offset: row ? row.getBoundingClientRect().top - viewport.top : null, top: root.scrollTop };
};
async function gesture(page, dx = 0, dy = -65) {
  await panel(page).evaluate(async (element, { dx, dy }) => {
    const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + Math.min(220, box.height / 2);
    for (const [type, progress] of [['touchstart', 0], ['touchmove', .5], ['touchmove', 1], ['touchend', 1]]) {
      const touch = { identifier: 71, target: element, clientX: x + dx * progress, clientY: y + dy * progress };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [touch] }, changedTouches: { value: [touch] } });
      element.dispatchEvent(event);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }, { dx, dy });
}
const readonly = h => {
  assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'), 'No owner, message or preference mutation');
  assert.ok(h.directoryCalls.every(call => call.method === 'GET' || call.action === '/api/sync'));
};
function flow(engine, name, run, options = {}) {
  test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
    create: () => directoryHarness(engine, options), run, record: result => results.push({ ...result,
      inputBoundary: name.includes('wheel burst') ? engine === 'webkit'
        ? 'Desktop WebKit native wheel at a responsive 390px viewport' : 'Chromium native wheel in mobile layout'
        : 'Mobile-layout synthetic touch and browser keyboard' }) }));
}

for (const engine of engines) {
  flow(engine, 'a newer scroll after manual append was requested takes over before React commits the next batch', async h => {
    const page = await h.open(null); await untilCount(page, 80); await bottom(page);
    await panel(page).evaluate(element => {
      window.appendCommitPanel = element;
      // React's root handler requests the larger window first. This later
      // native listener changes the reader before that render can commit.
      document.querySelector('#root').addEventListener('click', () => {
        const rows = element.querySelectorAll('.task-select[data-thread-id]').length;
        element.scrollTop = Math.max(0, element.scrollTop - 200);
        const top = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll('.task-select[data-thread-id]')].find(node => node.getBoundingClientRect().bottom > top);
        window.appendBeforeCommit = { rows, top: element.scrollTop, id: row.dataset.threadId,
          offset: row.getBoundingClientRect().top - top };
      }, { once: true });
    });
    await page.locator('.load-more').evaluate(button => button.click());
    await untilCount(page, 160); await page.waitForTimeout(220);
    const geometry = await panel(page).evaluate(element => {
      const before = window.appendBeforeCommit;
      const row = [...element.querySelectorAll('.task-select[data-thread-id]')].find(node => node.dataset.threadId === before.id);
      return { before, top: element.scrollTop, offset: row.getBoundingClientRect().top - element.getBoundingClientRect().top,
        samePanel: element === window.appendCommitPanel };
    });
    assert.equal(geometry.before.rows, 80, 'The newer reading choice happened before any row was appended');
    assert.ok(Math.abs(geometry.top - geometry.before.top) <= 1, 'A pre-append anchor cannot replay over newer scrolling');
    assert.ok(Math.abs(geometry.offset - geometry.before.offset) <= 2, 'The newly chosen row retains its viewport offset');
    assert.equal(geometry.samePanel, true); readonly(h);
  });

  flow(engine, 'a slow wheel burst reaches the boundary even when its first events are farther away', async h => {
    const page = await h.open(null);
    if (engine === 'webkit') await page.setViewportSize({ width: 390, height: 844 });
    await untilCount(page, 80); await sortBy(page, 'created');
    await panel(page).evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 450; });
    await page.waitForTimeout(180);
    const box = await panel(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let index = 0; index < 6; index++) {
      await page.mouse.wheel(0, 90); await page.waitForTimeout(150);
    }
    await untilCount(page, 160); await page.waitForTimeout(300);
    assert.equal(await count(page), 160, 'A slow approach still appends one batch when it actually reaches the bottom threshold');
    readonly(h);
  }, { width: engine === 'webkit' ? 768 : 390 });

  flow(engine, 'one downward wheel burst consumes one batch and the next burst can reach the end', async h => {
    const page = await h.open(null);
    // Native wheel is unavailable in Playwright's mobile WebKit context. Keep
    // this one desktop input case responsive at the same phone layout width.
    if (engine === 'webkit') await page.setViewportSize({ width: 390, height: 844 });
    await untilCount(page, 80); await sortBy(page, 'created'); await bottom(page);
    const box = await panel(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // Keep sending the same native wheel burst even if its first event adds
    // content. Programmatic bottom positions alone must not rearm that burst.
    for (let index = 0; index < 5; index++) {
      await panel(page).evaluate(element => { element.scrollTop = element.scrollHeight; });
      await page.mouse.wheel(0, 180); await page.waitForTimeout(45);
    }
    await untilCount(page, 160); await page.waitForTimeout(350);
    assert.equal(await count(page), 160, 'One continuous wheel input cannot consume all remaining batches');
    await bottom(page); await page.waitForTimeout(400);
    await page.mouse.wheel(0, 180); await untilCount(page, 240);
    readonly(h);
  }, { width: engine === 'webkit' ? 768 : 390 });

  flow(engine, 'a deliberate upward bottom gesture appends one local batch and preserves the visible reader', async h => {
    const page = await h.open(null); await untilCount(page, 80); await sortBy(page, 'created');
    await panel(page).evaluate(element => { window.loadMorePanel = element; });
    await bottom(page); await refresh(page); await page.waitForTimeout(350);
    assert.equal(await count(page), 80, 'Entry, programmatic position restoration and refresh cannot consume a batch');
    const before = await panel(page).evaluate(visibleAnchor), reads = h.directoryCalls.filter(call => ['/api/catalog', '/api/sync'].includes(call.action)).length;
    await gesture(page); await untilCount(page, 160); await page.waitForTimeout(250);
    const after = await panel(page).evaluate(visibleAnchor, before.id);
    assert.equal(after.id, before.id); assert.ok(Math.abs(after.offset - before.offset) <= 2, 'The already readable row stays at its viewport offset');
    assert.equal(await panel(page).evaluate(element => element === window.loadMorePanel), true);
    assert.equal(h.directoryCalls.filter(call => ['/api/catalog', '/api/sync'].includes(call.action)).length, reads, 'Appending already loaded rows requires no new directory request');
    await bottom(page); await page.waitForTimeout(350);
    assert.equal(await count(page), 160, 'The first gesture cannot chain into all remaining rows');
    await gesture(page); await untilCount(page, 240);
    assert.equal(await page.locator('.load-more').count(), 0, 'There is no more trigger after all rows are shown');
    readonly(h);
  });

  flow(engine, 'keyboard more remains usable and view/sort limits return to their own scopes', async h => {
    const page = await h.open(null); await untilCount(page, 80); await sortBy(page, 'created');
    await bottom(page); await page.locator('.load-more').focus(); await page.keyboard.press('Enter'); await untilCount(page, 160);
    assert.equal(await page.locator('.load-more').evaluate(element => element === document.activeElement), true, 'Manual keyboard focus remains on its persistent fallback');
    await sortBy(page, 'activity'); await untilCount(page, 80);
    await sortBy(page, 'created'); await untilCount(page, 160);
    await selectScope(page, 'priority'); await untilCount(page, 80);
    await bottom(page); await page.locator('.load-more').focus(); await page.keyboard.press('Enter'); await untilCount(page, 120);
    await selectScope(page, 'all'); await untilCount(page, 160);
    readonly(h);
  });

  flow(engine, 'the inert detail backdrop and horizontal motion cannot load list rows', async h => {
    const page = await h.open(null); await untilCount(page, 80); await sortBy(page, 'created');
    await page.locator(`[data-thread-id="${ids.regular}"]`).click(); await page.locator('.conversation-live').waitFor();
    assert.equal(await panel(page).evaluate(element => element.inert), true);
    await bottom(page); await gesture(page); await page.waitForTimeout(650);
    assert.equal(await count(page), 80, 'Background list is inactive while the detail owns the page');
    await page.locator('[data-inspector-close]').click(); await page.locator('.inspector').waitFor({ state: 'detached' });
    await page.waitForTimeout(350); assert.equal(await count(page), 80, 'Returning from detail cannot replay the blocked gesture');
    await bottom(page); await gesture(page, -90, -5); await page.waitForTimeout(500);
    assert.equal(await count(page), 80, 'A row-oriented horizontal gesture is not a bottom-load gesture');
    await gesture(page); await untilCount(page, 160); readonly(h);
  });

  flow(engine, 'selected list text blocks automatic loading until a fresh reading gesture', async h => {
    const page = await h.open(null); await untilCount(page, 80); await sortBy(page, 'created'); await bottom(page);
    await panel(page).evaluate(element => {
      const row = [...element.querySelectorAll('.task-select[data-thread-id]')].at(-1), range = document.createRange();
      range.selectNodeContents(row); const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await gesture(page); await page.waitForTimeout(600);
    assert.equal(await count(page), 80, 'An active selection owns the visible text');
    await page.evaluate(() => document.getSelection().removeAllRanges()); await page.waitForTimeout(350);
    assert.equal(await count(page), 80, 'Clearing selection alone cannot replay an old load intent');
    await gesture(page); await untilCount(page, 160); readonly(h);
  });
}

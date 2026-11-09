import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
test.after(() => {
  if (process.env.POCKET_NAVIGATION_REPORT) writeFileSync(process.env.POCKET_NAVIGATION_REPORT, JSON.stringify(results, null, 2) + '\n');
});
const row = (page, id) => page.locator(`.task-select[data-thread-id="${id}"]`);
const waitCount = (page, count) => page.waitForFunction(count => document.querySelector('.workspace-count')?.textContent === String(count), count);
const focusRow = (page, id) => page.waitForFunction(id => document.activeElement?.matches(`.task-select[data-thread-id="${id}"]`), id, { timeout: 2000 });
const menu = page => page.locator('.thread-sort-menu[role="menu"]');
async function sortBy(page, mode) {
  await page.locator('.thread-sort-trigger').click();
  await menu(page).locator(`[data-sort-choice="${mode}"]`).click();
  await menu(page).waitFor({ state: 'detached' });
}
async function navigation(page, selector) {
  await page.locator('.workspace-header .mobile-only').click();
  await page.locator('.sidebar.mobile-open').waitFor();
  await page.locator(`.sidebar ${selector}`).click();
  await page.locator('.sidebar.mobile-open').waitFor({ state: 'detached' });
}
const projectName = '同名的长项目 A project with a very long title';
const projects = [
  { id: 'fixture', name: projectName, paths: ['/synthetic/one/shared'], order: 0, separator: false },
  { id: 'second', name: projectName, paths: ['/synthetic/two/shared'], order: 1, separator: false },
  { id: 'vacant', name: 'Empty Project', paths: ['/synthetic/empty'], order: 2, separator: false },
];

// Extend only this page's synthetic directory. Other calls fall back to the
// existing fixture, whose allowlist continues to block all external traffic.
// Extra rows also get synthetic read-only history, never a native API route.
async function directory(page, h, threads, runtimes = new Map(), projectRows = projects) {
  const calls = [];
  let catalogTick = Date.now();
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data;
    if ((request.method() === 'GET' && path.endsWith('/catalog')) || (request.method() === 'POST' && path.endsWith('/sync'))) {
      data = { threads, projects: projectRows, groups: [], sourceInfo: { syncedAt: ++catalogTick,
        active: threads.filter(thread => !thread.archived).length, total: threads.length, archived: 0,
        scope: 'synthetic', pocketRead: { available: true, scope: 'smoke-ged' } }, sourceError: null, csrfToken: 'synthetic-token' };
    } else if (request.method() === 'GET' && path.endsWith('/task-statuses')) {
      data = { available: true, checkedAt: Date.now(), states: threads.map(thread => ({ threadId: thread.id,
        status: runtimes.get(thread.id) || 'idle', checkedAt: Date.now() })) };
    } else {
      const task = /\/tasks\/([^/]+)\/(history|transcript)$/.exec(path);
      const thread = task && threads.find(thread => thread.id === task[1]);
      if (request.method() === 'GET' && thread && !Object.values(ids).includes(thread.id)) {
        data = { source: 'rollout', resumeState: 'resumed', runtime: 'idle', canSend: false, canQueue: false,
          canAttemptSend: false, messages: [], checkedAt: Date.now(), hasMore: false, pocketContent: thread.pocketContent,
          pendingRequests: [], asyncQuestions: [], outbox: [], latestTurnId: null, latestTurnStatus: 'completed' };
      } else return route.fallback();
    }
    calls.push({ method: request.method(), path });
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store', 'X-Pocket-Machine': 'ged' }, body: JSON.stringify(data) });
  });
  await refresh(page);
  return calls;
}
function pair(h) {
  return [
    { ...h.metadata(ids.regular), title: 'Release readiness common prefix — unique-end-regular 会话', projectName, cwd: '/synthetic/one/shared' },
    { ...h.metadata(ids.empty), title: 'Release readiness common prefix — unique-end-empty 会话', projectId: 'second', projectName,
      cwd: '/synthetic/two/shared', createdAt: Date.now() - 7200000 },
  ];
}
const readonlyCalls = (h, extra = []) => {
  assert.ok([...h.calls, ...extra].filter(call => call.method !== 'GET').every(call => call.path.endsWith('/sync')));
};
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Expected synthetic catalog request did not arrive');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) {
  const flow = (name, options, run) => test(`${engine}/${locale}: ${name}`, { timeout: 45000 }, () => runScenario({ engine,
    name: `${locale}: ${name}`, create: () => createHarness(engine, { width: 320, locale, ...options }), run,
    record: result => results.push(result) }));

  flow('project search expands with keyboard focus, then returns with query and sort intact', {}, async h => {
    const page = await h.open(null), threads = pair(h);
    const calls = await directory(page, h, threads);
    await row(page, ids.regular).filter({ hasText: 'unique-end-regular' }).waitFor();
    await navigation(page, '[data-project-id="fixture"]');
    await sortBy(page, 'created');
    await page.locator('.search-toggle').click();
    const input = page.locator('.search-box input');
    await input.fill('unique-end-empty');
    await waitCount(page, 0);
    const action = page.locator('.empty-list-actions button');
    assert.match(await action.textContent(), /在全部会话搜索|Search all conversations/);
    await action.focus(); await action.press('Enter');
    await waitCount(page, 1); await row(page, ids.empty).waitFor();
    assert.equal(await input.inputValue(), 'unique-end-empty');
    assert.equal(await page.locator('.thread-sort-trigger').getAttribute('data-sort-mode'), 'created');
    await focusRow(page, ids.empty);
    await page.keyboard.press('Enter'); await page.locator('.inspector').waitFor();
    await page.locator('[data-inspector-close]').press('Enter');
    await page.locator('.inspector').waitFor({ state: 'detached' }); await focusRow(page, ids.empty);
    assert.equal(await input.inputValue(), 'unique-end-empty');
    // A pointer return keeps neutral list focus rather than a keyboard row ring.
    await row(page, ids.empty).tap();
    await page.locator('.inspector').waitFor();
    await page.locator('[data-inspector-close]').tap();
    await page.locator('.inspector').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.matches('.task-list-surface'));
    assert.equal(await input.inputValue(), 'unique-end-empty');
    await input.focus(); await input.press('Escape');
    await page.locator('.search-box').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.search-toggle').evaluate(node => node === document.activeElement), true);
    await waitCount(page, 2);
    // Re-select the empty native project and recover through its keyboard CTA.
    await navigation(page, '[data-project-id="vacant"]'); await waitCount(page, 0);
    await action.focus(); await action.press('Enter'); await waitCount(page, 2);
    await focusRow(page, ids.regular);
    readonlyCalls(h, calls);
  });

  flow('a running result ends, empty-filter recovery keeps the project and sort', { visibility: true }, async h => {
    const page = await h.open(null), threads = pair(h), runtimes = new Map([[ids.regular, 'running']]);
    const calls = await directory(page, h, threads, runtimes);
    await row(page, ids.regular).filter({ hasText: 'unique-end-regular' }).waitFor();
    await navigation(page, '[data-project-id="fixture"]'); await sortBy(page, 'activity');
    await page.locator('.running-toggle small').filter({ hasText: '1' }).waitFor();
    await page.locator('.running-toggle').click(); await waitCount(page, 1);
    runtimes.set(ids.regular, 'idle'); h.setRuntime(ids.regular, 'idle'); await refresh(page);
    await waitCount(page, 0);
    const action = page.locator('.empty-list-actions button');
    assert.match(await action.textContent(), /取消运行筛选|Clear running filter/);
    await action.focus(); await action.press('Enter');
    await waitCount(page, 1); await focusRow(page, ids.regular);
    assert.equal(await page.locator('.workspace-title').textContent(), projectName);
    assert.equal(await page.locator('.thread-sort-trigger').getAttribute('data-sort-mode'), 'activity');
    assert.equal(await page.locator('.running-toggle').getAttribute('aria-pressed'), 'false');
    readonlyCalls(h, calls);
  });

  flow('delayed search expansion resumes focus only while its query, scope and input intent remain current', {}, async h => {
    for (const intent of ['wait', 'focus', 'search', 'scope']) {
      const page = await h.open(null), threads = pair(h);
      const calls = await directory(page, h, threads);
      await row(page, ids.regular).filter({ hasText: 'unique-end-regular' }).waitFor();
      await navigation(page, '[data-project-id="fixture"]');
      await page.locator('.search-toggle').click(); const input = page.locator('.search-box input');
      await input.fill('arrival'); await waitCount(page, 0);
      let waiting = false, release;
      const gate = new Promise(done => { release = done; });
      // Override this one page's catalog reads with a delayed fresh snapshot.
      // The real navigation action triggers /api/sync; no DOM state is injected.
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (!path.endsWith('/sync') && !path.endsWith('/catalog')) return route.fallback();
        waiting = true; await gate;
        await route.fallback();
      });
      const action = page.locator('.empty-list-actions button'); await action.focus(); await action.press('Enter');
      await until(() => waiting);
      assert.equal(await input.inputValue(), 'arrival'); assert.equal(await page.locator('.task-select').count(), 0);
      if (intent === 'focus') await input.focus();
      if (intent === 'search') { await input.focus(); await input.fill('unique-end-regular'); }
      if (intent === 'scope') {
        await navigation(page, '[data-project-id="second"]');
        // Sidebar's return-focus effect runs after its DOM closes. Record the
        // settled newer focus, rather than its transient closing-dialog focus.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => { window.expandedNavigationNewFocus = document.activeElement; });
      }
      threads[1].title = 'arrival'; threads[1].titleRevision = 1;
      const response = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/sync') && response.status() === 200);
      release(); await response;
      if (intent === 'wait') {
        await row(page, ids.empty).filter({ hasText: 'arrival' }).waitFor(); await focusRow(page, ids.empty);
        assert.equal(await input.inputValue(), 'arrival');
      } else if (intent === 'focus') {
        await row(page, ids.empty).filter({ hasText: 'arrival' }).waitFor();
        assert.equal(await input.inputValue(), 'arrival');
        assert.equal(await input.evaluate(node => node === document.activeElement), true);
      } else if (intent === 'search') {
        await row(page, ids.regular).waitFor(); await page.waitForTimeout(100);
        assert.equal(await input.inputValue(), 'unique-end-regular');
        assert.equal(await input.evaluate(node => node === document.activeElement), true);
        assert.equal(await row(page, ids.empty).count(), 0);
      } else {
        await row(page, ids.empty).filter({ hasText: 'arrival' }).waitFor();
        assert.equal(await page.locator('.sidebar [data-project-id="second"]').getAttribute('aria-current'), 'page');
        assert.equal(await page.locator('.search-box').count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement === window.expandedNavigationNewFocus), true);
      }
      readonlyCalls(h, calls); await page.close();
    }
    readonlyCalls(h);
  });

  flow('keyboard hide failure retries once, then search finds and restores the hidden row', { visibility: true }, async h => {
    const page = await h.open(null);
    await sortBy(page, 'created');
    const swipe = page.locator(`[data-swipe-row-id="${ids.regular}"]`);
    h.failNextHidden();
    const shortcut = swipe.locator('.row-hidden-shortcut');
    await shortcut.focus(); await shortcut.press('Enter');
    await swipe.getByRole('alert').waitFor();
    const retry = swipe.locator('.row-hidden-action');
    await page.waitForFunction(id => document.activeElement === document.querySelector(`[data-swipe-row-id="${id}"] .row-hidden-action`), ids.regular);
    assert.equal(h.metadata().pocketHidden, false);
    assert.equal(await retry.isEnabled(), true);
    await retry.press('Enter');
    await swipe.waitFor({ state: 'detached' }); await focusRow(page, ids.empty);
    assert.equal(h.metadata().pocketHidden, true); assert.equal(h.count('hidden'), 2);
    await navigation(page, '[data-view="hidden"]');
    await page.locator('.search-toggle').click(); const input = page.locator('.search-box input');
    await input.fill('unfindable'); await waitCount(page, 0);
    const clear = page.locator('.empty-list-actions button'); await clear.focus(); await clear.press('Enter');
    await row(page, ids.regular).waitFor();
    await focusRow(page, ids.regular);
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.locator('.thread-sort-trigger').getAttribute('data-sort-mode'), 'created');
    await shortcut.focus(); await shortcut.press('Enter'); await swipe.waitFor({ state: 'detached' });
    assert.equal(await page.locator('.task-list-surface').evaluate(node => node === document.activeElement), true);
    await navigation(page, '[data-view="all"]'); await row(page, ids.regular).waitFor();
    assert.equal(h.metadata().pocketHidden, false);
    assert.deepEqual(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').map(call => [call.action, call.hidden]),
      [['hidden', true], ['hidden', true], ['hidden', false]]);
  });

  flow('real large counts, pagination and renamed duplicate projects preserve identity', {}, async h => {
    const page = await h.open(null), now = Date.now(), base = h.metadata(ids.regular), runtime = new Map();
    const threads = Array.from({ length: 160 }, (_, index) => ({ ...base,
      id: index === 0 ? ids.regular : `a7200000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      title: `合成 Release ${String(index).padStart(3, '0')} — long common title unique ${index}`,
      projectId: index < 80 ? 'fixture' : 'second', projectName, cwd: index < 80 ? '/synthetic/one/shared' : '/synthetic/two/shared',
      hasUnreadTurn: true, needsInput: true, pocketHidden: false, pocketPriority: false, codexPinned: false, pinned: false,
      pocketContent: { ...base.pocketContent, revision: base.pocketContent.revision + 1, version: 'b'.repeat(64), messageId: 'expanded-last' },
      createdAt: now - 3600000 - index * 1000, updatedAt: now - index * 1000, lastMessageAt: now - index * 1000,
    }));
    for (const thread of threads.slice(128)) runtime.set(thread.id, 'running');
    const projectRows = projects.map(project => ({ ...project }));
    const calls = await directory(page, h, threads, runtime, projectRows);
    await waitCount(page, 160);
    await page.locator('.unread-toggle small').filter({ hasText: /^128$/ }).waitFor();
    await page.locator('.running-toggle small').filter({ hasText: /^32$/ }).waitFor();
    await sortBy(page, 'created');
    const geometry = await page.locator('.activity-filters').evaluate(node => {
      const box = node.getBoundingClientRect();
      return { client: node.clientWidth, scroll: node.scrollWidth, viewport: innerWidth, page: document.documentElement.scrollWidth,
        children: [...node.children].map(child => { const b = child.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width, height: b.height, top: b.top }; }),
        right: box.right };
    });
    assert.ok(geometry.scroll <= geometry.client + 1 && geometry.page <= geometry.viewport + 1, JSON.stringify(geometry));
    assert.ok(geometry.children.every(b => b.width >= 44 && b.height >= 44 && b.right <= geometry.right + 1));
    assert.equal(await page.locator('.task-select').count(), 80);
    await page.locator('.load-more').click();
    assert.equal(await page.locator('.task-select').count(), 160);
    await page.locator('.running-toggle').click(); await waitCount(page, 32);
    assert.equal(await page.locator('.task-select').count(), 32);
    await page.locator('.running-toggle').click(); await page.locator('.unread-toggle').click(); await waitCount(page, 128);
    await page.locator('.search-toggle').click();
    await page.locator('.search-box input').fill('Ｒｅｌｅａｓｅ １２７');
    await waitCount(page, 1); assert.equal(await row(page, threads[127].id).count(), 1);
    await page.locator('.search-box input').press('Escape');
    await page.locator('.unread-toggle').click();
    await page.locator('.workspace-header .mobile-only').click();
    const first = page.locator('.sidebar [data-project-id="fixture"]'), second = page.locator('.sidebar [data-project-id="second"]');
    assert.equal(await first.locator('.sidebar-project-suffix').textContent(), 'one/shared');
    assert.equal(await second.locator('.sidebar-project-suffix').textContent(), 'two/shared');
    assert.notEqual(await first.getAttribute('aria-label'), await second.getAttribute('aria-label'));
    await first.click(); await waitCount(page, 80);
    projectRows[0].name = 'Renamed native project'; for (const thread of threads.slice(0, 80)) thread.projectName = projectRows[0].name;
    await refresh(page);
    await page.waitForFunction(() => document.querySelector('.workspace-title')?.textContent === 'Renamed native project');
    await waitCount(page, 80);
    await page.locator('.workspace-header .mobile-only').click();
    assert.equal(await first.getAttribute('aria-current'), 'page');
    assert.equal(await first.locator('.sidebar-project-suffix').count(), 0);
    assert.equal(await second.locator('.sidebar-project-suffix').count(), 0);
    await page.keyboard.press('Escape');
    readonlyCalls(h, calls);
  });
}

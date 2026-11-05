import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, engines, ids } from './fixture.mjs';

const trigger = page => page.locator('.thread-sort-trigger');
const menu = page => page.locator('.thread-sort-menu[role="menu"]');
const iconClass = { smart: 'lucide-sparkles', created: 'lucide-calendar-plus', activity: 'lucide-history' };
const modeText = { 'zh-CN': { smart: '智能', created: '创建', activity: '活动' }, en: { smart: 'Smart', created: 'Created', activity: 'Activity' } };
const assertIcon = async (page, mode) => {
  assert.equal(await trigger(page).locator(`svg.${iconClass[mode]}`).count(), 1);
  assert.equal(await trigger(page).locator('svg').getAttribute('width'), '18');
  assert.equal(await trigger(page).locator('svg').getAttribute('aria-hidden'), 'true');
  const locale = await page.locator('html').getAttribute('lang');
  assert.equal(await trigger(page).locator('.thread-sort-current').textContent(), modeText[locale][mode]);
};
const select = async (page, mode) => {
  await trigger(page).click(); await menu(page).waitFor();
  await menu(page).locator(`[data-sort-choice="${mode}"]`).click();
  await menu(page).waitFor({ state: 'detached' });
  await page.waitForFunction(mode => document.querySelector('.thread-sort-trigger')?.getAttribute('data-sort-mode') === mode, mode);
  await assertIcon(page, mode);
};

for (const engine of engines) {
  test(`${engine}: sort menu selections keep filters and search, remain checked, and persist`, { timeout: 30000 }, async () => {
    for (const locale of ['zh-CN', 'en-US']) {
      const h = await createHarness(engine, { locale, width: 320, visibility: true });
      try {
        const page = await h.open(null);
        await assertIcon(page, 'smart');
        await page.locator('.running-toggle small').filter({ hasText: '1' }).waitFor();
        await page.locator('.search-toggle').click();
        await page.locator('.search-box input').fill('ged');
        await select(page, 'created');
        assert.equal(await page.locator('.search-box input').inputValue(), 'ged');
        await trigger(page).click();
        assert.equal(await menu(page).locator('[data-sort-choice="created"]').getAttribute('aria-checked'), 'true');
        const mark = await menu(page).locator('[data-sort-choice="created"]').evaluate(node => {
          const label = node.querySelector('.thread-sort-label').getBoundingClientRect();
          const check = node.querySelector('.rt-DropdownMenuItemIndicator svg').getBoundingClientRect();
          const row = node.getBoundingClientRect();
          return { labelLeft: label.left, checkLeft: check.left, checkRight: check.right, rowLeft: row.left, rowRight: row.right };
        });
        assert.ok(mark.checkRight <= mark.labelLeft && mark.checkLeft >= mark.rowLeft && mark.checkRight <= mark.rowRight, 'The check mark and label must remain separate');
        assert.equal(await menu(page).getByRole('menuitemradio').count(), 3);
        await menu(page).locator('[data-sort-choice="created"]').click();
        await menu(page).waitFor({ state: 'detached' });
        assert.equal(await trigger(page).getAttribute('data-sort-mode'), 'created');
        await assertIcon(page, 'created');
        await page.locator('.running-toggle').click();
        await select(page, 'activity');
        assert.equal(await page.locator('.running-toggle').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.search-box input').inputValue(), 'ged');
        await page.locator('.priority-toggle').click();
        const scopeTitle = await page.locator('.workspace-title').textContent();
        await select(page, 'smart');
        assert.equal(await page.locator('.priority-toggle').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.running-toggle').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.workspace-title').textContent(), scopeTitle);
        await select(page, 'created');
        await page.reload(); await trigger(page).waitFor();
        assert.equal(await trigger(page).getAttribute('data-sort-mode'), 'created');
        await assertIcon(page, 'created');
        assert.equal(await page.locator('.priority-toggle').getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('.running-toggle').getAttribute('aria-pressed'), 'true');
        assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'));
      } finally { await h.close(); }
    }
  });

  test(`${engine}: keyboard menu focus and unchanged selection preserve an open desktop conversation`, { timeout: 30000 }, async () => {
    const h = await createHarness(engine, { locale: 'en-US', width: 1280 });
    try {
      const page = await h.open(ids.regular);
      const input = page.locator('.conversation-composer textarea');
      await input.fill('Keep this conversation and its draft.');
      await input.evaluate(node => { window.sortDraftInput = node; });
      await trigger(page).click(); await menu(page).waitFor();
      const selectedMode = await trigger(page).getAttribute('data-sort-mode');
      await menu(page).locator(`[data-sort-choice="${selectedMode}"]`).click();
      await menu(page).waitFor({ state: 'detached' });
      assert.equal(await page.locator('.inspector').count(), 1);
      assert.equal(await input.inputValue(), 'Keep this conversation and its draft.');
      assert.equal(await input.evaluate(node => node === window.sortDraftInput), true);
      await trigger(page).focus(); await trigger(page).press('Enter');
      await menu(page).waitFor(); await page.keyboard.press('Escape');
      await menu(page).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement === document.querySelector('.thread-sort-trigger'));
      await trigger(page).press('Enter'); await menu(page).waitFor();
      await page.waitForFunction(() => document.activeElement?.closest('.thread-sort-menu'));
      await page.keyboard.press('End');
      await page.waitForFunction(() => document.activeElement?.getAttribute('data-sort-choice') === 'activity');
      await page.keyboard.press('Enter'); await menu(page).waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('.thread-sort-trigger')?.getAttribute('data-sort-mode') === 'activity');
      assert.equal(await page.locator('.inspector').count(), 1);
      assert.equal(await input.inputValue(), 'Keep this conversation and its draft.');
      assert.equal(await input.evaluate(node => node === window.sortDraftInput), true);
      assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'));
    } finally { await h.close(); }
  });

  test(`${engine}: visible sort semantics fit one title row in both phone languages`, { timeout: 60000 }, async () => {
    for (const locale of ['zh-CN', 'en-US']) for (const width of [320, 390]) {
      const h = await createHarness(engine, { locale, width });
      try {
        const page = await h.open(null);
        const measure = async () => page.evaluate(() => {
          const header = document.querySelector('.heading-line');
          const sort = header.querySelector('.thread-sort-trigger');
          const create = header.querySelector('.new-conversation-button');
          const label = sort.querySelector('.thread-sort-current');
          const box = node => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
          const range = document.createRange(); range.selectNodeContents(label);
          return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
            header: box(header), sort: box(sort), create: box(create), label: box(label),
            textWidth: range.getBoundingClientRect().width, display: getComputedStyle(label).display,
            labelHidden: label.hidden, labelOpacity: getComputedStyle(label).opacity,
            hit: sort.contains(document.elementFromPoint(box(sort).left + box(sort).width / 2, box(sort).top + box(sort).height / 2)) };
        });
        for (const mode of ['smart', 'created', 'activity']) {
          if (mode !== 'smart') await select(page, mode);
          const boxes = await measure();
          assert.ok(boxes.pageWidth <= boxes.viewport + 1, JSON.stringify(boxes));
          assert.ok(boxes.sort.width >= 44 && boxes.sort.height >= 44 && boxes.create.width >= 44 && boxes.create.height >= 44);
          assert.ok(boxes.sort.right <= boxes.create.left + 1, 'Sort must not cover Create');
          assert.ok(Math.abs((boxes.sort.top + boxes.sort.bottom - boxes.create.top - boxes.create.bottom) / 2) <= 1, 'Sort and Create stay in one title row');
          assert.ok(boxes.header.height <= 45 && boxes.create.right <= boxes.viewport + 1);
          assert.ok(boxes.display !== 'none' && !boxes.labelHidden && Number(boxes.labelOpacity) > 0 && boxes.label.width >= boxes.textWidth - 1);
          assert.equal(boxes.hit, true);
        }
        // Stress the title's existing ellipsis slot without replacing any
        // controls or extending the synthetic API contract.
        await page.locator('.workspace-title').evaluate(node => { node.textContent = 'A project with a very long name / 含有很长名称的项目和持续跟踪的会话'; });
        const stressed = await measure();
        assert.ok(stressed.header.height <= 45 && stressed.pageWidth <= stressed.viewport + 1);
        assert.ok(stressed.sort.right <= stressed.create.left + 1 && stressed.create.right <= stressed.viewport + 1);
        assert.ok(await page.locator('.workspace-title').evaluate(node => getComputedStyle(node).textOverflow === 'ellipsis'));
        assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
      } finally { await h.close(); }
    }
  });
}

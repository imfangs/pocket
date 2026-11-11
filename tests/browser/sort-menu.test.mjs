import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHarness, engines, ids } from './fixture.mjs';

const measurements = [];
test.after(() => {
  if (process.env.POCKET_FILTER_ROW_REPORT) writeFileSync(process.env.POCKET_FILTER_ROW_REPORT, JSON.stringify(measurements, null, 2) + '\n');
});

const trigger = page => page.locator('.thread-sort-trigger');
const menu = page => page.locator('.thread-sort-menu[role="menu"]');
const iconClass = { smart: 'lucide-sparkles', created: 'lucide-calendar-plus', activity: 'lucide-history' };
const modeText = { 'zh-CN': { smart: '智能', created: '创建', activity: '活动' }, en: { smart: 'Smart', created: 'Created', activity: 'Activity' } };
const assertIcon = async (page, mode) => {
  assert.equal(await trigger(page).locator(`svg.${iconClass[mode]}`).count(), 1);
  assert.equal(await trigger(page).locator('svg').getAttribute('width'), '16');
  assert.equal(await trigger(page).locator('svg').getAttribute('aria-hidden'), 'true');
  assert.equal(await trigger(page).locator('svg').getAttribute('stroke-width'), '1.75');
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

  test(`${engine}: four icon and label controls fit one phone row in both languages`, { timeout: 90000 }, async () => {
    for (const locale of ['zh-CN', 'en-US']) for (const width of [320, 390]) {
      const h = await createHarness(engine, { locale, width });
      try {
        const page = await h.open(null);
        await page.evaluate(() => document.fonts.ready);
        const measure = async () => { const boxes = await page.evaluate(() => {
          // Geometry pressure uses the existing count nodes, so it does not
          // invent API states or allow flex compression to count as a fit.
          document.querySelector('.unread-toggle small').textContent = '128';
          document.querySelector('.running-toggle small').textContent = '32';
          const header = document.querySelector('.heading-line');
          const row = document.querySelector('.activity-filters');
          const box = node => { const b = node.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
          const buttons = [...row.children].map(node => {
            const svg = node.querySelector('svg'), style = getComputedStyle(node);
            const labels = [...node.querySelectorAll('span,small')].map(label => {
              const range = document.createRange(); range.selectNodeContents(label);
              return { box: box(label), glyphs: box(range), display: getComputedStyle(label).display,
                opacity: Number(getComputedStyle(label).opacity), text: label.textContent };
            });
            const b = box(node);
            return { box: b, className: node.className, selected: node.getAttribute('aria-pressed'), labels, icon: box(svg), iconRole: svg.dataset.pocketIcon,
              iconStroke: svg.getAttribute('stroke-width'), fontSize: parseFloat(style.fontSize), shrink: style.flexShrink,
              hit: node.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)) };
          });
          return { viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, sortMode: row.querySelector('.thread-sort-trigger').dataset.sortMode,
            header: box(header), row: box(row), rowClientWidth: row.clientWidth, rowScrollWidth: row.scrollWidth,
            wrap: getComputedStyle(row).flexWrap, overflow: getComputedStyle(row).overflowX, buttons,
            search: box(header.querySelector('.search-toggle')), create: box(header.querySelector('.new-conversation-button')) };
        }); measurements.push({ engine, locale, width, build: h.build, ...boxes }); return boxes; };
        const assertRow = boxes => {
          assert.ok(boxes.pageWidth <= boxes.viewport + 1, JSON.stringify(boxes));
          assert.equal(boxes.wrap, 'nowrap'); assert.notEqual(boxes.overflow, 'scroll');
          assert.ok(boxes.rowScrollWidth <= boxes.rowClientWidth + 1, JSON.stringify(boxes));
          assert.equal(boxes.buttons.length, 4);
          assert.ok(boxes.buttons[0].className.includes('unread-toggle'));
          assert.ok(boxes.buttons[1].className.includes('running-toggle'));
          assert.ok(boxes.buttons[2].className.includes('priority-toggle'));
          assert.ok(boxes.buttons[3].className.includes('thread-sort-trigger'));
          for (const [index, button] of boxes.buttons.entries()) {
            assert.ok(button.box.width >= 44 && button.box.height >= 44, JSON.stringify(button));
            assert.equal(button.shrink, '0'); assert.ok(button.fontSize >= 12);
            assert.equal(button.iconRole, 'auxiliary'); assert.equal(button.iconStroke, '1.75');
            assert.ok(Math.abs(button.icon.width - 16) <= .1 && Math.abs(button.icon.height - 16) <= .1);
            assert.ok(button.box.left >= boxes.row.left - 1 && button.box.right <= boxes.row.right + 1, JSON.stringify(boxes));
            assert.ok(Math.abs(button.box.top - boxes.buttons[0].box.top) <= 1);
            if (index) assert.ok(boxes.buttons[index - 1].box.right <= button.box.left + 1);
            for (const label of button.labels) {
              assert.notEqual(label.display, 'none'); assert.ok(label.opacity > 0);
              assert.ok(label.glyphs.left >= label.box.left - 1 && label.glyphs.right <= label.box.right + 1, JSON.stringify(label));
              assert.ok(label.glyphs.top >= label.box.top - 1 && label.glyphs.bottom <= label.box.bottom + 1, JSON.stringify(label));
              assert.ok(label.box.left >= button.box.left - 1 && label.box.right <= button.box.right + 1);
            }
            assert.equal(button.hit, true);
          }
          assert.ok(boxes.search.width >= 44 && boxes.search.height >= 44 && boxes.create.width >= 44 && boxes.create.height >= 44);
          assert.ok(boxes.search.right <= boxes.create.left + 1 && boxes.create.right <= boxes.viewport + 1);
          assert.ok(Math.abs(boxes.search.top - boxes.create.top) <= 1);
          assert.ok(boxes.header.height <= 45 && boxes.row.height <= 45);
        };
        for (const mode of ['smart', 'created', 'activity']) {
          if (mode !== 'smart') await select(page, mode);
          assertRow(await measure());
          await page.locator('.unread-toggle').click(); await page.locator('.priority-toggle').click();
          assert.equal(await page.locator('.unread-toggle').getAttribute('aria-pressed'), 'true');
          assert.equal(await page.locator('.priority-toggle').getAttribute('aria-pressed'), 'true');
          assertRow(await measure());
          await page.locator('.running-toggle').click();
          assert.equal(await page.locator('.running-toggle').getAttribute('aria-pressed'), 'true');
          assertRow(await measure());
          await page.locator('.running-toggle').click(); await page.locator('.priority-toggle').click();
        }
        await page.locator('.workspace-title').evaluate(node => { node.textContent = 'A project with a very long name / 含有很长名称的项目和持续跟踪的会话'; });
        assertRow(await measure());
        assert.ok(await page.locator('.workspace-title').evaluate(node => getComputedStyle(node).textOverflow === 'ellipsis'));
        await page.locator('.priority-toggle').focus(); await page.keyboard.press('Tab');
        assert.equal(await trigger(page).evaluate(node => document.activeElement === node), true, 'Tab follows the visual row order');
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.locator('.priority-toggle').evaluate(node => document.activeElement === node), true);
        await page.locator('.search-toggle').click();
        assert.equal(await page.locator('.search-box input').evaluate(node => document.activeElement === node), true);
        assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
      } finally { await h.close(); }
    }
  });

  test(`${engine}: archived and hidden scopes retain sorting without activity chips`, { timeout: 30000 }, async () => {
    for (const locale of ['zh-CN', 'en-US']) {
      const h = await createHarness(engine, { locale, width: 320, archivedHidden: true });
      try {
        const page = await h.open(null);
        for (const scope of ['archived', 'hidden']) {
          await page.locator('.workspace-header .mobile-only').click();
          await page.locator(`.sidebar.mobile-open [data-view="${scope}"]`).click();
          await page.waitForFunction(() => !document.querySelector('.sidebar.mobile-open'));
          assert.equal(await page.locator('.activity-filters .needs-input-toggle').count(), 0);
          assert.equal(await page.locator('.activity-filters > .thread-sort-trigger').count(), 1);
          await select(page, 'created'); await select(page, 'activity'); await select(page, 'smart');
        }
        assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
      } finally { await h.close(); }
    }
  });
}

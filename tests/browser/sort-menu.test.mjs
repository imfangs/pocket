import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, engines, ids } from './fixture.mjs';

const trigger = page => page.locator('.thread-sort-trigger');
const menu = page => page.locator('.thread-sort-menu[role="menu"]');
const iconClass = { smart: 'lucide-arrow-down-wide-narrow', created: 'lucide-calendar-days', activity: 'lucide-clock3' };
const assertIcon = async (page, mode) => {
  assert.equal(await trigger(page).locator(`svg.${iconClass[mode]}`).count(), 1);
  assert.equal(await trigger(page).locator('svg').getAttribute('width'), '18');
  assert.equal(await trigger(page).locator('svg').getAttribute('aria-hidden'), 'true');
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
}

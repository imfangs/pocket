import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, engines, ids } from './fixture.mjs';

for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) for (const width of [320, 390, 1280]) {
  test(`${engine}: ${locale} ${width}px archive category and settings preserve navigation and focus`, { timeout: 30000 }, async () => {
    const h = await createHarness(engine, { locale, width, visibility: true, archivedHidden: true });
    try {
      const page = await h.open(null), mobile = width <= 760;
      const labels = locale === 'zh-CN'
        ? { archive: '已归档', settings: '设置', nav: '会话视图', close: '关闭导航' }
        : { archive: 'Archived', settings: 'Settings', nav: 'Conversation views', close: 'Close navigation' };
      const toggle = page.locator('.workspace-header .mobile-only');
      const sidebar = page.locator('.sidebar');
      const openSidebar = async () => {
        if (mobile) {
          await toggle.focus(); await toggle.press('Enter');
          await page.locator('.sidebar.mobile-open').waitFor();
          await page.waitForFunction(() => document.activeElement === document.querySelector('.sidebar'));
        }
      };
      await openSidebar();
      const nav = sidebar.getByRole('navigation', { name: labels.nav, exact: true });
      assert.deepEqual(await nav.locator('[data-view]').evaluateAll(nodes => nodes.map(node => node.dataset.view)),
        ['all', 'priority', 'codex-pinned', 'hidden', 'archived']);
      const archive = nav.locator('[data-view="archived"]');
      assert.equal(await archive.getAttribute('aria-label'), labels.archive);
      assert.equal(await archive.innerText(), labels.archive);
      assert.equal(await archive.locator('small').count(), 0);
      const settings = sidebar.locator('.sidebar-bottom .sidebar-settings');
      assert.equal(await sidebar.locator('.sidebar-bottom button').count(), 1);
      assert.equal(await settings.getAttribute('aria-label'), labels.settings);
      assert.equal(await settings.innerText(), labels.settings);
      for (const control of [archive, settings]) {
        const geometry = await control.evaluate(node => {
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height, overflow: node.scrollWidth > node.clientWidth };
        });
        assert.ok(geometry.width >= 44 && geometry.height >= 44, JSON.stringify(geometry));
        assert.equal(geometry.overflow, false);
      }
      if (mobile) {
        await page.keyboard.press('Shift+Tab');
        assert.equal(await settings.evaluate(node => node === document.activeElement), true, 'Settings remains the last focus target');
        await page.keyboard.press('Tab');
        assert.equal(await sidebar.getByRole('button', { name: labels.close, exact: true }).evaluate(node => node === document.activeElement), true);
      }
      const before = [h.metadata(ids.regular), h.metadata(ids.empty)];
      await archive.focus(); await page.keyboard.press('Enter');
      if (mobile) {
        await page.locator('.sidebar.mobile-open').waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement === document.querySelector('.workspace-header .mobile-only'));
      }
      assert.equal(await page.locator('.workspace-title').innerText(), labels.archive, 'The original category handler selects the archive scope');
      assert.deepEqual(await sidebar.locator('[aria-current="page"]').evaluateAll(nodes => nodes.map(node => node.dataset.view)), ['archived']);
      assert.deepEqual([h.metadata(ids.regular), h.metadata(ids.empty)], before, 'Selecting a category preserves synthetic thread metadata');
      await openSidebar();
      await settings.click();
      const dialog = page.locator('dialog.settings-dialog'); await dialog.waitFor();
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      if (mobile) {
        assert.equal(await page.locator('.sidebar.mobile-open').count(), 1, 'The existing settings action preserves the drawer');
        await page.keyboard.press('Escape');
        await page.locator('.sidebar.mobile-open').waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement === document.querySelector('.workspace-header .mobile-only'));
      }
      assert.equal(await page.locator('.workspace-title').innerText(), labels.archive);
      if (mobile) {
        // WebKit pointer clicks need not focus buttons. Preserve the actual
        // opener captured before React opens the drawer, while keyboard entry
        // above still requires returning to the navigation toggle.
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          document.addEventListener('click', event => {
            if (event.target instanceof Element && event.target.closest('.workspace-header .mobile-only'))
              window.sidebarPointerOpener = document.activeElement;
          }, { capture: true, once: true });
        });
        await toggle.click(); await page.locator('.sidebar.mobile-open').waitFor();
        await page.waitForFunction(() => document.activeElement === document.querySelector('.sidebar'));
        assert.equal(await page.evaluate(() => window.sidebarPointerOpener instanceof HTMLElement), true);
        await archive.focus(); await archive.press('Enter');
        await page.locator('.sidebar.mobile-open').waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement === window.sidebarPointerOpener);
        await page.evaluate(() => { delete window.sidebarPointerOpener; });
        assert.equal(await page.locator('.workspace-title').innerText(), labels.archive);
      }
      assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0, 'Navigation and opening settings perform no thread writes');
      assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
    } finally { await h.close(); }
  });
}

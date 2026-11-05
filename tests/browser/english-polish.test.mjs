import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, engines, ids } from './fixture.mjs';

const shape = async element => element.evaluate(node => {
  const box = node.getBoundingClientRect();
  const range = document.createRange(); range.selectNodeContents(node);
  const text = range.getBoundingClientRect();
  return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
    width: box.width, height: box.height, textLeft: text.left, textRight: text.right };
});
const fits = box => assert.ok(box.textLeft >= box.left - 1 && box.textRight <= box.right + 1, JSON.stringify(box));

for (const engine of engines) {
  test(`${engine}: English status text and one-row phone filters keep separate reading space`, { timeout: 30000 }, async () => {
    for (const width of [320, 390]) {
      const h = await createHarness(engine, { width, locale: 'en-US' });
      try {
        h.setRuntime(ids.regular, 'waiting_approval'); h.setRuntime(ids.empty, 'waiting_input');
        const page = await h.open(null);
        await page.locator('[data-state="waiting_approval"]').waitFor();
        const approval = page.locator('[data-thread-id]').filter({ has: page.locator('[data-state="waiting_approval"]') });
        fits(await shape(approval.locator('.row-status-slot')));
        fits(await shape(page.locator('[data-state="waiting_input"]').locator('..')));
        const controls = page.locator('.workspace-header');
        const first = await shape(controls.locator('.unread-toggle'));
        for (const selector of ['.running-toggle', '.priority-toggle']) {
          const box = await shape(controls.locator(selector));
          assert.ok(Math.abs(box.top - first.top) <= 1, `${width}: ${selector} moved to another filter row`);
          assert.ok(box.width >= 44 && box.height >= 44);
        }
        const sort = await shape(controls.locator('.thread-sort-trigger'));
        const search = await shape(controls.locator('.search-toggle'));
        const toolbar = await shape(controls.locator('.filter-row'));
        assert.ok(Math.abs(sort.top - first.top) <= 1, 'Sorting must stay in the activity row');
        assert.ok(sort.left >= (await shape(controls.locator('.priority-toggle'))).right - 1, 'Sorting follows the Follow control');
        assert.ok(sort.width >= 44 && sort.height >= 44);
        const create = await shape(controls.locator('.new-conversation-button'));
        assert.ok(search.right <= create.left + 1, 'Search stays before Create in the title bar');
        assert.ok(Math.abs(search.top - create.top) <= 1 && search.bottom <= first.top + 1);
        assert.ok(toolbar.height <= 45, 'The filters must not reserve a second row');
        assert.ok(await controls.locator('.search-toggle').evaluate(node => {
          const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return node.contains(hit);
        }));
        await controls.locator('.search-toggle').click();
        assert.equal(await page.locator('.search-box input').evaluate(node => document.activeElement === node), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      } finally { await h.close(); }
    }
  });

  test(`${engine}: English information and cache controls fit while Chinese count labels stay unchanged`, { timeout: 30000 }, async () => {
    const h = await createHarness(engine, { width: 320, locale: 'en-US' });
    try {
      const page = await h.open();
      await page.locator('.inspector-title-trigger').click();
      const info = page.locator('dialog[open]'); await info.waitFor();
      const archive = info.getByRole('button', { name: 'Archive', exact: true });
      fits(await shape(archive));
      const id = info.locator('dt').filter({ hasText: /^ID$/ }); fits(await shape(id));
      await page.keyboard.press('Escape'); await info.waitFor({ state: 'detached' });
      await page.locator('[data-inspector-close]').click();
      await page.locator('.inspector').waitFor({ state: 'detached' });
      await page.locator('.workspace-header .mobile-only').click();
      await page.locator('.sidebar.mobile-open .sidebar-settings').click();
      const settings = page.locator('dialog.settings-dialog'); await settings.waitFor();
      const cache = settings.locator('.reading-cache-setting select');
      assert.equal(await cache.locator('option:checked').textContent(), '128 (default)');
      fits(await shape(settings.locator('.reading-cache-setting label')));
      await settings.locator('.language-setting select').selectOption('zh-CN');
      assert.equal(await cache.locator('option:checked').textContent(), '128 个（默认）');
      assert.equal(await cache.locator('option[value="20"]').textContent(), '20 个');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    } finally { await h.close(); }
  });
}

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
// Keep this file's receipts separate from smoke.test.mjs, which owns the
// runner's main scenarios.json. TAP still fails the whole run on any failure.
const output = resolve(process.env.POCKET_BROWSER_REPORT || '.local/qa/browser-smoke/scenarios.json').replace(/\.json$/, '-i18n.json');
after(() => {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const settings = page => page.locator('dialog.settings-dialog');
const language = page => settings(page).locator('.language-setting select');
const openSettings = async page => {
  await page.locator('.workspace-header .mobile-only').click();
  await page.locator('.sidebar.mobile-open .sidebar-settings').click();
  await settings(page).waitFor();
};
const closeSettingsAndMenu = async page => {
  await page.keyboard.press('Escape');
  await settings(page).waitFor({ state: 'detached' });
  if (await page.locator('.sidebar.mobile-open').count()) await page.locator('.sidebar.mobile-open .brand > .icon-button').click();
  await page.locator('.sidebar.mobile-open').waitFor({ state: 'detached' });
};
const assertNarrowLayout = async page => {
  const layout = await page.evaluate(() => {
    const width = window.innerWidth;
    const selectors = ['.workspace-header', 'dialog.settings-dialog', '.language-setting', '.language-setting select'];
    return { width, pageWidth: document.documentElement.scrollWidth,
      boxes: selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(element => {
        const box = element.getBoundingClientRect(); return { selector, left: box.left, right: box.right, width: box.width };
      })) };
  });
  assert.equal(layout.width, 390);
  assert.ok(layout.pageWidth <= layout.width + 1, `Page width ${layout.pageWidth} exceeds ${layout.width}`);
  for (const box of layout.boxes) assert.ok(box.left >= -1 && box.right <= layout.width + 1 && box.width > 0, JSON.stringify(box));
};
const flow = (engine, name, options, run) => test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({
  engine, name, create: () => createHarness(engine, options), run, record: result => results.push(result),
}));

for (const engine of engines) {
  flow(engine, 'system English and saved language selection keep settings geometry and focus', { locale: 'en-US' }, async h => {
    const page = await h.open(null);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal(await page.locator('.workspace-title').textContent(), 'All');
    assert.match(await page.locator(`[data-thread-id="${ids.regular}"]`).textContent(), /ged 合成已有会话/);
    await openSettings(page);
    assert.equal(await settings(page).getAttribute('aria-label'), 'Settings');
    assert.equal(await page.locator('.sidebar [data-view="priority"] > span').textContent(), 'Following');
    assert.equal(await language(page).inputValue(), 'system');
    await assertNarrowLayout(page);
    await language(page).focus();
    await language(page).evaluate(element => { window.i18nSettingSelect = element; window.i18nSettingDialog = element.closest('dialog'); });
    await language(page).selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.equal(await settings(page).getAttribute('aria-label'), '设置');
    assert.equal(await language(page).evaluate(element => element === window.i18nSettingSelect && element.closest('dialog') === window.i18nSettingDialog && document.activeElement === element), true);
    assert.equal(await page.locator('.workspace-title').textContent(), '全部');
    await page.reload(); await page.locator('[data-thread-id]').first().waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    await openSettings(page); assert.equal(await language(page).inputValue(), 'zh-CN');
    await language(page).selectOption('system');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await settings(page).getAttribute('aria-label'), 'Settings');
    await assertNarrowLayout(page);
  });

  flow(engine, 'an English override and cross-tab changes preserve the new conversation draft', { locale: 'zh-CN' }, async h => {
    const page = await h.open(null);
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
    await openSettings(page); await language(page).selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await closeSettingsAndMenu(page);
    await page.locator('.new-conversation-button').click();
    const dialog = page.locator('dialog.new-conversation-dialog'), input = dialog.locator('#quick-create-query');
    await dialog.waitFor(); await input.fill('保留这个中文 Query，不应被自动翻译');
    await input.evaluate(element => { window.i18nCreationInput = element; window.i18nCreationDialog = element.closest('dialog'); });
    const other = await h.open(null);
    assert.equal(await other.locator('html').getAttribute('lang'), 'en');
    await openSettings(other); assert.equal(await language(other).inputValue(), 'en');
    await language(other).selectOption('zh-CN');
    await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
    assert.equal(await dialog.getAttribute('aria-label'), '新建会话');
    assert.equal(await input.evaluate(element => element === window.i18nCreationInput && element.closest('dialog') === window.i18nCreationDialog && document.activeElement === element), true);
    assert.equal(await input.inputValue(), '保留这个中文 Query，不应被自动翻译');
    await language(other).selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await dialog.getAttribute('aria-label'), 'New conversation');
    assert.equal(await input.inputValue(), '保留这个中文 Query，不应被自动翻译');
    assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
  });

  flow(engine, 'language changes preserve focused conversation input and authored Chinese messages', { locale: 'zh-CN' }, async h => {
    const page = await h.open(ids.regular);
    await page.getByText('已有的合成回复', { exact: true }).waitFor();
    const input = page.locator('.conversation-composer textarea');
    await input.fill('切换语言时，这份输入草稿仍在');
    await input.evaluate(element => { window.i18nComposer = element; window.i18nMessage = document.querySelector('[data-message-id]'); });
    const other = await h.open(null); await openSettings(other); await language(other).selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await input.inputValue(), '切换语言时，这份输入草稿仍在');
    assert.equal(await input.evaluate(element => element === window.i18nComposer && document.activeElement === element), true);
    assert.equal(await page.locator('[data-message-id]').first().evaluate(element => element === window.i18nMessage), true);
    assert.equal(await page.getByText('已有的合成问题', { exact: true }).count(), 1);
    assert.equal(await page.getByText('已有的合成回复', { exact: true }).count(), 1);
    assert.match(await page.locator('.inspector-title-trigger').textContent(), /ged 合成已有会话/);
    assert.equal(await input.getAttribute('aria-label'), 'Send a message');
    assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
  });
}

import assert from 'node:assert/strict';
import { ids } from './fixture.mjs';

const row = (page, id = ids.regular) => page.locator(`.task-select[data-thread-id="${id}"]`);
const back = page => page.getByRole('button', { name: '关闭详情', exact: true });
const swipe = async (page, cancel = false, native = false) => {
  const root = page.locator('.conversation-messages');
  const panelBox = await page.locator('.inspector').boundingBox(), messageBox = await root.boundingBox();
  const x = panelBox.x + 20, y = messageBox.y + Math.min(100, messageBox.height / 2);
  if (native) {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      for (const dx of [30, 80, 150]) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y, id: 1 }] });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
    return;
  }
  await root.evaluate(async (element, { x, y, cancel }) => {
    for (const [type, dx] of [['touchstart', 0], ['touchmove', 150], [cancel ? 'touchcancel' : 'touchend', 155]]) {
      const point = { identifier: 1, target: element, clientX: x + dx, clientY: y };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: type === 'touchstart' || type === 'touchmove' ? [point] : [] }, changedTouches: { value: [point] } });
      element.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 20));
    }
  }, { x, y, cancel });
};

// Register through smoke's existing reporter so every browser result carries
// the tested build and participates in the current run's aggregate record.
export function inspectorReturnFlows(engine, register) {
  const flow = (name, run) => register(engine, name, {}, run);

  flow('nested information dialogs start on a neutral title and keep keyboard close navigation', async h => {
    const page = await h.open(null);
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    const navigation = page.getByRole('dialog', { name: '工作区导航', exact: true });
    await page.waitForFunction(() => document.activeElement?.matches('.sidebar'));
    assert.equal(await navigation.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
    await page.keyboard.press('Tab');
    assert.equal(await navigation.getByRole('button', { name: '关闭导航', exact: true }).evaluate(element => element === document.activeElement), true);
    await navigation.focus(); await page.keyboard.press('Shift+Tab');
    const settingsLauncher = navigation.getByRole('button', { name: '设置', exact: true });
    assert.equal(await settingsLauncher.evaluate(element => element === document.activeElement), true);
    await settingsLauncher.press('Enter');
    const settings = page.getByRole('dialog', { name: '设置', exact: true });
    await settings.waitFor();
    const install = settings.getByRole('button', { name: '添加到主屏幕', exact: true });
    // Safari may retain the parent's title on pointer clicks; restore the
    // actual opener rather than requiring every engine to focus a button.
    await install.evaluate(element => element.addEventListener('click', () => {
      window.syntheticInstallOpener = document.activeElement;
    }, { once: true }));
    await install.click();
    const guide = page.getByRole('dialog', { name: '添加到手机主屏幕', exact: true });
    await guide.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('.install-dialog > header > h2'));
    const title = guide.getByRole('heading', { name: '添加到手机主屏幕', exact: true });
    const close = guide.getByRole('button', { name: '关闭对话框', exact: true });
    assert.equal(await title.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
    assert.equal(await close.evaluate(element => element === document.activeElement), false);
    await page.keyboard.press('Tab');
    assert.equal(await close.evaluate(element => element === document.activeElement && element.matches(':focus-visible')), true);
    assert.notEqual(await close.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
    await page.keyboard.press('Escape'); await guide.waitFor({ state: 'detached' });
    assert.equal(await settings.isVisible(), true, 'Escape closes only the top information dialog');
    await page.waitForFunction(() => document.activeElement === window.syntheticInstallOpener);
    assert.equal(await settings.evaluate(element => element.contains(document.activeElement)), true);
    await page.keyboard.press('Escape'); await settings.waitFor({ state: 'detached' });
    assert.equal(await settingsLauncher.evaluate(element => element === document.activeElement), true);
  });

  flow('editing then swipe returns to neutral list focus with both motion preferences', async h => {
    const page = await h.open(null);
    for (const reducedMotion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion });
      await row(page).click(); await page.getByText('已有的合成回复', { exact: true }).waitFor();
      const input = page.locator('.conversation-composer textarea');
      await input.fill('保留的合成草稿'); await input.press('End');
      await swipe(page, true, engine === 'chromium');
      assert.equal(await page.locator('.inspector').count(), 1);
      assert.equal(await input.evaluate(element => document.activeElement === element), true);
      await swipe(page, false, engine === 'chromium');
      await page.locator('.inspector').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('.task-list-surface'));
      assert.equal(await row(page).evaluate(element => document.activeElement === element || element.matches(':focus-visible')), false);
      assert.equal(await page.locator('.task-list-surface').evaluate(element => getComputedStyle(element).outlineStyle), 'none');
      await row(page).click(); await input.waitFor(); assert.equal(await input.inputValue(), '保留的合成草稿');
      await input.fill(''); await input.press('End');
      await swipe(page, false, engine === 'chromium');
      await page.locator('.inspector').waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('.task-list-surface'));
      assert.equal(await row(page).evaluate(element => element.matches(':focus-visible')), false);
    }
  });

  flow('keyboard return preserves row focus while immediate reopening owns the next focus', async h => {
    const page = await h.open(null);
    await row(page).focus(); await row(page).press('Enter'); await back(page).waitFor();
    await back(page).press('Enter'); await page.locator('.inspector').waitFor({ state: 'detached' });
    await page.waitForFunction(id => document.activeElement?.matches(`.task-select[data-thread-id="${id}"]`), ids.regular);
    assert.equal(await row(page).evaluate(element => element.matches(':focus-visible')), true);
    await row(page).click(); await back(page).waitFor();
    await page.evaluate(id => {
      document.querySelector('[data-inspector-close]').click();
      document.querySelector(`.task-select[data-thread-id="${id}"]`).click();
    }, ids.empty);
    await page.waitForFunction(() => document.querySelector('.inspector')?.contains(document.activeElement));
    assert.match(await page.locator('.inspector-title-trigger').getAttribute('aria-label'), /空会话/);
    await page.waitForTimeout(80);
    assert.equal(await page.locator('.inspector').evaluate(element => element.contains(document.activeElement)), true);
  });

  flow('return focus does not steal an immediately opened search or dialog', async h => {
    const page = await h.open(null);
    await row(page).click(); await back(page).waitFor();
    await page.evaluate(() => {
      document.querySelector('[data-inspector-close]').click();
      document.querySelector('.search-toggle').click();
    });
    await page.waitForFunction(() => document.activeElement?.matches('#task-search-box input'));
    await page.waitForTimeout(80);
    assert.equal(await page.locator('#task-search-box input').evaluate(element => document.activeElement === element), true);
    await page.getByRole('button', { name: '清除并收起搜索', exact: true }).click();
    await row(page).click(); await back(page).waitFor();
    await page.evaluate(() => {
      document.querySelector('[data-inspector-close]').click();
      document.querySelector('.new-conversation-button').click();
    });
    await page.waitForFunction(() => document.activeElement?.matches('dialog textarea'));
    await page.waitForTimeout(80);
    assert.equal(await page.locator('dialog textarea').evaluate(element => document.activeElement === element), true);
  });
}

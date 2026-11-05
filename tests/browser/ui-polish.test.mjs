import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_UI_POLISH_REPORT || '.local/qa/browser-ui-polish/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const words = {
  'zh-CN': { reload: '重新读取', continue: '继续编辑', discard: '放弃并关闭', closePreview: '关闭文件预览', download: '下载',
    rejected: '会话暂不可用，请刷新后再试。', unknown: '改名结果尚未确认，请核对后再操作。' },
  'en-US': { reload: 'Reload', continue: 'Continue editing', discard: 'Discard and close', closePreview: 'Close file preview', download: 'Download',
    rejected: 'This conversation is temporarily unavailable. Refresh and try again.', unknown: 'Check the unconfirmed rename before continuing.' },
};
const errorSource = '会话暂不可用，请刷新后再试。';
const uncertainError = 'Synthetic connection was interrupted.';

function flow(engine, locale, width, name, run) {
  test(`${engine}: ${locale} ${width}px ${name}`, { timeout: 30000 }, () => runScenario({ engine, name: `${locale} ${width}px ${name}`,
    create: () => createHarness(engine, { locale, width }), run, record: result => results.push(result) }));
}
async function openRename(page) {
  await page.locator('.inspector-title-trigger').click();
  await page.locator('.thread-management-actions button').first().click();
  const dialog = page.locator('.rename-thread-dialog');
  await dialog.locator('input:not([disabled])').waitFor();
  return dialog;
}
async function description(input) {
  return input.evaluate(element => {
    const ids = (element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    return ids.map(id => ({ id, exists: !!document.getElementById(id), text: document.getElementById(id)?.textContent }));
  });
}
async function renameRoute(page, failureStatus) {
  const calls = [];
  let pending;
  await page.route(/\/api\/(?:machines\/[a-z0-9-]+\/)?tasks\/[a-z0-9-]+\/name(?:\/[a-z0-9-]+)?$/, async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    const receipt = !pathname.endsWith('/name');
    calls.push({ method: request.method(), receipt });
    let status = 200, data;
    if (request.method() === 'POST') {
      pending = request.postDataJSON();
      status = failureStatus; data = { error: failureStatus < 500 ? errorSource : uncertainError };
    } else if (receipt) {
      assert.ok(pending, 'A receipt read must refer to an existing synthetic write');
      assert.ok(pathname.endsWith('/' + pending.requestId), 'The unknown result keeps its original request ID');
      status = 503; data = { error: uncertainError };
    } else data = { title: 'Original synthetic title', name: null, nameFingerprint: 'exact-synthetic-observation', canRename: true };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  });
  return calls;
}

for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) {
  const text = words[locale];
  flow(engine, locale, 320, 'rename rejection has one described error and reload preserves the proposed name', async h => {
    const page = await h.open();
    const calls = await renameRoute(page, 409), dialog = await openRename(page), input = dialog.locator('input');
    await input.fill('Unsent proposed name');
    await dialog.locator('button[type="submit"]').click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(await dialog.getByRole('alert').count(), 1);
    assert.equal(await dialog.getByRole('alert').textContent(), text.rejected);
    assert.equal(await dialog.locator('.rename-thread-status').count(), 0, 'An identical translated status must not repeat the alert');
    const described = await description(input);
    assert.equal(described.length, 1);
    assert.ok(described.every(item => item.exists));
    assert.equal(described[0].text, text.rejected);
    assert.equal(await input.inputValue(), 'Unsent proposed name');
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    await dialog.getByRole('button', { name: text.reload, exact: true }).click();
    await dialog.locator('button[type="submit"]:not([disabled])').waitFor();
    assert.equal(await input.inputValue(), 'Unsent proposed name', 'Reloading preconditions cannot replace the proposed name');
    assert.equal(await dialog.getByRole('alert').count(), 0);
    assert.ok((await description(input)).every(item => item.exists));
    assert.equal(calls.filter(call => call.method === 'POST').length, 1, 'Reload is read-only');
  });

  flow(engine, locale, 390, 'uncertain rename keeps both result guidance and the distinct error without replaying', async h => {
    const page = await h.open(), calls = await renameRoute(page, 503), dialog = await openRename(page), input = dialog.locator('input');
    await input.fill('Keep the uncertain proposed name');
    await dialog.locator('button[type="submit"]').click();
    await dialog.getByRole('alert').waitFor();
    await page.waitForFunction(() => document.querySelector('.rename-thread-dialog')?.getAttribute('aria-busy') !== 'true'
      && document.querySelector('.rename-thread-dialog .rename-thread-status')?.textContent
      && document.querySelector('.rename-thread-dialog .inline-error')?.textContent);
    assert.equal(await dialog.locator('.rename-thread-status').textContent(), text.unknown);
    assert.equal(await dialog.getByRole('alert').textContent(), uncertainError);
    const described = await description(input);
    assert.equal(described.length, 2);
    assert.ok(described.every(item => item.exists));
    assert.deepEqual(new Set(described.map(item => item.text)), new Set([text.unknown, uncertainError]));
    assert.equal(await input.inputValue(), 'Keep the uncertain proposed name');
    assert.equal(await input.isDisabled(), true, 'An unknown write cannot enable another submission');
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.ok(calls.some(call => call.receipt), 'Automatic recovery only reads the original receipt');
    assert.equal(await dialog.locator('button[type="submit"]').count(), 0);
  });

  for (const width of [320, 390]) {
    flow(engine, locale, width, 'dirty close actions retain spacing, draft identity and explicit discard', async h => {
      const page = await h.open(null);
      await page.locator('.new-conversation-button').click();
      const dialog = page.locator('.new-conversation-dialog'), input = dialog.locator('textarea');
      await input.fill('Keep this unsent synthetic draft.');
      await input.evaluate(element => { window.polishDraftInput = element; });
      await page.keyboard.press('Escape');
      const actions = dialog.locator('.modal-close-actions'); await actions.waitFor();
      const boxes = await actions.locator('button').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      }));
      assert.equal(boxes.length, 2);
      assert.ok(boxes.every(box => box.width >= 44 && box.height >= 44));
      const gap = Math.abs(boxes[1].top - boxes[0].top) < 1 ? boxes[1].left - boxes[0].right : boxes[1].top - boxes[0].bottom;
      assert.ok(gap >= 7.5, 'Wrapped actions need the same clear separation as one-row actions');
      const keep = dialog.getByRole('button', { name: text.continue, exact: true });
      assert.equal(await keep.evaluate(element => document.activeElement === element), true);
      await keep.click();
      await actions.waitFor({ state: 'detached' });
      assert.equal(await input.inputValue(), 'Keep this unsent synthetic draft.');
      assert.equal(await input.evaluate(element => element === window.polishDraftInput && document.activeElement === element), true);
      await page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: text.discard, exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'), 'Closing a draft never creates or sends a conversation');
    });

    flow(engine, locale, width, 'text preview preserves a clear close target and readable filename beside download', async h => {
      const path = '/synthetic/a-long-file-name-for-mobile-reading.md';
      const name = 'a-long-file-name-for-mobile-reading.md', key = 'a'.repeat(64);
      const file = { url: `/api/tasks/${ids.regular}/files/${key}`, name };
      h.patchHistory(ids.regular, { messages: [{ id: 'polish-file', role: 'assistant', phase: 'final', turnId: 'initial', timestamp: Date.now(),
        text: `[Synthetic report](<${path}>)`, files: { [path]: file } }] });
      const page = await h.open();
      let reads = 0;
      await page.route(`**/files/${key}`, async route => {
        assert.equal(route.request().method(), 'GET'); reads++;
        await route.fulfill({ status: 200, contentType: 'text/markdown', headers: { 'X-Pocket-Machine': new URL(page.url()).searchParams.get('machine') }, body: '# Synthetic preview\n\nReadable synthetic file content.' });
      });
      const opener = page.locator('.message-file-button'); await opener.click();
      const preview = page.locator('dialog.text-file-viewer'); await preview.getByText('Readable synthetic file content.', { exact: true }).waitFor();
      const close = preview.getByRole('button', { name: text.closePreview, exact: true });
      const geometry = await preview.locator('.text-file-toolbar').evaluate(element => {
        const title = element.querySelector('h2').getBoundingClientRect(), buttons = [...element.querySelectorAll('button')];
        const download = buttons[0].getBoundingClientRect(), close = buttons[1].getBoundingClientRect();
        return { titleWidth: title.width, titleRight: title.right, downloadLeft: download.left, closeWidth: close.width, closeHeight: close.height,
          downloadTextVisible: getComputedStyle(buttons[0].querySelector('span')).display !== 'none', closeTextHidden: getComputedStyle(buttons[1].querySelector('span')).display === 'none' };
      });
      assert.equal(geometry.closeWidth, 44); assert.equal(geometry.closeHeight, 44);
      assert.ok(geometry.titleWidth >= 100 && geometry.titleRight <= geometry.downloadLeft, 'The filename keeps useful room alongside both actions');
      assert.equal(geometry.downloadTextVisible, true); assert.equal(geometry.closeTextHidden, true);
      assert.equal(await preview.locator('h2').getAttribute('title'), name);
      assert.equal(await preview.getByRole('button', { name: locale === 'zh-CN' ? `下载文件：${name}` : `Download file: ${name}`, exact: true }).count(), 1);
      assert.equal(await preview.locator('.text-file-toolbar button').first().locator('span').textContent(), text.download);
      await close.click(); await preview.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.matches('.message-file-button'));
      assert.equal(reads, 1, 'Opening and closing a preview must not download or reread the file');
    });
  }

  flow(engine, locale, 320, 'sort option icons match the toolbar and keep the checked choice', async h => {
    const page = await h.open(null), trigger = page.locator('.thread-sort-trigger');
    await trigger.click(); const menu = page.locator('.thread-sort-menu[role="menu"]'); await menu.waitFor();
    await menu.evaluate(element => Promise.all(element.getAnimations({ subtree: true })
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
    for (const choice of ['smart', 'created', 'activity']) {
      const option = menu.locator(`[data-sort-choice="${choice}"]`), icon = option.locator(':scope > svg');
      assert.equal(await icon.count(), 1);
      assert.equal(await icon.getAttribute('width'), '16'); assert.equal(await icon.getAttribute('height'), '16');
      assert.equal(await icon.getAttribute('stroke-width'), '1.75');
      const dimensions = await icon.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
      assert.ok(Math.abs(dimensions.width - 16) <= .1 && Math.abs(dimensions.height - 16) <= .1);
      assert.equal(await option.getAttribute('aria-checked'), choice === 'smart' ? 'true' : 'false');
    }
    await menu.locator('[data-sort-choice="activity"]').click(); await menu.waitFor({ state: 'detached' });
    await trigger.click(); await menu.waitFor();
    assert.equal(await menu.locator('[data-sort-choice="activity"]').getAttribute('aria-checked'), 'true');
    assert.equal(await menu.locator('[data-sort-choice="smart"]').getAttribute('aria-checked'), 'false');
    assert.equal(await trigger.getAttribute('data-sort-mode'), 'activity');
  });

  flow(engine, locale, 375, 'narrow composer recovery controls fit at both sides of the breakpoint and retain the draft', async h => {
    // Changing the responsive layout must not grant an unknown compaction
    // new send permissions or replace its current textarea.
    h.patchHistory(ids.regular, { compactionRequest: { requestId: '01111111-1111-4111-8111-111111111111', status: 'unknown' } });
    const page = await h.open(), input = page.locator('.conversation-composer textarea');
    const draft = 'Preserve this unsent narrow recovery draft.';
    await input.fill(draft);
    await input.evaluate(element => { window.polishRecoveryInput = element; });
    const assertControls = async () => {
      const measurements = await page.locator('.conversation-composer').evaluate(form => {
        const root = form.getBoundingClientRect();
        const controls = [...form.querySelectorAll('.composer-actions > .attachment-picker,.composer-collapse,.context-trigger,.composer-actions > .primary,.stop-execution')]
          .filter(element => element.getClientRects().length && getComputedStyle(element).display !== 'none').map(element => {
            const box = element.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
            return { className: element.className, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
              width: box.width, height: box.height, hit: element.contains(hit) };
          });
        return { left: root.left, right: root.right, top: root.top, bottom: root.bottom, controls,
          viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
          inputSame: form.querySelector('textarea') === window.polishRecoveryInput };
      });
      assert.ok(measurements.controls.length >= 3);
      for (const control of measurements.controls) {
        assert.ok(control.left >= measurements.left - 1 && control.right <= measurements.right + 1
          && control.top >= measurements.top - 1 && control.bottom <= measurements.bottom + 1, `${control.className} escapes its composer`);
        assert.ok(control.width >= 43.5 && control.height >= 43.5, `${control.className} keeps a 44px touch target`);
        assert.equal(control.hit, true, `${control.className} remains reachable at its center`);
      }
      assert.ok(measurements.documentWidth <= measurements.viewport);
      assert.equal(measurements.inputSame, true);
      assert.equal(await input.inputValue(), draft);
    };
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 844 });
      await assertControls();
      await refresh(page);
      await page.waitForTimeout(160);
      await assertControls();
    }
    assert.equal(await input.evaluate(element => document.activeElement === element), true);
    assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'));
  });

  for (const width of [320, 375]) {
    test(`${engine}: ${locale} ${width}px archived composer actions remain inside the input boundary`, { timeout: 30000 }, () => runScenario({
      engine, name: `${locale} ${width}px archived composer actions remain inside the input boundary`,
      create: () => createHarness(engine, { locale, width, archivedHidden: true }), record: result => results.push(result),
      run: async h => {
        const page = await h.open(ids.empty), form = page.locator('.conversation-composer'), input = form.locator('textarea');
        await input.fill('An unsent archived conversation draft.');
        await input.evaluate(element => { window.polishArchivedInput = element; });
        const controls = await form.evaluate(form => {
          const root = form.getBoundingClientRect();
          return [...form.querySelectorAll('.composer-actions > .attachment-picker,.composer-collapse,.context-trigger,.composer-actions > .primary')]
            .filter(element => element.getClientRects().length && getComputedStyle(element).display !== 'none').map(element => {
              const box = element.getBoundingClientRect();
              return { className: element.className, contained: box.left >= root.left - 1 && box.right <= root.right + 1 && box.top >= root.top - 1 && box.bottom <= root.bottom + 1,
                width: box.width, height: box.height, hit: element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) };
            });
        });
        assert.ok(controls.length >= 3);
        assert.ok(controls.every(control => control.contained && control.width >= 43.5 && control.height >= 43.5 && control.hit), JSON.stringify(controls));
        await refresh(page); await page.waitForTimeout(160);
        assert.equal(await input.evaluate(element => element === window.polishArchivedInput && document.activeElement === element), true);
        assert.equal(await input.inputValue(), 'An unsent archived conversation draft.');
        assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'), 'Reading an archived draft cannot unarchive or send it');
      },
    }));
  }
}

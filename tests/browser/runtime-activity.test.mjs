import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_RUNTIME_REPORT || '.local/qa/browser-runtime/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});

const toggle = page => page.locator('.conversation-activity-toggle');
const summary = page => page.locator('.conversation-activity-summary');
const readonlyCalls = h => h.calls.filter(call => call.action === 'history' || call.action === 'transcript').length;
const openDetails = async page => {
  await toggle(page).waitFor();
  assert.equal(await toggle(page).getAttribute('aria-expanded'), 'false');
  assert.equal(await summary(page).count(), 0);
  const hit = await toggle(page).evaluate(node => { const rect = node.getBoundingClientRect(); return [rect.width, rect.height]; });
  assert.deepEqual(hit, [44, 44]);
  await toggle(page).click();
  assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true');
  await summary(page).waitFor();
  assert.equal(await toggle(page).getAttribute('aria-controls'), await page.locator('.conversation-activity-details').getAttribute('id'));
};

for (const engine of engines) test(`${engine}: a long text silence exposes the actual native operation and keeps rechecking read-only`, { timeout: 30000 },
  () => runScenario({ engine, name: 'long native operation remains observable',
    create: () => createHarness(engine),
    run: async h => {
      const at = Date.now();
      h.seedThread(ids.regular, { messages: [
        { id: 'runtime-question', role: 'user', text: '合成的运行问题', turnId: 'initial', timestamp: at - 20 * 60000 },
        { id: 'runtime-progress', role: 'assistant', phase: 'commentary', text: '合成的最近进展', turnId: 'initial', timestamp: at - 14 * 60000 },
      ] });
      h.setRuntime(ids.regular, 'running');
      h.patchHistory(ids.regular, {
        turnTiming: { turnId: 'initial', status: 'inProgress', startedAt: at - 20 * 60000, durationMs: null, observedAt: at },
        runtimeActivity: { turnId: 'initial', lastMessageAt: at - 14 * 60000, lastEventAt: at - 8 * 60000,
          activeOperation: { kind: 'command', startedAt: at - 8 * 60000 } },
      });
      const page = await h.open();
      await page.locator('.conversation-working-dots').waitFor();
      assert.equal(await summary(page).count(), 0, 'Even long native work leaves details hidden until requested');
      const beforeToggle = readonlyCalls(h);
      await openDetails(page);
      await toggle(page).click(); assert.equal(await toggle(page).getAttribute('aria-expanded'), 'false');
      assert.equal(await summary(page).count(), 0);
      await openDetails(page);
      assert.equal(readonlyCalls(h), beforeToggle, 'Toggling is a local disclosure, not a status request');
      await page.getByText('正在执行命令', { exact: true }).waitFor();
      assert.ok((await page.locator('.conversation-activity-summary').textContent()).includes('8分钟'));
      const input = page.locator('.conversation-composer textarea');
      await input.focus(); await input.fill('Keep this draft.');
      await input.evaluate(node => { window.runtimeInput = node; node.setSelectionRange(2, 9); });
      const control = page.getByRole('button', { name: '核对进展', exact: true });
      assert.equal((await control.textContent()).trim(), '', 'The refresh action is icon-only');
      const icon = await control.locator('svg').getAttribute('class');
      const gate = h.pause('history');
      await control.click();
      await control.locator('.conversation-activity-spinner').waitFor();
      assert.equal(await control.getAttribute('aria-busy'), 'true');
      assert.equal(await control.isDisabled(), true);
      assert.ok((await control.locator('svg').getAttribute('class')).includes('lucide-refresh-cw'));
      assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true', 'Refreshing never collapses the disclosure');
      assert.equal((await control.textContent()).trim(), '');
      gate.release();
      await control.locator('.conversation-activity-spinner').waitFor({ state: 'detached' });
      assert.equal(await control.isDisabled(), false);
      assert.ok(icon.includes('lucide-refresh-cw'));
      assert.equal(await input.inputValue(), 'Keep this draft.');
      assert.equal(await page.evaluate(() => window.runtimeInput === document.querySelector('.conversation-composer textarea')), true);
      assert.equal(await page.evaluate(() => window.runtimeInput === document.activeElement), true);
      assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 9]);
      assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true');
      assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
    }, record: result => results.push(result),
  }));

for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) test(`${engine}/${locale}: old text and fresh actual tool events are not presented as a stalled conversation`, { timeout: 30000 },
  () => runScenario({ engine, name: 'fresh actual activity beneath quiet text',
    create: () => createHarness(engine, { width: 320, locale }),
    run: async h => {
      const at = Date.now();
      h.seedThread(ids.regular, { messages: [
        { id: 'event-question', role: 'user', text: '合成的运行问题', turnId: 'initial', timestamp: at - 20 * 60000 },
        { id: 'event-progress', role: 'assistant', phase: 'commentary', text: '合成的最近进展', turnId: 'initial', timestamp: at - 14 * 60000 },
      ] });
      h.setRuntime(ids.regular, 'running');
      h.patchHistory(ids.regular, {
        turnTiming: { turnId: 'initial', status: 'inProgress', startedAt: at - 20 * 60000, durationMs: null, observedAt: at },
        runtimeActivity: { turnId: 'initial', lastMessageAt: at - 14 * 60000, lastEventAt: at - 4000, activeOperation: null },
      });
      const page = await h.open();
      await openDetails(page);
      const text = await summary(page).textContent();
      assert.ok(locale === 'zh-CN' ? text.includes('刚刚') : /(now|just)/i.test(text), text);
      assert.ok(!text.includes('最近活动：') && !/activity:/i.test(text), 'Visible prose drops the activity prefix');
      const semantics = await page.locator('.conversation-activity-detail').getAttribute('aria-label');
      assert.ok(locale === 'zh-CN' ? semantics.includes('最近活动：刚刚') : /activity/i.test(semantics), semantics);
      assert.ok(!text.includes('14分钟'), 'Real recent tool activity is distinct from the last prose message');
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        const geometry = await page.locator('.conversation-working').evaluate(node => {
          const parent = node.getBoundingClientRect(), children = [...node.children].filter(child => !child.classList.contains('sr-only'));
          return { height: parent.height, width: parent.width, overflow: node.scrollWidth > node.clientWidth,
            contained: children.every(child => { const rect = child.getBoundingClientRect(); return rect.left >= parent.left - 1 && rect.right <= parent.right + 1; }),
            control: node.querySelector('button').getBoundingClientRect().height };
        });
        assert.equal(geometry.height, 44);
        assert.equal(geometry.control, 44);
        assert.equal(geometry.overflow, false, JSON.stringify(geometry));
        assert.equal(geometry.contained, true, JSON.stringify(geometry));
      }
      h.patchHistory(ids.regular, {
        turnTiming: { turnId: 'initial', status: 'inProgress', startedAt: at - 20 * 60000, durationMs: null, observedAt: at },
        runtimeActivity: { turnId: 'initial', lastMessageAt: at - 14 * 60000, lastEventAt: at - 4000,
          activeOperation: { kind: 'command', startedAt: at - 8 * 60000 } },
      });
      await refresh(page);
      await page.locator('.conversation-activity-label').filter({ hasText: locale === 'zh-CN' ? '正在执行命令' : /command/i }).waitFor();
      const commandGeometry = await page.locator('.conversation-working').evaluate(node => ({ height: node.getBoundingClientRect().height,
        overflow: node.scrollWidth > node.clientWidth }));
      assert.deepEqual(commandGeometry, { height: 44, overflow: false });
    }, record: result => results.push(result),
  }));

for (const engine of engines) test(`${engine}: a frozen short sample stops dots before the caption and later shows neutral uncertainty without moving reading or input`, { timeout: 30000 },
  () => runScenario({ engine, name: 'frozen observation and protected reading',
    create: () => createHarness(engine, { width: 320, locale: 'en-US' }),
    run: async h => {
      const at = Date.now();
      const old = Array.from({ length: 22 }, (_, index) => ({ id: `reading-${index}`, role: index % 2 ? 'assistant' : 'user',
        phase: index % 2 ? 'final' : undefined, text: `合成历史 ${index}。这是用于保留阅读位置的长文本。`.repeat(4), timestamp: at - 300000 + index, turnId: `before-${index}` }));
      h.seedThread(ids.regular, { messages: [...old, { id: 'recent-body', role: 'assistant', phase: 'commentary',
        text: '最新合成进展', timestamp: at, turnId: 'initial' }] });
      h.setRuntime(ids.regular, 'running');
      h.patchHistory(ids.regular, {
        turnTiming: { turnId: 'initial', status: 'inProgress', startedAt: at, durationMs: null, observedAt: at },
        runtimeActivity: { turnId: 'initial', lastMessageAt: at, lastEventAt: at, activeOperation: null },
      });
      const page = await h.open();
      await page.locator('.conversation-working-dots').waitFor();
      assert.equal(await page.locator('.conversation-activity-summary').count(), 0);
      await openDetails(page);
      assert.ok((await summary(page).textContent()).includes('now'), 'Short work can be explicitly inspected without waiting two minutes');
      const gate = h.pause('history', { repeat: true });
      const root = page.locator('.conversation-messages');
      await root.evaluate(node => { node.scrollTop = 300; });
      const input = page.locator('.conversation-composer textarea');
      await input.focus(); await input.fill('A selected draft stays here.');
      await input.evaluate(node => { node.setSelectionRange(2, 9); window.runtimeFrozenInput = node; });
      const top = await root.evaluate(node => node.scrollTop);
      await page.evaluate(() => {
        const original = performance.now.bind(performance);
        window.runtimeMonoOffset = 65000;
        Object.defineProperty(performance, 'now', { configurable: true, value: () => original() + window.runtimeMonoOffset });
      });
      await page.locator('.conversation-activity-unconfirmed').waitFor();
      assert.equal(await page.locator('.conversation-working').count(), 0, 'Unconfirmed state cannot retain an animated current-work claim');
      const staticDots = await page.locator('.conversation-activity-unconfirmed .conversation-working-dot').evaluateAll(nodes => nodes.map(node => ({
        animation: getComputedStyle(node).animationName, transform: getComputedStyle(node).transform,
      })));
      assert.equal(staticDots.length, 3);
      assert.ok(staticDots.every(dot => dot.animation === 'none' && dot.transform === 'none'));
      assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true');
      await page.evaluate(() => { window.runtimeMonoOffset = 130000; });
      await page.locator('.conversation-activity-unconfirmed').waitFor();
      assert.equal(await page.locator('.conversation-working-dots').count(), 1, 'Unknown keeps its disclosure control, with static dots');
      assert.equal(await page.locator('.conversation-activity-unconfirmed').evaluate(node => node.scrollWidth > node.clientWidth), false);
      assert.ok(Math.abs(await root.evaluate(node => node.scrollTop) - top) <= 1);
      assert.equal(await input.inputValue(), 'A selected draft stays here.');
      assert.equal(await page.evaluate(() => window.runtimeFrozenInput === document.activeElement), true);
      assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 9]);
      assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
      gate.release();
    }, record: result => results.push(result),
  }));

for (const engine of engines) test(`${engine}: a genuine legacy commentary append renews visible progress without replaying a request`, { timeout: 30000 },
  () => runScenario({ engine, name: 'legacy complete message append has fresh visible progress',
    create: () => createHarness(engine),
    run: async h => {
      const at = Date.now();
      const first = { id: 'legacy-first', role: 'assistant', phase: 'commentary', text: '旧时间戳的合成进展',
        turnId: 'initial', timestamp: at - 20 * 60000 };
      const timing = { turnId: 'initial', status: 'inProgress', startedAt: at - 20 * 60000, durationMs: null, observedAt: at };
      h.seedThread(ids.regular, { messages: [first] }); h.setRuntime(ids.regular, 'running');
      h.patchHistory(ids.regular, { turnTiming: timing });
      const page = await h.open();
      await openDetails(page);
      const second = { ...first, id: 'legacy-second', text: '刚刚追加的新合成进展' };
      h.seedThread(ids.regular, { messages: [first, second] });
      h.patchHistory(ids.regular, { turnTiming: { ...timing, observedAt: at + 2000 } });
      await refresh(page);
      await page.getByText(second.text, { exact: true }).waitFor();
      assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true', 'New same-turn visible progress does not close a manual disclosure');
      await page.locator('.conversation-activity-detail').filter({ hasText: '刚刚' }).waitFor();
      await page.locator('.conversation-working-dots').waitFor();
      assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
    }, record: result => results.push(result),
  }));

for (const engine of engines) test(`${engine}: short running work has a keyboard disclosure without an extra read`, { timeout: 30000 },
  () => runScenario({ engine, name: 'keyboard short-work disclosure',
    create: () => createHarness(engine),
    run: async h => {
      const at = Date.now();
      h.seedThread(ids.regular, { messages: [{ id: 'keyboard-progress', role: 'assistant', phase: 'commentary',
        text: '可由键盘检查的合成进展', timestamp: at, turnId: 'initial' }] });
      h.setRuntime(ids.regular, 'running');
      h.patchHistory(ids.regular, {
        turnTiming: { turnId: 'initial', status: 'inProgress', startedAt: at, durationMs: null, observedAt: at },
        runtimeActivity: { turnId: 'initial', lastMessageAt: at, lastEventAt: at,
          activeOperation: { kind: 'tool', startedAt: at } },
      });
      const page = await h.open();
      await toggle(page).waitFor();
      assert.equal(await toggle(page).getAttribute('aria-expanded'), 'false');
      assert.equal(await summary(page).count(), 0);
      const before = readonlyCalls(h);
      await toggle(page).focus(); await toggle(page).press('Enter');
      await page.getByText('工具处理中', { exact: true }).waitFor();
      assert.equal(await toggle(page).getAttribute('aria-expanded'), 'true');
      assert.equal(await toggle(page).getAttribute('aria-label'), '收起运行详情');
      assert.equal(await toggle(page).evaluate(node => node === document.activeElement), true);
      await toggle(page).press('Enter');
      assert.equal(await toggle(page).getAttribute('aria-expanded'), 'false');
      assert.equal(await toggle(page).getAttribute('aria-label'), '展开运行详情');
      assert.equal(await summary(page).count(), 0);
      assert.equal(readonlyCalls(h), before);
      assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
    }, record: result => results.push(result),
  }));

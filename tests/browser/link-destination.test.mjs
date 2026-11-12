import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, origin, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [], evidence = [];
const answerId = 'link-destination-answer', userId = 'link-destination-user';
const longHost = 'a-long-synthetic-subdomain-for-destination-visibility.documentation.example.invalid';
const links = {
  report: 'https://docs.example.invalid/reports?view=complete#summary',
  metric: 'http://metrics.example.invalid:8080/detail?window=7',
  long: `https://${longHost}/report?filter=complete#section`,
  raw: 'https://raw.example.invalid/a/long/path?view=complete',
  namedHost: 'https://host.example.invalid/reference',
  user: 'https://inputs.example.invalid/query',
  mail: 'mailto:hello@example.invalid',
};
const filePath = '/synthetic/registered.opaque', fileUrl = `/api/tasks/${ids.regular}/files/${'f'.repeat(64)}`;
const destination = link => link.locator('.message-link-destination');
const hostLabel = link => link.locator('.message-link-host');
function install(h, locale = 'zh-CN', tail = '') {
  const english = locale === 'en-US';
  const text = [
    `[${english ? 'Read the complete report' : '阅读完整报告'}](${links.report})`,
    `[${english ? 'Metrics over HTTP' : 'HTTP 指标'}](${links.metric})`,
    `[${english ? 'Long destination' : '长域名目标'}](${links.long})`,
    `<${links.raw}>`, `[host.example.invalid](${links.namedHost})`,
    `[${english ? 'Open conversation' : '打开会话'}](codex://threads/${ids.empty})`,
    `[${english ? 'Open internal page' : '打开内部页面'}](/?task=${ids.empty})`,
    `[${english ? 'Email' : '邮件'}](${links.mail})`,
    `[${english ? 'Registered file' : '登记文件'}](${filePath})`, tail,
  ].filter(Boolean).join('\n\n');
  const messages = [{ id: userId, role: 'user', text: `[${english ? 'Query reference' : '提问参考'}](${links.user})`, turnId: 'initial', timestamp: Date.now() - 1000 },
    { id: answerId, role: 'assistant', phase: 'final', text, turnId: 'initial', timestamp: Date.now(),
      files: { [filePath]: { name: 'registered.opaque', url: fileUrl } } }];
  h.patchHistory(ids.regular, { messages }); h.patchTranscript(ids.regular, { messages });
}
function flow(engine, name, options, run) {
  test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine, options), run, record: result => results.push(result) }));
}
after(() => {
  const path = resolve(process.env.POCKET_LINK_DESTINATION_REPORT || '.local/qa/link-destination-2026-11-13/browser-link-destination.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ passed: results.length > 0 && results.every(result => result.passed),
    scenarios: results, evidence, screenshots: 0, externalNetworkRequests: 0 }, null, 2) + '\n');
});

const matrix = [
  { width: 320, locale: 'zh-CN', theme: 'light' }, { width: 320, locale: 'en-US', theme: 'dark' },
  { width: 390, locale: 'zh-CN', theme: 'dark' }, { width: 390, locale: 'en-US', theme: 'light' },
];
for (const engine of engines) {
  for (const options of matrix) flow(engine, `${options.width}px ${options.locale} ${options.theme}: destinations remain compact and preserve original links`, options, async h => {
    install(h, options.locale);
    const page = await h.open(); await page.emulateMedia({ colorScheme: options.theme });
    const row = page.locator(`[data-message-id="${answerId}"]`);
    await row.locator('.message-link-destination').first().waitFor();
    for (const href of [links.report, links.metric, links.long]) {
      const link = row.locator(`a[href=${JSON.stringify(href)}]`);
      assert.equal(await link.getAttribute('href'), href); assert.equal(await link.getAttribute('target'), '_blank');
      assert.match(await link.getAttribute('rel'), /noopener/); assert.match(await link.getAttribute('rel'), /noreferrer/);
      assert.equal(await link.getAttribute('title'), href);
      assert.equal(await hostLabel(link).textContent(), new URL(href).host);
      assert.equal(await destination(link).locator('svg').count(), 1);
      assert.equal(await destination(link).getAttribute('aria-hidden'), 'true', 'The original visible link label keeps its accessible name');
      const layout = await destination(link).evaluate(element => {
        const style = getComputedStyle(element), link = element.closest('a'), rect = element.getBoundingClientRect();
        const text = getComputedStyle(link);
        return { font: parseFloat(style.fontSize), textFont: parseFloat(text.fontSize), color: style.color, linkColor: text.color,
          width: rect.width, height: rect.height, displayed: style.display };
      });
      assert.ok(layout.font <= 12 && layout.font < layout.textFont, 'The domain is secondary to the link text');
      assert.notEqual(layout.color, layout.linkColor, 'The metadata uses the muted tone rather than the link accent');
      assert.ok(layout.width > 0 && layout.height > 0); assert.equal(layout.displayed, 'inline-flex');
    }
    const queryLink = page.locator(`[data-message-id="${userId}"] a[href=${JSON.stringify(links.user)}]`);
    assert.equal(await hostLabel(queryLink).textContent(), 'inputs.example.invalid');
    for (const href of [links.raw, links.namedHost]) {
      const link = row.locator(`a[href=${JSON.stringify(href)}]`);
      assert.equal(await hostLabel(link).count(), 0, 'A URL or exact host label does not repeat its host');
      assert.equal(await destination(link).locator('svg').count(), 1);
      assert.equal((await link.textContent()).split(new URL(href).host).length - 1, 1);
    }
    for (const link of await row.locator('.pocket-task-link').all()) {
      assert.equal(await destination(link).count(), 0); assert.match(await link.getAttribute('href'), new RegExp(ids.empty));
    }
    assert.equal(await row.locator('.pocket-task-link').count(), 2);
    assert.equal(await destination(row.locator(`a[href=${JSON.stringify(links.mail)}]`)).count(), 0);
    assert.equal(await row.locator('.message-file-button .message-link-destination').count(), 0);
    assert.equal(await row.locator('.message-file-button').count(), 1);
    assert.equal(h.calls.filter(call => call.path.includes('/files/')).length, 0, 'Showing a destination does not read or prefetch registered file contents');
    const long = row.locator(`a[href=${JSON.stringify(links.long)}]`);
    const clipped = await hostLabel(long).evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth,
      overflow: getComputedStyle(element).overflow, ellipsis: getComputedStyle(element).textOverflow }));
    assert.ok(clipped.content > clipped.width, 'The synthetic long host exercises actual clipping');
    assert.equal(clipped.ellipsis, 'ellipsis'); assert.equal(clipped.overflow, 'hidden');
    const geometry = await row.evaluate(element => {
      const box = element.getBoundingClientRect();
      const destinations = [...element.querySelectorAll('.message-link-destination')].map(node => {
        const bounds = node.getBoundingClientRect(); return { left: bounds.left, right: bounds.right, width: bounds.width };
      });
      return { rowLeft: box.left, rowRight: box.right, rowWidth: element.clientWidth, rowScrollWidth: element.scrollWidth,
        rootWidth: document.documentElement.clientWidth, rootScrollWidth: document.documentElement.scrollWidth, destinations };
    });
    assert.ok(geometry.rootScrollWidth <= geometry.rootWidth + 1); assert.ok(geometry.rowScrollWidth <= geometry.rowWidth + 1);
    assert.ok(geometry.destinations.every(bounds => bounds.left >= geometry.rowLeft - 1 && bounds.right <= geometry.rowRight + 1));
    await row.evaluate(element => { window.originalLinkArticle = element; window.originalExternalAnchor = element.querySelector('a'); });
    install(h, options.locale, options.locale === 'en-US' ? 'Fresh synthetic continuation.' : '新的合成续文。'); await refresh(page);
    await row.getByText(options.locale === 'en-US' ? 'Fresh synthetic continuation.' : '新的合成续文。', { exact: true }).waitFor();
    assert.equal(await row.evaluate(element => element === window.originalLinkArticle && element.querySelector('a') === window.originalExternalAnchor), true);
    evidence.push({ engine, ...options, build: h.build, hostEllipsis: clipped, geometry, originalNodesKept: true });
  });
  flow(engine, 'external host and arrow share the real anchor hit area and native popup navigation', { width: 390, locale: 'en-US' }, async h => {
    install(h, 'en-US'); const page = await h.open(), row = page.locator(`[data-message-id="${answerId}"]`);
    const link = row.locator(`a[href=${JSON.stringify(links.report)}]`); await destination(link).waitFor();
    const target = new URL(links.report);
    // HTTP transport excludes the fragment. Fulfill only this exact synthetic
    // origin/path/query; the fixture's global external-request rejection stays.
    await page.context().route(url => url.origin === target.origin && url.pathname === target.pathname && url.search === target.search,
      route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Synthetic destination</title><p>Intercepted destination</p>' }));
    await destination(link).scrollIntoViewIfNeeded();
    const hit = await destination(link).evaluate(element => {
      const rect = element.getBoundingClientRect(); const at = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { href: at?.closest('a')?.getAttribute('href'), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    assert.equal(hit.href, links.report);
    const popupReady = page.waitForEvent('popup'); await page.mouse.click(hit.x, hit.y);
    const popup = await popupReady; await popup.waitForURL(links.report);
    assert.equal(popup.url(), links.report); assert.equal(await popup.title(), 'Synthetic destination'); await popup.close();
    assert.ok(page.url().startsWith(origin + '/?machine=ged&task=' + ids.regular));
    assert.equal(await link.getAttribute('href'), links.report); assert.equal(await link.getAttribute('target'), '_blank');
    const modified = await link.evaluate(element => {
      let prevented;
      window.addEventListener('click', event => { prevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      return prevented;
    });
    assert.equal(modified, false, 'Metadata does not intercept modifier-click navigation');
    evidence.push({ engine, build: h.build, nativePopup: true, exactHref: links.report, hostArrowHitSharesAnchor: true,
      requestDestinationIntercepted: true, businessNetwork: false });
  });
}

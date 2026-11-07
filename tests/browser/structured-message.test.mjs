import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const heartbeat = body => `<heartbeat><automation_id>fixture-check</automation_id><decision>NOTIFY</decision><message>${body}</message></heartbeat>`;
const child = body => `<subagent_notification>${JSON.stringify({ agent_path: '/root/fixture', status: { completed: body } })}</subagent_notification>`;
const details = body => `<details><summary>合成参数与图片</summary>\n\n${body}\n\n</details>`;
const tails = '补充的 **合成内容**。\n\n![音效对照](/fixture/outside/comparison.wav)\n\n' + details('这里是折叠说明。\n\n![图片说明](/fixture/outside/preview.jpg)\n\n```xml\n<details>字面示例</details>\n```');
const message = (text, id = 'structured-result') => ({ id, role: 'assistant', phase: 'final', text, turnId: 'initial', timestamp: Date.now() });
const results = [];
after(() => {
  const path = resolve(process.env.POCKET_STRUCTURED_REPORT || '.local/qa/message-render-2026-11-05/browser-focused.json');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2));
});
const until = async predicate => {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Synthetic read did not arrive'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
function flow(engine, name, options, run) {
  test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine, options), run, record: result => results.push(result) }));
}

for (const engine of engines) {
  flow(engine, 'answer result footers keep the readable status, source examples and exact copy without exposing wire tags', {}, async h => {
    const citation = '<oai-mem-citation><citation_entries>synthetic-footer-private</citation_entries><rollout_ids>synthetic-footer-id</rollout_ids></oai-mem-citation>';
    const prefix = '本轮完成[合成作品](https://example.invalid/article)。\n\n保留普通正文与 **排版**。';
    const result = prefix + '\n\n' + heartbeat('合成独有结果需要保留。') + '\n' + citation;
    const example = '格式示例：\n\n```xml\n' + heartbeat('字面代码示例。') + '\n```';
    h.patchHistory(ids.regular, { messages: [message(example, 'footer-example'), message(result, 'footer-result')] });
    const page = await h.open(), row = page.locator('[data-message-id="footer-result"]');
    await row.getByText('合成独有结果需要保留。', { exact: true }).waitFor();
    assert.equal(await row.locator('pre').count(), 0);
    assert.equal(await row.locator('a').getAttribute('href'), 'https://example.invalid/article');
    assert.doesNotMatch(await row.textContent(), /heartbeat|automation_id|NOTIFY|synthetic-footer-private/);
    assert.match(await page.locator('[data-message-id="footer-example"] pre').textContent(), /<heartbeat>/);
    await row.evaluate(node => { window.footerMessageNode = node; });
    await page.evaluate(() => { navigator.clipboard.writeText = async value => { window.footerCopied = value; }; });
    await row.getByRole('button', { name: '复制回复', exact: true }).click();
    const copy = await page.evaluate(() => window.footerCopied);
    assert.match(copy, /合成独有结果需要保留/); assert.doesNotMatch(copy, /<heartbeat|automation_id|NOTIFY/);
    const deduplicated = prefix + '\n\n完全相同的合成状态。\n\n' + heartbeat('完全相同的合成状态。') + '\n' + citation;
    h.patchHistory(ids.regular, { messages: [message(example, 'footer-example'), message(deduplicated, 'footer-result')] });
    await refresh(page); await row.getByText('完全相同的合成状态。', { exact: true }).waitFor();
    assert.equal(await row.getByText('完全相同的合成状态。', { exact: true }).count(), 1);
    assert.equal(await row.evaluate(node => node === window.footerMessageNode), true);
    assert.ok(h.calls.filter(call => call.method !== 'GET').every(call => call.path === '/api/sync'));
  });

  flow(engine, 'compound heartbeat keeps safe disclosures, inert media, copy and stream identity', {}, async h => {
    const source = heartbeat('合成检查已完成。') + '\n\n' + tails;
    h.patchHistory(ids.regular, { messages: [message(source)] });
    const page = await h.open(); const row = page.locator('[data-message-id="structured-result"]');
    await row.getByText('合成检查已完成。', { exact: true }).waitFor();
    assert.equal(await row.locator('pre').count(), 1, 'Only the authored fenced XML example is a code block');
    assert.equal(await row.locator('details').count(), 1);
    assert.equal(await row.locator('audio,img,video,iframe').count(), 0);
    assert.equal(await row.getByText('文件保存在电脑上', { exact: true }).count(), 2);
    await row.locator('summary').click();
    await row.locator('details[open]').waitFor();
    await row.getByText('这里是折叠说明。', { exact: true }).waitFor();
    assert.equal(await row.locator('code').last().textContent(), '<details>字面示例</details>\n');
    await row.evaluate(node => { window.structuredMessageNode = node; window.structuredDisclosureNode = node.querySelector('details'); });
    h.patchHistory(ids.regular, { messages: [message(source + '\n\n另一个普通尾段。')] }); await refresh(page);
    await row.getByText('另一个普通尾段。', { exact: true }).waitFor();
    assert.equal(await row.evaluate(node => node === window.structuredMessageNode), true);
    assert.equal(await row.locator('details').evaluate(node => node === window.structuredDisclosureNode && node.open), true);
    await page.evaluate(() => { navigator.clipboard.writeText = async value => { window.structuredCopied = value; }; });
    await row.getByRole('button', { name: '复制回复', exact: true }).click();
    const copied = await page.evaluate(() => window.structuredCopied);
    assert.match(copied, /合成检查已完成/); assert.match(copied, /音效对照/); assert.match(copied, /另一个普通尾段/);
    assert.doesNotMatch(copied, /automation_id|NOTIFY|<heartbeat>/);
    assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });

  flow(engine, 'both original roles and child results share continuation rules without inheriting permissions', { width: 320, locale: 'en-US' }, async h => {
    const sources = [
      { ...message(heartbeat('用户角色合成摘要。') + '\n\n用户普通尾文。', 'user-result'), role: 'user' },
      message(child('子任务合成结果。') + '\n\n' + tails, 'child-result'),
      message('<future><message>未知结构仍可读</message></future>', 'unknown-result'),
      message('<details onclick="syntheticAttack()"><summary>惰性标签</summary>不可执行</details>', 'inert-result'),
    ];
    h.patchHistory(ids.regular, { messages: sources }); const page = await h.open();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByText('用户普通尾文。', { exact: true }).waitFor();
    const row = page.locator('[data-message-id="child-result"]'); await row.waitFor();
    assert.equal(await row.locator('.subagent-notification').count(), 1);
    assert.equal(await row.locator('.message-details').count(), 1);
    await row.locator('.subagent-notification').getByRole('button', { name: 'Show result', exact: true }).click();
    await row.getByText('子任务合成结果。', { exact: true }).waitFor();
    await row.locator('.message-details > summary').click(); await row.locator('.message-details[open]').waitFor();
    assert.equal(await row.locator('audio,img,video,iframe').count(), 0);
    assert.equal(await row.getByText('Saved on your computer', { exact: true }).count(), 2);
    const unknown = page.locator('[data-message-id="unknown-result"]');
    assert.equal(await unknown.locator('future,message').count(), 0);
    assert.match(await unknown.textContent(), /<future>.*未知结构仍可读/);
    const inert = page.locator('[data-message-id="inert-result"]');
    assert.equal(await inert.locator('details').count(), 0); assert.equal(await inert.locator('pre').count(), 1);
    assert.equal(await page.evaluate(() => window.syntheticAttackRan === true), false);
    assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });

  flow(engine, 'disclosure interaction preserves older reading, selection and unsent input', { history: true }, async h => {
    const page = await h.open(); await page.locator('[data-message-id]').first().waitFor();
    const root = page.locator('.conversation-messages');
    await root.evaluate(node => { node.scrollTop = 240; }); await page.waitForTimeout(80);
    const source = heartbeat('最后的合成摘要。') + '\n\n' + details('可读的后续说明。');
    const current = await page.locator('[data-message-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-message-id')));
    const older = current.map((id, index) => ({ id, role: index % 2 ? 'assistant' : 'user', phase: index % 2 ? 'final' : undefined,
      text: `历史消息 ${160 + index}。用于验证阅读位置的合成内容。`, turnId: `turn-${Math.floor((160 + index) / 2)}` }));
    h.patchHistory(ids.regular, { messages: [...older, message(source)] }); await refresh(page);
    await page.locator('[data-message-id="structured-result"] summary').waitFor();
    await root.evaluate(node => { node.scrollTop = 240; }); await page.waitForTimeout(80);
    await page.locator('[data-message-id]').first().evaluate(node => {
      window.structuredOlderNode = node;
      const text = node.querySelector('.message-text p').firstChild, range = document.createRange();
      range.setStart(text, 0); range.setEnd(text, Math.min(6, text.textContent.length));
      getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    const before = await root.evaluate(node => node.scrollTop), selection = await page.evaluate(() => getSelection().toString());
    h.patchHistory(ids.regular, { messages: [...older, message(source + '\n\n流式续文。')] }); await refresh(page);
    await page.getByText('流式续文。', { exact: true }).waitFor();
    assert.ok(Math.abs(await root.evaluate(node => node.scrollTop) - before) <= 1);
    assert.equal(await page.evaluate(() => getSelection().toString()), selection);
    assert.equal(await page.evaluate(() => window.structuredOlderNode === document.querySelector('[data-message-id]')), true);
    const input = page.locator('.conversation-composer textarea'); await input.fill('不发送的合成草稿');
    await input.evaluate(node => { window.structuredInputNode = node; });
    h.patchHistory(ids.regular, { messages: [...older, message(source + '\n\n再次续文。')] }); await refresh(page);
    await page.getByText('再次续文。', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '不发送的合成草稿'); assert.equal(await input.evaluate(node => node === window.structuredInputNode && document.activeElement === node), true);
    assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
  });
}

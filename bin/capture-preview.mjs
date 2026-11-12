#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createHarness, ids } from '../tests/browser/fixture.mjs';

// Actual compiled Pocket UI, seeded with synthetic tasks. The harness blocks
// unimplemented traffic; captures never reach a real account, API or model.
const directory = resolve('docs/assets');
mkdirSync(directory, { recursive: true });
const profile = { schemaVersion: 1, defaultMachine: 'local', machines: [{ id: 'local', label: 'My Mac' }], publicOrigin: null };
const receipt = { screenshots: [], synthetic: true, realModelRequests: 0 };
const locales = ['zh-CN', 'en-US'];
for (const locale of locales) {
  const zh = locale === 'zh-CN', suffix = zh ? 'zh' : 'en';
  const titles = zh ? ['上线前检查', '产品调研'] : ['Release review', 'Product research'];
  const question = zh ? '发布前还需要确认哪些事项？' : 'What should we verify before the release?';
  const reply = zh ? '## 本轮检查结果\n\n安装说明和依赖清单已经整理好。\n\n- 配置保持原样\n- 身份和权限沿用原会话\n- 不确定的发送结果先核对\n\n```sh\nnpm run doctor\nnpm run licenses:check\n```\n\n接下来，在手机上验证一次阅读和附件流程。' : '## Review results\n\nThe installation guide and dependency inventory are ready.\n\n- Preserve existing configuration\n- Keep the original owner and permissions\n- Verify uncertain sends before retrying\n\n```sh\nnpm run doctor\nnpm run licenses:check\n```\n\nNext, check reading and attachments on your phone.';
  const messages = [
    { id: 'preview-user', role: 'user', text: question, timestamp: Date.now() - 90000, turnId: 'initial' },
    { id: 'preview-answer', role: 'assistant', phase: 'final', text: reply, timestamp: Date.now() - 60000, turnId: 'initial' },
  ];
  const options = { locale, projectName: zh ? '演示项目' : 'Demo project', clientConfiguration: profile };
  const desktop = await createHarness('chromium', { ...options, width: 1280, visibility: true });
  const mobile = await createHarness('chromium', options);
  const decisions = await createHarness('chromium', options);
  let composite;
  try {
    for (const h of [desktop, mobile, decisions]) {
      h.seedThread(ids.regular, { title: titles[0], messages });
      h.seedThread(ids.empty, { title: titles[1] });
    }
    const workspace = await desktop.open(ids.regular);
    await workspace.getByText(zh ? '本轮检查结果' : 'Review results', { exact: true }).waitFor();
    const workspacePath = resolve(directory, `pocket-workspace-${suffix}.png`);
    await workspace.screenshot({ path: workspacePath });
    const reader = await mobile.open(ids.regular);
    await reader.getByText(zh ? '本轮检查结果' : 'Review results', { exact: true }).waitFor();
    await reader.locator('.conversation-composer textarea').fill(zh ? '先检查附件流程，遇到问题告诉我。' : 'Check the attachment flow and report anything that needs attention.');
    const readingPath = resolve(directory, `pocket-reading-${suffix}.png`);
    await reader.screenshot({ path: readingPath });
    const request = { key: 'preview-question', kind: 'questions', reason: zh ? '继续之前，需要你选择验证范围。' : 'Choose the verification scope before continuing.', cwd: '', choices: [],
      questions: [{ id: 'scope', question: zh ? '这轮优先验证什么？' : 'What should we verify first?', options: [{ label: zh ? '手机阅读和输入' : 'Phone reading and input' }, { label: zh ? '附件与恢复' : 'Attachments and recovery' }] }] };
    const decisionMessages = [{ ...messages[1], text: zh ? '检查完成。选择下一步，我会在原会话继续。' : 'The review is complete. Choose the next step to continue in this conversation.' }];
    decisions.seedThread(ids.regular, { messages: decisionMessages });
    decisions.patchHistory(ids.regular, { messages: decisionMessages, pendingRequests: [request] });
    decisions.patchTranscript(ids.regular, { messages: decisionMessages, pendingRequests: [request] });
    const decision = await decisions.open(ids.regular);
    await decision.locator('.request-actions').waitFor();
    await decision.locator('.approval-question input[type="radio"]').first().check();
    const submit = decision.locator('.approval-buttons button').last();
    await submit.scrollIntoViewIfNeeded();
    assert.ok(await submit.isEnabled());
    const decisionBox = await submit.boundingBox();
    assert.ok(decisionBox && decisionBox.y >= 0 && decisionBox.y + decisionBox.height <= 844, 'Decision submission must be visible in the runtime screenshot');
    const decisionPath = resolve(directory, `pocket-decisions-${suffix}.png`);
    await decision.screenshot({ path: decisionPath });
    for (const h of [desktop, mobile, decisions]) {
      assert.deepEqual(h.errors, []); assert.deepEqual(h.unexpected, []);
      assert.ok(!h.calls.some(call => ['messages', 'requests'].includes(call.action) && call.method === 'POST'));
    }
    // A compact overview is a composition of unchanged runtime screenshots.
    const list = await mobile.open(null);
    const listShot = await list.screenshot();
    const readingShot = await reader.screenshot();
    composite = await chromium.launch({ headless: true });
    const canvas = await composite.newPage({ viewport: { width: 980, height: 1030 }, deviceScaleFactor: 1 });
    await canvas.setContent(`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#f4f5fa;color:#222738;font-family:system-ui,sans-serif}header{padding:30px 54px 24px}h1{margin:0;font-size:30px;letter-spacing:-.6px}p{margin:8px 0 0;color:#61687d;font-size:16px}main{display:flex;gap:38px;justify-content:center}section{width:392px}h2{margin:0 0 12px;font-size:14px;color:#61687d;font-weight:550}img{display:block;width:392px;height:846px;border:1px solid #dce0ec;border-radius:18px;box-shadow:0 12px 32px #27364a12;object-fit:contain;background:white}footer{margin:18px 0 0;text-align:center;color:#747c90;font-size:12px}</style><header><h1>Pocket</h1><p>${zh ? '把 Codex 装进口袋。' : 'Your Codex. In your pocket.'}</p></header><main><section><h2>${zh ? '找到正在进行的事' : 'Find your ongoing work'}</h2><img src="data:image/png;base64,${listShot.toString('base64')}"></section><section><h2>${zh ? '阅读结果，继续原会话' : 'Read and continue the same conversation'}</h2><img src="data:image/png;base64,${readingShot.toString('base64')}"></section></main><footer>${zh ? '真实运行界面 · 合成示例数据' : 'Actual interface · synthetic example content'}</footer>`);
    await canvas.locator('img').last().evaluate(image => image.decode());
    const overviewPath = resolve(directory, `pocket-overview-${suffix}.png`);
    await canvas.screenshot({ path: overviewPath });
    receipt.screenshots.push({ locale, build: mobile.build, workspace: workspacePath, reading: readingPath, decisions: decisionPath, overview: overviewPath });
  } finally { await composite?.close(); await desktop.close(); await mobile.close(); await decisions.close(); }
}
console.log(JSON.stringify(receipt));

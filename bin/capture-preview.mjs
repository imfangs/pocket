#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createHarness, ids } from '../tests/browser/fixture.mjs';

// All requests are intercepted by the synthetic test harness. No real account,
// API, conversation, passphrase or model request is used to create this image.
const output = resolve('docs/assets/pocket-preview.png');
const profile = { schemaVersion: 1, defaultMachine: 'local', machines: [{ id: 'local', label: 'My Mac' }], publicOrigin: null };
const harness = await createHarness('chromium', { locale: 'en-US', clientConfiguration: profile });
let browser;
try {
  harness.seedThread(ids.empty, { title: 'Attachment checks' });
  harness.seedThread(ids.regular, { title: 'Self-hosting review', messages: [
    { id: 'preview-user', role: 'user', text: 'Review the self-hosting setup and explain what still needs testing.', timestamp: Date.now() - 90000, turnId: 'preview-turn' },
    { id: 'preview-assistant', role: 'assistant', phase: 'final', text: 'The local setup is ready.\n\n- The API stays on loopback.\n- Existing configuration is preserved.\n- Phone access uses your own HTTPS entry.\n\nNext, check the same conversation on your phone before relying on it away from your desk.', timestamp: Date.now() - 60000, turnId: 'preview-turn' },
  ] });
  const list = await harness.open(null);
  const listShot = await list.screenshot();
  await list.close();
  const conversation = await harness.open(ids.regular);
  await conversation.getByText('The local setup is ready.', { exact: false }).waitFor();
  await conversation.locator('.conversation-composer textarea').fill('Check the attachment flow next.');
  const conversationShot = await conversation.screenshot();
  assert.deepEqual(harness.errors, []); assert.deepEqual(harness.unexpected, []);
  assert.ok(!harness.calls.some(call => call.method === 'POST' && call.action === 'messages'));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 980, height: 1040 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f5fa;color:#222738;font-family:system-ui,sans-serif}
    header{padding:34px 54px 25px}h1{margin:0;font-size:30px;letter-spacing:-.6px}p{margin:8px 0 0;color:#61687d;font-size:16px}
    main{display:flex;gap:38px;justify-content:center}section{width:392px}h2{margin:0 0 12px;font-size:14px;font-weight:550;color:#61687d}
    img{display:block;width:392px;height:846px;border:1px solid #dce0ec;border-radius:18px;box-shadow:0 12px 32px #27364a12;object-fit:contain;background:white}
    footer{margin:21px 0 0;text-align:center;color:#747c90;font-size:12px}
    </style><header><h1>Pocket</h1><p>Your Mac's Codex conversations, on your phone.</p></header><main>
    <section><h2>Browse conversations</h2><img src="data:image/png;base64,${listShot.toString('base64')}"></section>
    <section><h2>Read and continue</h2><img src="data:image/png;base64,${conversationShot.toString('base64')}"></section>
    </main><footer>Actual interface · synthetic example content</footer>`);
  await page.locator('img').last().evaluate(image => image.decode());
  mkdirSync(resolve('docs/assets'), { recursive: true });
  await page.screenshot({ path: output });
  console.log(JSON.stringify({ ok: true, output, build: harness.build, synthetic: true, realModelRequests: 0 }));
} finally { await browser?.close(); await harness.close(); }

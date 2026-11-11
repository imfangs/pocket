import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_READ_MODEL_REPORT || '.local/qa/browser-read-model/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const until = async predicate => {
  const deadline = Date.now() + 8000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('Synthetic state did not arrive');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
function flow(engine, name, run) {
  test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine), run, record: result => results.push(result) }));
}

for (const engine of engines) {
  flow(engine, 'a stalled submission transport releases the composer without replay and later exact history can accept it', async h => {
    await h.addInitScript(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      // Keep the real AbortSignal/fetch path; shorten only its production
      // network budget so this regression cannot wait eighteen seconds.
      AbortSignal.timeout = ms => timeout(ms === 18000 ? 250 : ms);
    });
    const page = await h.open(); await page.getByText('已有的合成回复', { exact: true }).waitFor();
    const gate = h.pause('messages', { repeat: true });
    const input = page.getByRole('textbox', { name: '发送消息', exact: true });
    await input.fill('Synthetic stalled transport, immutable identity');
    const send = page.locator('.conversation-composer button[type="submit"]'); await send.click();
    await until(() => h.calls.find(call => call.method === 'POST' && call.action === 'messages'));
    const submitted = h.calls.find(call => call.method === 'POST' && call.action === 'messages');
    const row = page.locator(`article[data-query-id="${submitted.requestId}"]`);
    await row.waitFor(); await page.waitForTimeout(600);
    await input.fill('A separate new draft after timeout');
    assert.equal(await send.isEnabled(), true, 'A dropped POST response must not disable the next draft indefinitely');
    assert.equal(await row.getAttribute('data-query-state'), 'unknown');
    assert.equal(h.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1, 'Timeout must never replay the original POST');
    h.accept(ids.regular, submitted.requestId); h.echo(ids.regular, submitted.requestId); await refresh(page);
    await page.locator(`[data-message-id="echo-${submitted.requestId}"]`).waitFor();
    assert.equal(await row.count(), 1);
    assert.equal(await input.inputValue(), 'A separate new draft after timeout');
    gate.release(); await page.waitForTimeout(150);
    assert.equal(h.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
  });

  flow(engine, 'an authenticated disk-only exact preview can be read locally without reviving remote controls', async h => {
    const page = await h.open(); await page.getByText('已有的合成回复', { exact: true }).waitFor();
    const cached = {
      source: 'rollout', hasMore: false, checkedAt: 0,
      messages: [{ id: 'cached-only-final', role: 'assistant', phase: 'final_answer', turnId: 'cached-turn', text: 'Synthetic exact disk-only answer' }],
      pocketContent: { known: true, scope: 'smoke-ged', revision: 123, version: 'c'.repeat(64), messageId: 'cached-only-final' },
      // These intentionally cannot become control state through a reading DTO.
      runtime: 'active', canSend: true, canStop: true, activeTurnId: 'cached-turn',
    };
    await until(() => page.evaluate(({ threadId, cached }) => new Promise(resolve => {
      const request = indexedDB.open('pocket-reading-cache-v1');
      request.onupgradeneeded = () => { request.transaction.abort(); resolve(false); };
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('entries')) { db.close(); resolve(false); return; }
        const tx = db.transaction('entries', 'readwrite'), entries = tx.objectStore('entries'), all = entries.getAll();
        let seeded = false;
        all.onsuccess = () => {
          const record = all.result.find(record => record.kind === 'transcript' && record.machine === 'ged' && record.threadId === threadId);
          if (!record) return;
          const json = JSON.stringify(cached), now = Date.now();
          entries.put({ ...record, json, savedAt: now, accessedAt: now, observedAt: now, contentRevision: 123,
            bytes: new TextEncoder().encode(json).byteLength + record.key.length * 2 + 512 });
          seeded = true;
        };
        tx.onabort = tx.onerror = () => { db.close(); resolve(false); };
        tx.oncomplete = () => { db.close(); resolve(seeded); };
      };
    }), { threadId: ids.regular, cached }));
    const gates = [h.pause('history', { repeat: true }), h.pause('transcript', { repeat: true })];
    await page.reload();
    await page.getByText('Synthetic exact disk-only answer', { exact: true }).waitFor();
    await page.waitForTimeout(180);
    const seen = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pocket.read.v1.'))
      .map(key => JSON.parse(localStorage.getItem(key))).find(entry => entry.seen?.messageId === 'cached-only-final')?.seen);
    assert.equal(seen?.revision, 123, 'The exact visible cached version must advance the local read watermark');
    assert.equal(await page.locator('.stop-execution, .conversation-working').count(), 0);
    assert.equal(h.calls.some(call => call.action === 'read' || call.action.startsWith('stop') || call.action === 'messages'), false,
      'Reading cached text must not send, stop, or write native read state');
    gates.forEach(gate => gate.release());
  });
}

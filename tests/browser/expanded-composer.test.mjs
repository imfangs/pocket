import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_COMPOSER_REPORT || '.local/qa/interface-expansion-2026-11-09/composer/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const until = async predicate => {
  const end = Date.now() + 8000;
  while (!await predicate()) {
    assert.ok(Date.now() < end, 'Expected dynamic composer state did not arrive');
    await new Promise(done => setTimeout(done, 20));
  }
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const composer = page => page.locator('.conversation-composer textarea');
const submit = page => page.locator('.conversation-composer button[type="submit"]');
const row = (page, id) => page.locator(`article[data-query-id="${id}"]`);
const status = (page, id, value) => page.locator(`article[data-query-id="${id}"][data-query-state="${value}"]`).waitFor();
const longText = '中文长文需要保留全部正文、行末标点和恢复后的草稿。\n'.repeat(20) + 'END';
// Page routes take precedence over the fixture's context route. Only the exact
// synthetic task/endpoints below are handled; all other traffic still fails
// closed in fixture.mjs. No network request is ever continued.
const routeTask = async (page, suffix, calls, handler) => {
  const expression = new RegExp(`/api/(?:machines/[a-z][a-z0-9-]*/)?tasks/${ids.regular}/(?:${suffix})$`);
  await page.route(expression, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const call = { method: request.method(), path, input: request.postData() ? request.postDataJSON() : undefined };
    calls.push(call);
    const response = await handler(call);
    await route.fulfill({ status: response.http || 200, contentType: 'application/json',
      headers: { 'cache-control': 'no-store' }, body: JSON.stringify(response.body) });
    call.completed = true;
  });
};
const fitControls = async root => {
  const boxes = await root.locator('button').evaluateAll(nodes => nodes.filter(node => !node.disabled).map(node => {
    const box = node.getBoundingClientRect(), region = node.closest('.approval-card, .question-card, article[data-query-id]')?.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(node); const text = range.getBoundingClientRect();
    return { label: node.textContent, left: box.left, right: box.right, height: box.height,
      textLeft: text.left, textRight: text.right, regionLeft: region?.left, regionRight: region?.right, width: innerWidth };
  }));
  for (const box of boxes) {
    assert.ok(box.left >= -1 && box.right <= box.width + 1, JSON.stringify(box));
    assert.ok(box.textLeft >= box.left - 1 && box.textRight <= box.right + 1, JSON.stringify(box));
    assert.ok(box.height >= 44, JSON.stringify(box));
  }
};
const ordinaryDraft = 'Keep the newer ordinary draft. 下一条消息不能被迟到回执覆盖。';
const question = { id: 'optional', key: 'a'.repeat(64), sourceMessageId: ids.regular + '-a', turnId: 'initial',
  title: 'Which approach should we take? 请选择下一步方案。', options: ['First option', 'Second option'] };
const optionalHistory = () => ({ asyncQuestions: [question], turnTiming: { turnId: 'initial', startedAt: Date.now() - 3000 } });
const request = { key: 'blocking-question', kind: 'questions', reason: 'Synthetic blocking question / 合成阻塞问题', cwd: '', choices: [],
  questions: [{ id: 'answer', question: 'Answer this question / 请填写回答' }] };
const flow = (engine, locale, name, run) => test(`${engine} ${locale}: ${name}`, { timeout: 30000 }, () => runScenario({
  engine, name: `${locale} ${name}`, create: () => createHarness(engine, { width: locale === 'en-US' ? 320 : 390, locale }),
  record: result => results.push(result), run,
}));

for (const engine of engines) for (const locale of ['zh-CN', 'en-US']) {
  flow(engine, locale, 'failed send restores without replacing a newer draft; unknown only checks; acceptance keeps one row', async h => {
    const page = await h.open(), calls = [], receipts = new Map();
    let outcome = 'rejected';
    await routeTask(page, 'messages(?:/[^/]+)?', calls, async call => {
      if (call.method === 'POST') {
        const { requestId, text } = call.input; receipts.set(requestId, outcome);
        assert.equal(text, longText);
        return { body: { requestId, status: outcome } };
      }
      assert.equal(call.method, 'GET');
      const requestId = call.path.split('/').at(-1);
      return { body: { requestId, status: receipts.get(requestId) || 'not_found' } };
    });
    await composer(page).fill(longText); await submit(page).click();
    await until(() => calls.some(call => call.method === 'POST'));
    const rejected = calls.find(call => call.method === 'POST').input.requestId;
    await status(page, rejected, 'rejected');
    await composer(page).fill(ordinaryDraft);
    const edit = row(page, rejected).locator('.submitted-query-actions button').first();
    await edit.click(); await row(page, rejected).getByRole('alert').waitFor();
    assert.equal(await composer(page).inputValue(), ordinaryDraft);
    assert.equal(await row(page, rejected).locator('.query-body-content').textContent(), longText);
    await composer(page).fill(''); await edit.click();
    await until(async () => await composer(page).inputValue() === longText);
    outcome = 'unknown'; await submit(page).click();
    await until(() => calls.filter(call => call.method === 'POST').length === 2);
    const unknown = calls.filter(call => call.method === 'POST')[1].input.requestId;
    await status(page, unknown, 'unknown');
    await composer(page).fill(ordinaryDraft);
    await fitControls(row(page, unknown));
    await row(page, unknown).locator('.submitted-query-primary-actions button').last().click();
    await until(() => calls.some(call => call.method === 'GET' && call.path.endsWith('/' + unknown)));
    assert.equal(calls.filter(call => call.method === 'POST').length, 2, 'Checking never replays a message');
    assert.equal(await row(page, unknown).locator('.submitted-query-actions').count(), 0, 'Unknown cannot be edited or dismissed');
    receipts.set(unknown, 'accepted');
    await row(page, unknown).locator('.submitted-query-primary-actions button').last().click();
    await status(page, unknown, 'accepted');
    assert.equal(await composer(page).inputValue(), ordinaryDraft);
    assert.equal(await row(page, unknown).count(), 1);
    assert.equal(await page.locator('.conversation-working').count(), 0, 'accepted is not running/completed evidence');
    assert.equal(calls.filter(call => call.method === 'POST').length, 2);
  });

  flow(engine, locale, 'queue edit failure retains text; discard pauses; resume/retry/delete and unknown check use exact revisions', async h => {
    const items = [
      { id: 'queue-first', text: longText, status: 'queued', revision: 0, createdAt: Date.now() },
      { id: 'queue-unknown', text: 'Unknown must never replay', status: 'unknown', revision: 0, createdAt: Date.now() + 1 },
    ];
    const patch = () => h.patchHistory(ids.regular, { outbox: items.map(item => ({ ...item })) }); patch();
    const page = await h.open(), calls = []; let saveFails = true, sendFails = true;
    await routeTask(page, 'outbox/queue-first(?:/(?:edit|resume|send))?', calls, async call => {
      const item = items[0]; assert.equal(call.input.expectedRevision, item.revision);
      const action = call.path.split('/').at(-1);
      if (action === 'edit') { assert.equal(call.method, 'POST'); item.status = 'editing'; item.revision++; }
      else if (action === 'resume') { assert.equal(call.method, 'POST'); item.status = 'queued'; item.revision++; }
      else if (action === 'send') {
        assert.equal(call.method, 'POST'); item.status = sendFails ? 'rejected' : 'accepted'; sendFails = false;
        patch(); return { body: { requestId: item.id, status: item.status } };
      } else if (call.method === 'PATCH') {
        if (saveFails) { saveFails = false; return { http: 409, body: { error: '合成保存冲突，请重试。' } }; }
        item.text = call.input.text; item.status = 'queued'; item.revision++;
      } else { assert.equal(call.method, 'DELETE'); items.shift(); }
      patch(); return { body: { outbox: items.map(item => ({ ...item })) } };
    });
    await routeTask(page, 'messages/queue-unknown', calls, call => {
      assert.equal(call.method, 'GET'); return { body: { requestId: 'queue-unknown', status: 'unknown' } };
    });
    const first = row(page, 'queue-first'), edit = first.locator('[data-outbox-action="edit"]');
    await edit.click(); const editor = first.locator('textarea'); await editor.waitFor();
    assert.equal(await editor.evaluate(node => document.activeElement === node), true);
    const revised = longText + '\nEDIT'; await editor.fill(revised);
    await first.locator('.outbox-actions button').first().click(); await first.getByRole('alert').waitFor();
    assert.equal(await editor.inputValue(), revised); assert.equal(await editor.isEnabled(), true);
    await first.locator('.outbox-actions button').nth(1).click(); await editor.waitFor({ state: 'detached' });
    assert.equal(items[0].status, 'editing', 'Discard only drops local edits; server item stays paused');
    assert.equal(await edit.evaluate(node => document.activeElement === node), true);
    await first.locator('.outbox-actions button').last().click();
    await until(() => items[0].status === 'queued');
    await first.locator('[data-query-editing]').waitFor({ state: 'detached' });
    await edit.click(); await editor.waitFor(); assert.equal(await editor.inputValue(), longText);
    await editor.fill(revised); await first.locator('.outbox-actions button').first().click();
    await editor.waitFor({ state: 'detached' }); assert.equal(items[0].text, revised);
    await fitControls(first);
    await first.locator('.outbox-actions button').last().click(); await status(page, 'queue-first', 'rejected');
    await first.locator('.outbox-actions button').last().click(); await status(page, 'queue-first', 'accepted');
    const unknown = row(page, 'queue-unknown');
    assert.equal(await unknown.locator('.outbox-actions button').count(), 1);
    const writes = calls.filter(call => call.method !== 'GET').length;
    await unknown.locator('.outbox-actions button').click(); await until(() => calls.some(call => call.path.endsWith('/messages/queue-unknown')));
    assert.equal(calls.filter(call => call.method !== 'GET').length, writes);
    // Delete a separate mutable item; acceptance has no editable/cancel action.
    items.unshift({ id: 'queue-first', text: 'Delete only this queued entry', status: 'queued', revision: 10, createdAt: Date.now() });
    // A fresh ID must be used: an accepted request identity cannot resurrect.
    items[0].id = 'queue-delete'; patch();
    await routeTask(page, 'outbox/queue-delete', calls, call => {
      assert.equal(call.method, 'DELETE'); assert.equal(call.input.expectedRevision, 10); items.shift(); patch();
      return { body: { outbox: items.map(item => ({ ...item })) } };
    });
    await refresh(page); const deleted = row(page, 'queue-delete'); await deleted.waitFor();
    await deleted.locator('.outbox-actions button').nth(1).click(); await deleted.waitFor({ state: 'detached' });
    assert.equal(items.some(item => item.id === 'queue-delete'), false);
  });

  flow(engine, locale, 'optional answer preserves custom draft on ignore, reject, unknown and remount; check never posts', async h => {
    h.patchHistory(ids.regular, optionalHistory());
    const page = await h.open(), calls = []; let outcome = 'reject', receiptId;
    await routeTask(page, `questions/${question.key}/answer|messages/[^/]+`, calls, call => {
      if (call.method === 'POST') {
        assert.equal(call.input.text, longText); receiptId = call.input.requestId;
        if (outcome === 'reject') { outcome = 'unknown'; return { http: 409, body: { error: '合成回答失败，请重试。' } }; }
        return { http: 503, body: { error: '合成回答回执丢失。' } };
      }
      assert.equal(call.method, 'GET'); assert.ok(call.path.endsWith('/' + receiptId));
      return { body: { requestId: receiptId, status: outcome === 'accepted' ? 'accepted' : 'unknown' } };
    });
    let card = page.locator('.question-card');
    await composer(page).fill(ordinaryDraft); await card.locator('.question-custom').click();
    await card.locator('textarea').fill(longText);
    await card.locator('.question-submit .question-ignore').first().click();
    assert.equal(await card.locator('textarea').count(), 0);
    await card.locator('.question-answer-toggle').click();
    assert.equal(await card.locator('textarea').inputValue(), longText);
    await card.locator('.question-submit button[type="submit"]').click(); await card.getByRole('alert').waitFor();
    assert.equal(await card.locator('textarea').inputValue(), longText); assert.equal(await card.locator('textarea').isEnabled(), true);
    await card.locator('.question-submit button[type="submit"]').click();
    await until(async () => await card.locator('textarea').isDisabled());
    await card.locator('.question-submit button[type="submit"]:not([disabled])').waitFor();
    await page.locator('[data-inspector-close]').click(); await page.locator('.inspector').waitFor({ state: 'detached' });
    await page.locator(`[data-swipe-row-id="${ids.regular}"] .task-select`).click();
    card = page.locator('.question-card'); await card.locator('textarea').waitFor();
    await page.waitForTimeout(350); // Finish the actual inspector entry transition before measuring.
    assert.equal(await card.locator('textarea').inputValue(), longText); assert.equal(await card.locator('textarea').isDisabled(), true);
    await fitControls(card);
    await card.locator('.question-submit button[type="submit"]').click();
    await until(() => calls.some(call => call.method === 'GET'));
    assert.equal(calls.filter(call => call.method === 'POST').length, 2);
    assert.equal(await composer(page).inputValue(), ordinaryDraft);
    outcome = 'accepted'; await card.locator('.question-submit button[type="submit"]:not([disabled])').click();
    await card.locator('textarea').waitFor({ state: 'detached' });
    await card.locator('.question-custom').click();
    assert.equal(await card.locator('textarea').inputValue(), '');
    assert.equal(calls.filter(call => call.method === 'POST').length, 2);
    assert.equal(await composer(page).inputValue(), ordinaryDraft);
  });

  flow(engine, locale, 'blocking answer rejects then only checks unknown, retaining input and a newer ordinary draft', async h => {
    h.patchHistory(ids.regular, { pendingRequests: [request] });
    const page = await h.open(), calls = []; let outcome = 'reject', responseId;
    await routeTask(page, `requests/${request.key}/respond|responses/[^/]+`, calls, call => {
      if (call.method === 'POST') {
        responseId = call.input.responseId; assert.deepEqual(call.input.answers, { answer: longText });
        if (outcome === 'reject') { outcome = 'unknown'; return { http: 409, body: { error: '合成响应失败，请重试。' } }; }
        return { http: 503, body: { error: '合成响应结果未知。' } };
      }
      assert.equal(call.method, 'GET'); assert.ok(call.path.endsWith('/' + responseId));
      return { body: { responseId, status: outcome === 'accepted' ? 'accepted' : 'unknown' } };
    });
    const card = page.locator('.approval-card'), input = card.locator('textarea'), action = card.locator('.approval-buttons button').last();
    await composer(page).fill(ordinaryDraft); await input.fill(longText); await action.click(); await card.getByRole('alert').waitFor();
    assert.equal(await input.inputValue(), longText); assert.equal(await input.isEnabled(), true);
    await action.click(); await until(async () => await input.isDisabled());
    await action.locator(':scope:not([disabled])').waitFor(); await action.click();
    await until(() => calls.some(call => call.method === 'GET'));
    assert.equal(calls.filter(call => call.method === 'POST').length, 2);
    assert.equal(await input.inputValue(), longText); assert.equal(await composer(page).inputValue(), ordinaryDraft);
    await fitControls(card);
    outcome = 'accepted'; await action.locator(':scope:not([disabled])').click();
    await until(async () => await input.inputValue() === '');
    assert.equal(await input.isDisabled(), true, 'accepted waits for owner update');
    assert.equal(calls.filter(call => call.method === 'POST').length, 2);
    assert.equal(await composer(page).inputValue(), ordinaryDraft);
  });

  flow(engine, locale, 'permission approval only checks after uncertainty and disappears on fresh owner update', async h => {
    const permission = { key: 'permission-request', kind: 'permissions', reason: 'Allow only this synthetic turn / 仅本轮合成权限',
      details: 'Synthetic filesystem permission: /synthetic/read-only', cwd: '/synthetic', choices: ['accept', 'cancel'] };
    h.patchHistory(ids.regular, { pendingRequests: [permission] });
    const page = await h.open(), calls = []; let responseId, outcome = 'unknown';
    await routeTask(page, `requests/${permission.key}/respond|responses/[^/]+`, calls, call => {
      if (call.method === 'POST') {
        responseId = call.input.responseId;
        assert.deepEqual(Object.keys(call.input).sort(), ['decision', 'responseId']); assert.equal(call.input.decision, 'accept');
        return { http: 503, body: { error: '合成审批结果未知。' } };
      }
      assert.equal(call.method, 'GET'); assert.ok(call.path.endsWith('/' + responseId));
      return { body: { responseId, status: outcome } };
    });
    const card = page.locator('.approval-card'); await fitControls(card);
    await card.locator('.approval-buttons button').last().click(); await card.getByRole('alert').waitFor();
    await composer(page).fill(ordinaryDraft);
    const check = card.locator('.approval-buttons button'); assert.equal(await check.count(), 1);
    await check.click(); await until(() => calls.some(call => call.method === 'GET'));
    outcome = 'accepted'; await check.locator(':scope:not([disabled])').click();
    await until(() => calls.filter(call => call.method === 'GET').length === 2);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1, 'Approval never expands scope or replays');
    assert.equal(await composer(page).inputValue(), ordinaryDraft);
    h.patchHistory(ids.regular, { pendingRequests: [] }); await refresh(page); await card.waitFor({ state: 'detached' });
    assert.equal(await composer(page).inputValue(), ordinaryDraft);
  });

  for (const surface of ['optional', 'blocking']) flow(engine, locale, `${surface} language changes and fresh history retain the actual focused answer node`, async h => {
    h.patchHistory(ids.regular, surface === 'optional' ? optionalHistory() : { pendingRequests: [request] });
    const page = await h.open();
    const card = page.locator(surface === 'optional' ? '.question-card' : '.approval-card');
    if (surface === 'optional') await card.locator('.question-custom').click();
    const input = card.locator('textarea'); await input.fill(longText);
    await input.evaluate(node => { window.composerAnswerNode = node; node.setSelectionRange(2, 5); });
    await page.evaluate(value => {
      localStorage.setItem('pocket.language.v1', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'pocket.language.v1', newValue: value }));
    }, locale === 'en-US' ? 'zh-CN' : 'en');
    await refresh(page); await page.waitForTimeout(200);
    assert.equal(await input.evaluate(node => node === window.composerAnswerNode && document.activeElement === node), true);
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [2, 5]);
    assert.equal(await input.inputValue(), longText); await fitControls(card);
    assert.equal(h.calls.filter(call => call.method === 'POST' && call.action !== 'sync').length, 0);
  });

  for (const surface of ['optional', 'blocking']) for (const phase of ['POST', 'GET']) flow(engine, locale, `${surface} answer never clears a draft on a mismatched accepted ${phase} receipt`, async h => {
    h.patchHistory(ids.regular, surface === 'optional' ? optionalHistory() : { pendingRequests: [request] });
    const page = await h.open(), calls = [], pending = deferred();
    const suffix = surface === 'optional' ? `questions/${question.key}/answer|messages/[^/]+` : `requests/${request.key}/respond|responses/[^/]+`;
    let originalId;
    await routeTask(page, suffix, calls, async call => {
      if (call.method === 'POST') {
        originalId = call.input[surface === 'optional' ? 'requestId' : 'responseId'];
        if (phase === 'GET') return { body: { [surface === 'optional' ? 'requestId' : 'responseId']: originalId, status: 'unknown' } };
      } else { assert.equal(call.method, 'GET'); assert.ok(call.path.endsWith('/' + originalId)); }
      await pending.promise;
      return { body: { [surface === 'optional' ? 'requestId' : 'responseId']: 'different-request', status: 'accepted' } };
    });
    const card = page.locator(surface === 'optional' ? '.question-card' : '.approval-card');
    if (surface === 'optional') await card.locator('.question-custom').click();
    const input = card.locator('textarea'); await input.fill(longText);
    await card.locator(surface === 'optional' ? '.question-submit button[type="submit"]' : '.approval-buttons button').last().click();
    await until(() => calls.length === 1);
    if (phase === 'GET') {
      const check = card.locator(surface === 'optional' ? '.question-submit button[type="submit"]' : '.approval-buttons button').last();
      await check.locator(':scope:not([disabled])').waitFor(); await check.click(); await until(() => calls.length === 2);
    }
    await composer(page).fill(ordinaryDraft); pending.resolve();
    await until(() => calls.at(-1).completed); await page.waitForTimeout(200);
    assert.equal(await input.count(), 1, 'An unrelated accepted receipt cannot remove the custom answer editor');
    assert.equal(await input.inputValue(), longText, 'A receipt for another request cannot acknowledge or erase this answer');
    await card.getByRole('alert').waitFor();
    assert.equal(await input.isDisabled(), true, 'Unknown outcome holds the answer until its exact receipt is checked');
    assert.equal(await composer(page).inputValue(), ordinaryDraft);
    assert.equal(await composer(page).evaluate(node => document.activeElement === node), true, 'Late receipt cannot steal newer input focus');
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  });
}

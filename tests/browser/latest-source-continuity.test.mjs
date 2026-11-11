import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';

const results = [];
after(() => {
  const path = resolve(process.env.POCKET_LATEST_SOURCE_REPORT || '.local/qa/browser-latest-source/scenarios.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ scenarios: results }, null, 2) + '\n');
});
const now = Date.now();
const message = (id, text, role = 'assistant', turnId = 'current', extra = {}) => ({
  id, text, role, turnId, timestamp: now, ...(role === 'assistant' ? { phase: 'final_answer' } : {}), ...extra,
});
const paragraphs = label => Array.from({ length: 22 }, (_, index) => `${label} ${index}. Synthetic reading position stays with this complete paragraph.`).join('\n\n');
const prefix = Array.from({ length: 4 }, (_, index) => [
  message(`prefix-query-${index}`, `Earlier synthetic query ${index}.`, 'user', `older-${index}`),
  message(`prefix-answer-${index}`, paragraphs(`Earlier synthetic answer ${index}`), 'assistant', `older-${index}`),
]).flat();
const originalFinal = paragraphs('Original latest result');
const freshFinal = paragraphs('Fresh saved result');
const tail = [
  message('latest-query', 'Current synthetic query.', 'user'),
  message('latest-progress-1', 'Synthetic process one.', 'assistant', 'current', { phase: 'commentary' }),
  message('latest-interruption', 'Synthetic correction.', 'user'),
  message('latest-progress-2', 'Synthetic process two.', 'assistant', 'current', { phase: 'commentary' }),
  message('latest-final', originalFinal),
];
const native = [...prefix, ...tail];
// Two earlier entries recur under their exact original identities. The caller
// still receives every raw row; only the rendered list may remove exact copies.
const duplicateNative = [...prefix.slice(0, 2), ...prefix.slice(0, 2).map(row => ({ ...row })), ...prefix.slice(2), ...tail];
const timing = (turnId = 'current', status = 'completed') => ({ turnId, status, startedAt: now - 1000,
  durationMs: status === 'completed' ? 1000 : null, observedAt: now });
const history = (messages, source = 'desktop', extra = {}) => ({ messages, source, hasMore: true,
  resumeState: source === 'desktop' ? 'resumed' : 'not_loaded', runtime: 'idle', canSend: source === 'desktop',
  canStop: false, activeTurnId: null, latestTurnId: messages.at(-1)?.turnId, latestTurnStatus: 'completed',
  turnTiming: timing(messages.at(-1)?.turnId), outbox: [], pendingRequests: [], asyncQuestions: [], ...extra });
const transcript = (messages, extra = {}) => ({ messages, hasMore: true, source: 'rollout', turnTiming: timing(messages.at(-1)?.turnId),
  pocketContent: { known: true, scope: 'smoke-ged', revision: 123,
    version: createHash('sha256').update(JSON.stringify(messages)).digest('hex'), messageId: messages.at(-1)?.id }, ...extra });
function install(h, nativeMessages = native, savedMessages = tail, nativeExtra = {}, savedExtra = {}) {
  h.patchHistory(ids.regular, history(nativeMessages, 'desktop', nativeExtra));
  h.patchTranscript(ids.regular, transcript(savedMessages, savedExtra));
}
const finalRow = page => page.locator('[data-message-id="latest-final"]');
const root = page => page.locator('.conversation-messages');
async function settle(page) { await page.waitForTimeout(200); }
async function reload(h, page) {
  const count = h.count('history'); await refresh(page);
  const deadline = Date.now() + 8000;
  while (h.count('history') <= count) {
    if (Date.now() > deadline) throw new Error('Synthetic latest source read did not arrive');
    await new Promise(done => setTimeout(done, 20));
  }
  await settle(page);
}
const geometry = page => root(page).evaluate(element => {
  const final = element.querySelector('[data-message-id="latest-final"]').getBoundingClientRect();
  return { top: element.scrollTop, max: element.scrollHeight - element.clientHeight,
    finalTop: final.top - element.getBoundingClientRect().top,
    ids: [...element.querySelectorAll('[data-message-id]')].map(row => row.dataset.messageId) };
});
async function away(page, distance = 350) {
  await root(page).evaluate((element, distance) => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - distance); }, distance);
  await settle(page);
  assert.ok(await root(page).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop > 100), 'Fixture must be deliberately away from latest');
}
const seenState = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('pocket.read.v1.')).sort()
  .map(key => ({ key, seen: JSON.parse(localStorage.getItem(key)).seen })));
function flow(engine, name, run) {
  test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine), run, record: result => results.push(result) }));
}

for (const engine of engines) {
  flow(engine, 'exact duplicate native rows stay unique through repeated saved/native source transitions', async h => {
    install(h, duplicateNative); const page = await h.open(); await finalRow(page).waitFor(); await settle(page);
    const counts = [(await geometry(page)).ids.length];
    for (let round = 0; round < 3; round++) {
      h.patchHistory(ids.regular, history(tail, 'rollout')); await reload(h, page);
      counts.push((await geometry(page)).ids.length);
      h.patchHistory(ids.regular, history(duplicateNative)); await reload(h, page);
      counts.push((await geometry(page)).ids.length);
    }
    assert.deepEqual(counts, Array(7).fill(native.length), 'No duplicate or orphan DOM rows may accumulate when sources alternate');
    const visible = (await geometry(page)).ids;
    assert.equal(new Set(visible).size, native.length);
    assert.equal(await root(page).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 1), true);
  });

  flow(engine, 'a short rollout tail retains the readable prefix while a non-prefix final updates in place', async h => {
    install(h); const page = await h.open(); await finalRow(page).waitFor(); await settle(page); await away(page);
    const before = await geometry(page);
    const fresh = tail.map(row => row.id === 'latest-final' ? { ...row, text: freshFinal } : row);
    h.patchHistory(ids.regular, history(fresh, 'rollout')); h.patchTranscript(ids.regular, transcript(fresh));
    await reload(h, page);
    assert.match(await finalRow(page).textContent(), /Fresh saved result/);
    assert.equal(await page.locator('[data-message-id="prefix-query-0"]').count(), 1, 'A shorter successful fallback must keep the established earlier prefix');
    const after = await geometry(page);
    assert.equal(after.ids.length, native.length);
    assert.ok(Math.abs(after.finalTop - before.finalTop) <= 2, `Latest final offset changed from ${before.finalTop} to ${after.finalTop}`);
    assert.ok(after.max - after.top > 100, 'A source refresh must not silently attach an away reader to bottom');
  });

  flow(engine, 'a late native prefix keeps the saved latest reader at the same message offset', async h => {
    install(h); const gate = h.pause('history', { repeat: true });
    const page = await h.open(); await finalRow(page).waitFor(); await settle(page);
    assert.equal((await geometry(page)).ids.length, tail.length);
    await away(page); const before = await geometry(page);
    gate.release(); await page.locator('[data-message-id="prefix-query-0"]').waitFor({ state: 'attached' }); await settle(page);
    const after = await geometry(page);
    assert.equal(after.ids.length, native.length);
    assert.ok(Math.abs(after.finalTop - before.finalTop) <= 2, `Late native offset changed from ${before.finalTop} to ${after.finalTop}`);
    assert.ok(after.max - after.top > 100);
  });

  flow(engine, 'a transcript-only expansion above the latest reader restores its anchor with native history still pending', async h => {
    install(h); const page = await h.open(); await finalRow(page).waitFor(); await settle(page);
    // Require Pocket's restoration itself. CSS scroll anchoring is not
    // guaranteed on every browser or on every real source-layout transition.
    await root(page).evaluate(element => { element.style.overflowAnchor = 'none'; });
    await away(page); const before = await geometry(page);
    const gate = h.pause('history', { repeat: true });
    const extended = { ...prefix[1], text: prefix[1].text + '\n\n' + paragraphs('Fresh transcript expansion above reader') };
    h.patchTranscript(ids.regular, transcript([extended, ...tail]));
    const reads = h.count('transcript'); await refresh(page);
    const deadline = Date.now() + 8000;
    while (h.count('transcript') <= reads) {
      if (Date.now() > deadline) throw new Error('Synthetic transcript-only update did not arrive');
      await new Promise(done => setTimeout(done, 20));
    }
    await settle(page);
    assert.match(await page.locator('[data-message-id="prefix-answer-0"]').textContent(), /Fresh transcript expansion above reader/);
    const after = await geometry(page);
    assert.ok(Math.abs(after.finalTop - before.finalTop) <= 2, `Transcript-only offset changed from ${before.finalTop} to ${after.finalTop}`);
    assert.ok(after.max - after.top > 100);
    gate.release();
  });

  flow(engine, 'retaining an earlier prefix does not freeze a new turn or its native completion', async h => {
    install(h); const page = await h.open(); await finalRow(page).waitFor(); await settle(page); await away(page);
    const incoming = [message('next-query', 'Fresh next-turn query.', 'user', 'next'),
      message('next-progress', 'Fresh next-turn process.', 'assistant', 'next', { phase: 'commentary' })];
    h.patchHistory(ids.regular, history([...tail, ...incoming], 'rollout', { latestTurnStatus: 'inProgress', turnTiming: timing('next', 'inProgress') }));
    h.patchTranscript(ids.regular, transcript([...tail, ...incoming], { turnTiming: timing('next', 'inProgress') }));
    await reload(h, page);
    assert.equal(await page.locator('[data-message-id="prefix-query-0"]').count(), 1);
    assert.match(await page.locator('[data-message-id="next-query"]').textContent(), /Fresh next-turn query/);
    assert.match(await page.locator('[data-message-id="next-progress"]').textContent(), /Fresh next-turn process/);
    const completion = message('next-final', 'Fresh native completion.', 'assistant', 'next');
    h.patchHistory(ids.regular, history([...native, ...incoming, completion]));
    await reload(h, page);
    assert.match(await page.locator('[data-message-id="next-final"]').textContent(), /Fresh native completion/);
    assert.equal(await page.locator('[data-message-id="next-final"]').count(), 1);
  });

  flow(engine, 'readable retained text cannot preserve old owner controls or grant a mismatched saved read marker', async h => {
    const running = [message('running-query', 'Synthetic active-owner query.', 'user', 'running'),
      message('running-progress', 'Synthetic active-owner process.', 'assistant', 'running', { phase: 'commentary' })];
    install(h, [...native, ...running], tail, { runtime: 'active', canStop: true, activeTurnId: 'running', latestTurnStatus: 'inProgress', turnTiming: timing('running', 'inProgress') });
    const page = await h.open(); await page.locator('.conversation-working').waitFor();
    assert.equal(await page.locator('.stop-execution').count(), 1);
    await away(page, 600); const beforeSeen = await seenState(page);
    const fresh = [...tail.map(row => row.id === 'latest-final' ? { ...row, text: freshFinal } : row),
      ...running.map(row => row.id === 'running-progress' ? { ...row, text: 'Fresh fallback process text for the same running turn.' } : row)];
    // The saved marker still describes the old final. Fresh fallback text has
    // the same ID but different body, so retained display cannot authorize it.
    h.patchHistory(ids.regular, history(fresh, 'rollout')); await reload(h, page);
    assert.match(await finalRow(page).textContent(), /Fresh saved result/);
    assert.match(await page.locator('[data-message-id="running-progress"]').textContent(), /Fresh fallback process text/);
    assert.equal(await page.locator('[data-message-id="prefix-query-0"]').count(), 1);
    assert.equal(await page.locator('.conversation-working').count(), 0);
    assert.equal(await page.locator('.stop-execution').count(), 0);
    assert.deepEqual(await seenState(page), beforeSeen, 'A mismatched saved marker cannot advance Pocket seen state');
    assert.equal(h.calls.filter(call => call.action === 'read' || call.action.startsWith('stop') || call.action === 'messages' || call.action.startsWith('messages/')).length, 0,
      'Presentation retention must not send, check a receipt, stop, or issue a native read write');
  });

  flow(engine, 'conflicting same-ID user rows preserve both source bodies despite a shared submission identity', async h => {
    install(h); const page = await h.open(); await finalRow(page).waitFor(); await settle(page);
    const input = page.locator('.conversation-composer textarea'), query = 'Original synthetic submitted text.';
    await input.fill(query); await page.locator('.conversation-composer button[type="submit"]').click();
    const deadline = Date.now() + 8000;
    while (!h.calls.some(call => call.action === 'messages' && call.method === 'POST')) {
      if (Date.now() > deadline) throw new Error('Synthetic submission did not arrive');
      await new Promise(done => setTimeout(done, 20));
    }
    const requestId = h.calls.find(call => call.action === 'messages' && call.method === 'POST').requestId;
    h.accept(ids.regular, requestId);
    const conflicting = [message('conflicting-user', query, 'user', 'sent', { clientMessageId: requestId }),
      message('conflicting-user', 'Different synthetic source text under the same identity.', 'user', 'sent', { clientMessageId: requestId })];
    h.patchHistory(ids.regular, history([...native, ...conflicting]));
    h.patchTranscript(ids.regular, transcript([...tail, ...conflicting]));
    for (let round = 0; round < 3; round++) {
      await reload(h, page);
      const rows = page.locator('[data-message-id="conflicting-user"]');
      assert.equal(await rows.count(), 2, 'Conflicting records must retain two source rows without orphan copies');
      const texts = await rows.allTextContents();
      assert.match(texts[0], /Original synthetic submitted text/);
      assert.match(texts[1], /Different synthetic source text/);
    }
    assert.equal(h.calls.filter(call => call.action === 'messages' && call.method === 'POST').length, 1, 'Rendering conflicts must never submit again');
  });
}

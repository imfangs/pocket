import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHarness, engines, ids, pullFromTop, refresh } from './fixture.mjs';
import { runScenario } from './scenario.mjs';
import { inspectorReturnFlows } from './inspectorReturnFlows.mjs';

const results = [];
const output = resolve(process.env.POCKET_BROWSER_REPORT || '.local/qa/browser-smoke/results.json');
after(() => { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify({ scenarios: results }, null, 2) + '\n'); });
const until = async predicate => {
  const deadline = Date.now() + 8000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Synthetic request did not arrive'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const info = page => page.getByRole('dialog', { name: '会话信息', exact: true });
const infoGeometry = page => info(page).locator('.conversation-info').evaluate(element => ({ height: element.getBoundingClientRect().height,
  closeFocused: document.activeElement === element.closest('dialog').querySelector('[aria-label="关闭对话框"]') }));
const openInfo = async page => { await page.locator('.inspector-title-trigger').click(); await info(page).waitFor(); await page.waitForTimeout(240); };
const closeInfo = async page => { await page.keyboard.press('Escape'); await info(page).waitFor({ state: 'detached' }); };
const threadRow = (page, id = ids.regular) => page.locator(`[data-swipe-row-id="${id}"]`);
const selectView = async (page, view) => {
  const menu = page.getByRole('button', { name: '打开导航', exact: true });
  if (await menu.isVisible()) await menu.click();
  const item = view === 'archived' ? page.locator('.sidebar').getByRole('button', { name: '已归档', exact: true })
    : page.locator(`.sidebar button[data-view="${view}"]`);
  await item.click();
  await page.locator('.sidebar.mobile-open').waitFor({ state: 'detached' });
};
const swipeHiddenRow = async row => {
  await row.locator('.row-hidden-shortcut:not([disabled])').waitFor({ state: 'attached' });
  const ghostSuppressed = await row.locator('.task-select').evaluate(async element => {
    const box = element.getBoundingClientRect(), x = box.right - 16, y = box.top + box.height / 2;
    for (const [type, offset, ended] of [['touchstart', 0, false], ['touchmove', -55, false], ['touchmove', -115, false], ['touchend', -190, true]]) {
      const touch = { identifier: 1, target: element, clientX: x + offset, clientY: y };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: ended ? [] : [touch] }, changedTouches: { value: [touch] } });
      element.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 20));
    }
    const ghost = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    element.dispatchEvent(ghost);
    return ghost.defaultPrevented;
  });
  assert.equal(ghostSuppressed, true, 'A swipe cannot also open the conversation');
  await row.locator('.row-hidden-action:not([disabled])').waitFor({ state: 'attached' });
  assert.equal(await row.getAttribute('data-swipe-open'), 'true');
  assert.equal(await row.locator('.row-swipe-actions').evaluate(element => element.getBoundingClientRect().width), 168);
};
const preservedMetadata = thread => ({ archived: thread.archived, pocketPriority: thread.pocketPriority,
  codexPinned: thread.codexPinned, hasUnreadTurn: thread.hasUnreadTurn, runtime: thread.runtime,
  updatedAt: thread.updatedAt, lastMessageAt: thread.lastMessageAt });
const waitForStoredHidden = async (page, threadId, hidden) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    // waitForFunction treats the Promise itself as truthy. Resolve each IDB
    // read in Node and inspect its boolean before polling again.
    const stored = await page.evaluate(({ threadId, hidden }) => new Promise(resolve => {
      const request = indexedDB.open('pocket-reading-cache-v1');
      request.onupgradeneeded = () => { request.transaction.abort(); resolve(false); };
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('entries')) { db.close(); resolve(false); return; }
        const tx = db.transaction('entries', 'readonly'), read = tx.objectStore('entries').getAll();
        tx.onabort = tx.onerror = () => { db.close(); resolve(false); };
        tx.oncomplete = () => {
          db.close();
          resolve(read.result.some(record => {
            if (record.kind !== 'catalog' || record.machine !== 'ged') return false;
            try { return JSON.parse(record.json).threads.some(thread => thread.id === threadId && thread.pocketHidden === hidden && thread.hiddenRevision > 0); }
            catch { return false; }
          }));
        };
      };
    }), { threadId, hidden });
    if (stored) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Hidden preference was not persisted for ${threadId}: ${hidden}`);
};

function flow(engine, name, options, run) {
  test(`${engine}: ${name}`, { timeout: 30000 }, () => runScenario({ engine, name,
    create: () => createHarness(engine, options), run, record: result => results.push(result) }));
}

for (const engine of engines) {
  inspectorReturnFlows(engine, flow);
  flow(engine, 'list, detail and new-query focus remain connected', {}, async h => {
    const page = await h.open(null);
    const cspEnforced = await page.evaluate(() => new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 1000);
      document.addEventListener('securitypolicyviolation', event => {
        if (event.blockedURI === 'inline') { clearTimeout(timer); resolve(true); }
      }, { once: true });
      const script = document.createElement('script'); script.textContent = 'window.syntheticInlineScriptRan = true';
      document.body.appendChild(script);
    }));
    assert.equal(cspEnforced, true, 'The browser enforces the tested build CSP');
    assert.equal(await page.evaluate(() => window.syntheticInlineScriptRan === true), false);
    await page.locator(`[data-thread-id="${ids.regular}"]`).click();
    await page.getByText('已有的合成回复', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.locator('.inspector').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建会话', exact: true });
    await dialog.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('dialog textarea'));
    await dialog.locator('textarea').fill('合成新建草稿');
    assert.equal(await dialog.locator('textarea').inputValue(), '合成新建草稿');
    assert.equal(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').length, 0);
  });

  flow(engine, 'information loading has stable height and fresh reopen uses its cache', {}, async h => {
    const gate = h.pause('automations'), page = await h.open();
    await page.getByText('已有的合成回复', { exact: true }).waitFor();
    await openInfo(page); await until(() => h.count('automations') === 1);
    const loading = await infoGeometry(page);
    gate.release(); await page.waitForFunction(() => document.querySelector('.thread-automations')?.getAttribute('aria-busy') === 'false');
    const ready = await infoGeometry(page);
    assert.ok(Math.abs(loading.height - ready.height) < 1, `${loading.height} → ${ready.height}`);
    assert.equal(ready.closeFocused, false);
    for (let count = 0; count < 2; count++) { await closeInfo(page); await openInfo(page); }
    assert.equal(h.count('automations'), 1); assert.equal(h.count('model-settings'), 1);
  });

  for (const [label, threadId] of [['existing', ids.regular], ['empty', ids.empty]]) {
    flow(engine, `${label} conversation keeps one query row through acceptance and late queue data`, {}, async h => {
      const page = await h.open(threadId);
      if (threadId === ids.regular) await page.getByText('已有的合成回复', { exact: true }).waitFor();
      const input = page.getByRole('textbox', { name: '发送消息', exact: true });
      await input.fill(`合成-${label}-唯一发送正文`);
      await page.locator('.conversation-composer button[type="submit"]').click();
      await until(() => h.calls.some(call => call.method === 'POST' && call.action === 'messages'));
      const call = h.calls.find(call => call.method === 'POST' && call.action === 'messages'), id = call.requestId;
      const row = page.locator(`article[data-query-id="${id}"]`);
      await row.waitFor(); assert.equal(await row.count(), 1);
      await row.evaluate(element => { window.syntheticQueryRow = element; });
      h.accept(threadId, id);
      await page.waitForFunction(id => document.querySelector(`article[data-query-id="${id}"]`)?.getAttribute('data-query-state') === 'accepted', id);
      h.echo(threadId, id); await refresh(page);
      await page.locator(`[data-message-id="echo-${id}"]`).waitFor();
      assert.equal(await row.count(), 1);
      assert.equal(await row.evaluate(element => element === window.syntheticQueryRow), true);
      h.staleQueue(threadId, id); const reads = h.count('history'); await refresh(page);
      await until(() => h.count('history') > reads); await page.waitForTimeout(160);
      assert.equal(await row.count(), 1);
      assert.equal(await page.locator(`[data-submission-id="${id}"], [data-outbox-id="${id}"]`).count(), 0);
      assert.equal(await row.evaluate(element => element === window.syntheticQueryRow), true);
      assert.equal(h.calls.filter(call => call.method === 'POST' && call.action === 'messages').length, 1);
    });
  }

  flow(engine, 'swipe hiding persists, updates categories and restores without changing native state', { visibility: true }, async h => {
    const page = await h.open(null), before = preservedMetadata(h.metadata());
    await page.locator('.running-toggle').click();
    const row = threadRow(page);
    await row.waitFor(); await swipeHiddenRow(row);
    assert.equal(await page.locator('.inspector').count(), 0);
    await row.locator('.row-hidden-action').click();
    await row.waitFor({ state: 'detached' });
    assert.equal(h.count('hidden'), 1); assert.equal(h.metadata().pocketHidden, true);
    assert.deepEqual(preservedMetadata(h.metadata()), before);
    assert.equal(await page.locator('.sidebar [data-view="all"] .sidebar-nav-count').textContent(), '1');
    assert.equal(await page.locator('.sidebar [data-view="priority"] .sidebar-nav-count').textContent(), '0');
    assert.equal(await page.locator('.sidebar [data-view="codex-pinned"] .sidebar-nav-count').textContent(), '0');
    assert.equal(await page.locator('.sidebar [data-view="hidden"] .sidebar-nav-count').textContent(), '1');
    assert.equal(await page.locator('.sidebar [data-project-id="fixture"] .sidebar-nav-count').textContent(), '1');
    await waitForStoredHidden(page, ids.regular, true);
    await selectView(page, 'all');
    if (await page.locator('.running-toggle').getAttribute('aria-pressed') === 'true') await page.locator('.running-toggle').click();
    await threadRow(page, ids.empty).waitFor();
    const gates = [h.pause('catalog', { repeat: true }), h.pause('sync', { repeat: true })], requestStart = h.calls.length;
    try {
      await page.reload();
      await until(() => h.calls.slice(requestStart).some(call => call.action === 'catalog' || call.action === 'sync'));
      await threadRow(page, ids.empty).waitFor();
      assert.equal(await threadRow(page).count(), 0, 'The cold disk preview already excludes hidden conversations');
      assert.equal(await page.locator('.sidebar [data-view="hidden"] .sidebar-nav-count').textContent(), '1');
      assert.ok(h.calls.slice(requestStart).filter(call => call.action === 'catalog' || call.action === 'sync').every(call => !call.finishedAt), 'No fresh catalog response supplied this first paint');
    } catch (error) {
      const observed = await page.evaluate(async () => ({ text: document.body.innerText.slice(0,1000), prefs: localStorage.getItem('navigator.view'),
        rows: [...document.querySelectorAll('[data-thread-id]')].map(element => element.getAttribute('data-thread-id')),
        cacheFences: Object.fromEntries(Object.keys(localStorage).filter(key => key.startsWith('pocket.reading-cache.epoch')).map(key => [key, localStorage.getItem(key)])),
        now: Date.now(), cache: await new Promise(resolve => {
          const request = indexedDB.open('pocket-reading-cache-v1');
          request.onerror = () => resolve({ error: 'open' });
          request.onsuccess = () => {
            const db = request.result, tx = db.transaction(['entries','epochs'], 'readonly');
            const entries = tx.objectStore('entries').getAll(), epochKeys = tx.objectStore('epochs').getAllKeys(), epochs = tx.objectStore('epochs').getAll();
            tx.onerror = () => { db.close(); resolve({ error: 'read' }); };
            tx.oncomplete = () => { db.close(); resolve({ epochs: epochKeys.result.map((key,index) => [key,epochs.result[index]]),
              entries: entries.result.filter(record => record.kind === 'catalog').map(record => {
                const value = JSON.parse(record.json);
                return { key: record.key, fence: record.fence, globalEpoch: record.globalEpoch, machineEpoch: record.machineEpoch, savedAt: record.savedAt,
                  scope: record.scope, schema: record.schema, info: value.sourceInfo,
                  threads: value.threads.map(thread => ({ id: thread.id, hidden: thread.pocketHidden, revision: thread.hiddenRevision, archived: thread.archived })) };
              }) }); };
          };
        }) }));
      throw new Error(error.message + '\nCold catalog state: ' + JSON.stringify(observed), { cause: error });
    } finally { gates.forEach(gate => gate.release()); }
    await selectView(page, 'hidden');
    await threadRow(page).waitFor();
    assert.equal(await page.locator('.workspace-title').innerText(), '隐藏');
    assert.equal(await page.locator('.running-toggle,.unread-toggle').count(), 0);
    await threadRow(page).locator('.task-select').click();
    await page.getByText('已有的合成回复', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.locator('.inspector').waitFor({ state: 'detached' });
    await swipeHiddenRow(threadRow(page));
    await threadRow(page).locator('.row-hidden-action').click();
    await threadRow(page).waitFor({ state: 'detached' });
    assert.equal(h.metadata().pocketHidden, false); assert.equal(h.metadata().hiddenRevision, 2);
    assert.deepEqual(preservedMetadata(h.metadata()), before);
    await waitForStoredHidden(page, ids.regular, false);
    await selectView(page, 'all'); await threadRow(page).waitFor();
    await page.reload(); await threadRow(page).waitFor();
    assert.equal(await page.locator('.sidebar [data-view="hidden"] .sidebar-nav-count').textContent(), '0');
    assert.equal(await page.locator('.sidebar [data-view="priority"] .sidebar-nav-count').textContent(), '1');
    assert.equal(await page.locator('.sidebar [data-view="codex-pinned"] .sidebar-nav-count').textContent(), '1');
    assert.deepEqual(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').map(call => [call.action, call.hidden]), [['hidden', true], ['hidden', false]]);
  });

  flow(engine, 'failed hide preserves the row and pending completion does not steal newer navigation or focus', { visibility: true }, async h => {
    const page = await h.open(null), before = preservedMetadata(h.metadata()), row = threadRow(page);
    h.failNextHidden(); await swipeHiddenRow(row); await row.locator('.row-hidden-action').click();
    await row.getByRole('alert').waitFor();
    assert.equal(h.metadata().pocketHidden, false);
    assert.deepEqual(preservedMetadata(h.metadata()), before);
    assert.equal(await row.locator('.row-hidden-action').isEnabled(), true);
    assert.equal(await page.locator('.inspector').count(), 0);
    const gate = h.pause('hidden'); await row.locator('.row-hidden-action').click();
    await until(() => h.count('hidden') === 2);
    assert.equal(await row.locator('.row-hidden-action').isEnabled(), false);
    assert.equal(await row.locator('.row-priority-action').isEnabled(), false);
    await selectView(page, 'hidden'); await selectView(page, 'all'); await selectView(page, 'hidden');
    await page.getByRole('button', { name: '展开搜索', exact: true }).click();
    const search = page.getByRole('textbox', { name: '搜索会话', exact: true }); await search.fill('合成');
    gate.release(); await threadRow(page).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-swipe-row-id]')?.getAttribute('aria-busy') !== 'true');
    assert.equal(await search.evaluate(element => element === document.activeElement), true);
    assert.equal(await search.inputValue(), '合成');
    assert.equal(await page.locator('.workspace-title').innerText(), '隐藏');
    assert.equal(await page.locator('.inspector').count(), 0);
    assert.equal(h.metadata().pocketHidden, true); assert.equal(h.count('hidden'), 2);
    assert.deepEqual(preservedMetadata(h.metadata()), before);
  });

  flow(engine, 'keyboard unhide returns archived conversations only to the archive category', { visibility: true, archivedHidden: true, width: 1280 }, async h => {
    const page = await h.open(null), before = preservedMetadata(h.metadata(ids.empty));
    assert.equal(await threadRow(page, ids.empty).count(), 0);
    await selectView(page, 'hidden');
    const row = threadRow(page, ids.empty); await row.waitFor();
    await row.getByText('已归档', { exact: true }).waitFor();
    const action = row.locator('.row-hidden-shortcut'); await action.focus(); await action.press('Enter');
    await row.waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: '没有隐藏的会话', exact: true }).waitFor();
    assert.equal(await page.locator('.task-list-surface').evaluate(element => element === document.activeElement), true);
    assert.equal(h.metadata(ids.empty).pocketHidden, false);
    assert.deepEqual(preservedMetadata(h.metadata(ids.empty)), before);
    await selectView(page, 'all'); await threadRow(page).waitFor();
    assert.equal(await threadRow(page, ids.empty).count(), 0, 'Unhide cannot unarchive a conversation');
    await selectView(page, 'archived'); await threadRow(page, ids.empty).waitFor();
    assert.deepEqual(h.calls.filter(call => call.method !== 'GET' && call.path !== '/api/sync').map(call => [call.action, call.hidden]), [['hidden', false]]);
  });

  flow(engine, 'top pull loads older history once and returning latest preserves the message root', { history: true }, async h => {
    const page = await h.open(); await page.locator('[data-message-id="history-239"]').waitFor();
    const root = page.locator('.conversation-messages');
    await root.evaluate(element => { window.syntheticMessagesRoot = element; element.scrollTop = 0; });
    await page.waitForTimeout(240); assert.equal(h.count('transcript-page'), 0);
    await pullFromTop(page);
    await page.waitForFunction(() => document.querySelectorAll('.earlier-history-messages [data-message-id]').length === 160);
    assert.equal(h.count('transcript-page'), 2);
    assert.equal(await root.evaluate(element => element === window.syntheticMessagesRoot), true);
    assert.equal(await page.locator('.earlier-history-messages [data-pocket-read-marker], .earlier-history-messages [data-query-id]').count(), 0);
    await root.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(280); assert.equal(h.count('transcript-page'), 2);
    await page.getByRole('button', { name: '返回最新消息', exact: true }).click();
    await page.locator('.earlier-history-messages').waitFor({ state: 'detached' });
    assert.equal(await root.evaluate(element => element === window.syntheticMessagesRoot), true);
    await page.waitForFunction(() => { const element = document.querySelector('.conversation-messages'); return element.scrollHeight - element.scrollTop - element.clientHeight < 2; });
  });

  for (const cause of ['move', 'input']) {
    flow(engine, `slow history results do not take over after ${cause}`, { history: true }, async h => {
      const page = await h.open(); await page.locator('[data-message-id="history-239"]').waitFor();
      const gate = h.pause('transcript-page'), root = page.locator('.conversation-messages');
      await pullFromTop(page); await until(() => h.count('transcript-page') === 1);
      if (cause === 'move') await root.evaluate(element => { element.scrollTop = 180; });
      else await page.getByRole('textbox', { name: '发送消息', exact: true }).fill('慢读取期间保留的草稿');
      gate.release();
      await page.getByRole('button', { name: '查看已加载的消息', exact: true }).waitFor();
      assert.equal(await page.locator('.earlier-history-messages').count(), 0);
      assert.equal(h.count('transcript-page'), 2);
      if (cause === 'input') assert.equal(await page.getByRole('textbox', { name: '发送消息', exact: true }).inputValue(), '慢读取期间保留的草稿');
      await page.waitForTimeout(240);
      assert.equal(await page.locator('.earlier-history-messages').count(), 0);
      assert.equal(h.count('transcript-page'), 2);
      await page.getByRole('button', { name: '查看已加载的消息', exact: true }).click();
      await page.locator('.earlier-history-messages').waitFor();
      assert.equal(h.count('transcript-page'), 2, 'Prepared pages are reused without another request');
    });
  }
}

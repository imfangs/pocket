import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium, webkit } from 'playwright';
import { parseStaticHeaders } from './headers.mjs';

export const origin = 'https://pocket.test';
export const ids = { regular: 'a7100000-0000-4000-8000-000000000001', empty: 'a7100000-0000-4000-8000-000000000002' };
export const engines = (process.env.POCKET_TEST_BROWSERS || 'chromium,webkit').split(',');
assert.ok(engines.length && engines.every(name => ['chromium', 'webkit'].includes(name)), 'Use chromium and/or webkit');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// A browser adapter around a small synthetic Pocket service. All browser
// requests are intercepted; no HTTP server, real API, credentials or native
// desktop operation is involved. Unknown endpoints are test failures.
export async function createHarness(engine, { history = false, width = 390, visibility = false, archivedHidden = false, locale = 'zh-CN',
  directory = process.env.POCKET_BROWSER_DIST || '.local/qa/browser-dist', launch = options => ({ chromium, webkit })[engine].launch(options) } = {}) {
  const dist = realpathSync(directory);
  const manifest = JSON.parse(readFileSync(resolve(dist, 'pocket-version.json')));
  const headersFor = parseStaticHeaders(readFileSync(resolve(dist, '_headers'), 'utf8'));
  assert.ok(headersFor('/')['content-security-policy'], 'The tested build must supply its document CSP');
  const browser = await launch({ headless: true });
  let context;
  const closeResources = async () => {
    const failures = [];
    try { await context?.close(); } catch (error) { failures.push(error); }
    try { await browser.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Browser cleanup failed');
  };
  try {
    context = await browser.newContext({ viewport: { width, height: 844 }, locale, isMobile: width < 761, hasTouch: true, serviceWorkers: 'block' });
    const calls = [], errors = [], unexpected = [], gates = new Map(), waiting = new Set();
    const now = Date.now();
    const allHistory = Array.from({ length: 240 }, (_, index) => ({ id: `history-${index}`, role: index % 2 ? 'assistant' : 'user',
      text: `历史消息 ${index}。用于验证阅读位置的合成内容。`, phase: index % 2 ? 'final' : undefined, timestamp: now - 240000 + index, turnId: `turn-${index >> 1}` }));
    const machines = new Map(['ged', 'wandou'].map(machine => [machine, new Map(Object.entries(ids).map(([name, id]) => [id, {
      id, title: `${machine} 合成${name === 'empty' ? '空' : '已有'}会话`, receipts: new Map(), queue: [],
      archived: archivedHidden && name === 'empty', pocketHidden: archivedHidden && name === 'empty',
      pocketPriority: visibility && name === 'regular', codexPinned: visibility && name === 'regular',
      hasUnreadTurn: visibility && name === 'regular', runtime: visibility && name === 'regular' ? 'running' : 'idle',
      messages: name === 'empty' ? [] : history ? allHistory.slice(-80) : [
        { id: id + '-u', role: 'user', text: '已有的合成问题', turnId: 'initial', timestamp: now - 2000 },
        { id: id + '-a', role: 'assistant', phase: 'final', text: '已有的合成回复', turnId: 'initial', timestamp: now - 1000 },
      ],
    }]))]));
    const hiddenRevisions = new Map(['ged', 'wandou'].map(machine => [machine, 0]));
    let hiddenFailure = null;
    let closed = false;
    const state = (id = ids.regular, machine = 'ged') => machines.get(machine).get(id);
    const content = (thread, machine) => ({ known: true, scope: 'smoke-' + machine, revision: thread.messages.length,
      version: createHash('sha256').update(JSON.stringify(thread.messages)).digest('hex'), messageId: thread.messages.at(-1)?.id ?? null });
    const projectThread = (thread, machine) => ({
      id: thread.id, hostId: 'local', title: thread.title, titleRevision: 0, cwd: '/synthetic', projectId: 'fixture', projectName: '合成项目',
      archived: thread.archived, pinned: thread.codexPinned, pinnedOrder: 0, pinRevision: 0,
      codexPinned: thread.codexPinned, pocketPriority: thread.pocketPriority,
      pocketHidden: thread.pocketHidden, hiddenRevision: hiddenRevisions.get(machine), separator: false,
      source: 'app', createdAt: now - 3600000, updatedAt: now, lastMessageAt: now, branch: null, missing: false,
      intent: 'none', note: '', reviewAt: null, groupIds: [], lastOpenedAt: null, revision: 0,
      hasUnreadTurn: thread.hasUnreadTurn, needsInput: thread.hasUnreadTurn,
      pocketContent: content(thread, machine),
    });
    const catalog = machine => ({ threads: [...machines.get(machine).values()].map(thread => projectThread(thread, machine)),
      groups: [], projects: [{ id: 'fixture', name: '合成项目', paths: ['/synthetic'], order: 0, separator: false }],
      sourceInfo: { syncedAt: now, active: [...machines.get(machine).values()].filter(thread => !thread.archived).length,
        archived: [...machines.get(machine).values()].filter(thread => thread.archived).length, total: 2,
        scope: 'synthetic', pocketRead: { available: true, scope: 'smoke-' + machine } },
      sourceError: null, csrfToken: 'synthetic-token' });
    const transcript = (thread, machine, saved) => ({ source: saved ? 'rollout' : 'desktop', resumeState: 'resumed', runtime: thread.runtime === 'running' ? 'active' : 'idle',
      canSend: !saved, canQueue: true, canAttemptSend: true, hint: '', messages: thread.messages, checkedAt: Date.now(),
      hasMore: history && thread.id === ids.regular, pocketContent: content(thread, machine), outbox: thread.queue,
      latestTurnId: thread.messages.at(-1)?.turnId ?? null, latestTurnStatus: thread.runtime === 'running' ? 'inProgress' : 'completed',
      activeTurnId: thread.runtime === 'running' ? thread.messages.at(-1)?.turnId ?? null : null,
      pendingRequests: [], asyncQuestions: [], canStop: thread.runtime === 'running', canCompact: false });
    await context.addInitScript(() => {
      // The real device clipboard is outside this synthetic regression suite.
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => '', writeText: async () => {} } });
    });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      const fail = async message => { unexpected.push(message); await route.abort(); };
      if (url.origin !== origin) return fail(`External request: ${request.method()} ${url.origin}${url.pathname}`);
      if (!url.pathname.startsWith('/api/')) {
        try {
          const file = realpathSync(resolve(dist, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
          if (!file.startsWith(dist + sep)) return fail('Asset escaped test build');
          return await route.fulfill({ status: 200, contentType: mime[extname(file)] || 'application/octet-stream',
            headers: headersFor(url.pathname), body: readFileSync(file) });
        } catch (error) { if (!closed) return fail(`Missing build asset: ${url.pathname}: ${error.code || error.message}`); return; }
      }
      const match = /^\/api\/machines\/(ged|wandou)(\/.*)$/.exec(url.pathname), machine = match?.[1] || 'ged';
      const path = match ? '/api' + match[2] : url.pathname, method = request.method();
      const task = /^\/api\/tasks\/([^/]+)\/(.+)$/.exec(path), thread = task && state(task[1], machine);
      const action = task?.[2] || path.slice(5), call = { machine, method, path, action, startedAt: Date.now() };
      calls.push(call);
      let data, status = 200;
      if (method === 'GET' && path === '/api/auth/status') data = { authenticated: true };
      else if (method === 'GET' && path === '/api/catalog' || method === 'POST' && path === '/api/sync') data = catalog(machine);
      else if (method === 'GET' && path === '/api/task-operations') data = { operations: [] };
      else if (method === 'GET' && path === '/api/task-statuses') data = { available: true, checkedAt: Date.now(), states: [...machines.get(machine).values()].filter(thread => !thread.archived).map(thread => ({ threadId: thread.id, status: thread.runtime, checkedAt: Date.now() })) };
      else if (method === 'GET' && path === '/api/notifications') data = { publicKey: '' };
      else if (method === 'GET' && path === '/api/feedback/config') data = { enabled: false };
      else if (method === 'GET' && path === '/api/tasks/create-options') data = { available: true, locations: [{ id: 'synthetic-location', cwd: '/synthetic', name: '合成项目', projectId: 'fixture', projectName: '合成项目', model: 'gpt-6-astra', effort: 'ultra' }] };
      else if (thread && method === 'GET' && ['history', 'transcript'].includes(action)) data = transcript(thread, machine, action === 'transcript');
      else if (thread && method === 'GET' && action === 'attachments') data = { attachments: [] };
      else if (thread && method === 'GET' && action === 'automations') data = { available: true, stale: false, timeZone: 'Asia/Shanghai', automations: [] };
      else if (thread && method === 'GET' && action === 'model-settings') data = { threadId: thread.id, source: 'saved', current: { model: 'gpt-6-astra', effort: 'ultra' }, revision: null, models: [], canChange: false, checkedAt: Date.now() };
      else if (thread && method === 'GET' && action === 'connection') data = { status: 'connected', checkedAt: Date.now() };
      else if (thread && method === 'POST' && action === 'hidden') {
        const input = request.postDataJSON();
        assert.deepEqual(Object.keys(input).sort(), ['hidden', 'scope']); assert.equal(typeof input.hidden, 'boolean');
        assert.equal(input.scope, 'smoke-' + machine, 'Visibility writes belong to the current catalog source');
        call.hidden = input.hidden; call.scope = input.scope;
        if (hiddenFailure) { status = hiddenFailure; data = { error: '合成隐藏保存失败' }; hiddenFailure = null; }
        else {
          if (thread.pocketHidden !== input.hidden) {
            thread.pocketHidden = input.hidden;
            hiddenRevisions.set(machine, hiddenRevisions.get(machine) + 1);
          }
          data = { ...projectThread(thread, machine), visibilityScope: 'smoke-' + machine };
        }
      }
      else if (thread && method === 'GET' && action === 'transcript-page' && history) {
        const cursor = url.searchParams.get('before'), end = cursor ? Number(cursor) : allHistory.length, start = Math.max(0, end - 80);
        assert.ok(Number.isInteger(end) && end > 0 && end <= allHistory.length, 'Synthetic cursor must belong to this fixture');
        data = { source: 'rollout', messages: allHistory.slice(start, end), hasMore: start > 0, nextCursor: start ? String(start) : null, page: { kind: cursor ? 'older' : 'recent' } };
      } else if (thread && method === 'POST' && action === 'messages') {
        const input = request.postDataJSON();
        assert.equal(typeof input.requestId, 'string'); assert.equal(typeof input.text, 'string');
        call.requestId = input.requestId;
        if (!thread.receipts.has(input.requestId)) thread.receipts.set(input.requestId, { requestId: input.requestId, status: 'pending', turnId: null, text: input.text, createdAt: Date.now() });
        const receipt = thread.receipts.get(input.requestId); data = { requestId: receipt.requestId, status: receipt.status, turnId: receipt.turnId }; status = 202;
      } else if (thread && method === 'GET' && action.startsWith('messages/')) {
        const requestId = action.slice(9), receipt = thread.receipts.get(requestId);
        data = receipt ? { requestId, status: receipt.status, turnId: receipt.turnId } : { requestId, status: 'not_found' };
      } else return fail(`Unexpected synthetic API: ${method} ${path}`);
      const gate = gates.get(action);
      if (gate) { if (!gate.repeat) gates.delete(action); waiting.add(gate); await gate.promise; waiting.delete(gate); }
      if (closed) return;
      try {
        await route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store', 'X-Pocket-Machine': machine }, body: JSON.stringify(data) });
        call.finishedAt = Date.now();
      } catch { call.aborted = true; } // Leaving a page intentionally aborts its owned reads.
    });
    return {
      calls, errors, unexpected, build: manifest.id,
      count: action => calls.filter(call => call.action === action).length,
      metadata(threadId = ids.regular, machine = 'ged') { return { ...projectThread(state(threadId, machine), machine), runtime: state(threadId, machine).runtime }; },
      failNextHidden(status = 503) { hiddenFailure = status; },
      pause(action, { repeat = false } = {}) {
        const gate = { ...deferred(), repeat }; gates.set(action, gate);
        return { release: () => { if (gates.get(action) === gate) gates.delete(action); gate.resolve(); } };
      },
      async open(threadId = ids.regular, machine = 'ged') {
        const page = await context.newPage(); page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => { unexpected.push(`Unexpected native dialog: ${dialog.type()}`); void dialog.dismiss(); });
        const response = await page.goto(`${origin}/?machine=${machine}${threadId ? '&task=' + threadId : ''}`);
        assert.equal(response.headers()['content-security-policy'], headersFor('/')['content-security-policy']);
        if (threadId) await page.locator('.conversation-live').waitFor(); else await page.locator('[data-thread-id]').first().waitFor();
        return page;
      },
      accept(threadId, requestId) { const receipt = state(threadId).receipts.get(requestId); receipt.status = 'accepted'; receipt.turnId = 'sent'; },
      echo(threadId, requestId) { const thread = state(threadId), receipt = thread.receipts.get(requestId);
        thread.messages.push({ id: 'echo-' + requestId, clientMessageId: requestId, role: 'user', text: receipt.text, timestamp: receipt.createdAt, turnId: 'sent' }); },
      staleQueue(threadId, requestId) { const thread = state(threadId), receipt = thread.receipts.get(requestId);
        thread.queue = [{ id: requestId, text: receipt.text, status: 'queued', revision: 0, createdAt: receipt.createdAt }]; },
      async close() {
        if (closed) return;
        closed = true; for (const gate of [...gates.values(), ...waiting]) gate.resolve();
        await closeResources();
      },
    };
  } catch (error) {
    try { await closeResources(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Browser setup and cleanup failed'); }
    throw error;
  }
}

export async function refresh(page) { await page.evaluate(() => window.dispatchEvent(new Event('online'))); }
export async function pullFromTop(page) {
  const root = page.locator('.conversation-messages');
  await root.evaluate(element => { element.scrollTop = 0; });
  await page.waitForTimeout(180);
  await root.evaluate(async element => {
    const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + Math.min(140, box.height / 3);
    for (const [type, offset, ended] of [['touchstart', 0, false], ['touchmove', 45, false], ['touchmove', 90, false], ['touchend', 90, true]]) {
      const touch = { identifier: 1, target: element, clientX: x, clientY: y + offset };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: ended ? [] : [touch] }, changedTouches: { value: [touch] } });
      element.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
}

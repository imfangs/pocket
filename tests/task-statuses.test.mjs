import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStatusService } from '../server/task-statuses.mjs';
import { makeApp } from '../server/index.mjs';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const thread = { id, title: 'Status fixture', archived: false, missing: false, separator: false };
const result = (at, status = 'running') => ({ available: true, checkedAt: at, states: [{ threadId: id, status, checkedAt: at }] });

test('concurrent list clients share one native observation and a bounded cache', async () => {
  let now = 10000, calls = 0, finish;
  const service = new TaskStatusService({ codexHome: '/fixture', threads: () => [thread], now: () => now,
    read: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = service.snapshot(), second = service.snapshot();
  await Promise.resolve(); assert.equal(calls, 1);
  finish(result(now));
  assert.deepEqual(await first, await second);
  now += 7999; assert.equal((await service.snapshot()).states[0].status, 'running'); assert.equal(calls, 1);
  now++; const fresh = service.snapshot(); await Promise.resolve(); assert.equal(calls, 2);
  finish(result(now, 'idle')); assert.equal((await fresh).states[0].status, 'idle');
  service.stop();
});

test('hot hints merge across clients without splitting in-flight reads or the shared cache', async () => {
  let now = 10000, finish;
  const payloads = [];
  const service = new TaskStatusService({ codexHome: '/fixture', threads: () => [thread, { ...thread, id: other }], now: () => now,
    read: payload => { payloads.push(payload); return new Promise(resolve => { finish = resolve; }); } });
  const first = service.snapshot({ priorityThreadIds: id });
  const second = service.snapshot({ priorityThreadIds: other });
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].priorityThreadIds, [id]);
  assert.equal(payloads[0].rotation, 0);
  finish(result(now)); await first;
  now += 7999;
  await service.snapshot({ priorityThreadIds: id });
  assert.equal(payloads.length, 1, 'hints do not force a read inside the cache window');
  now++;
  const fresh = service.snapshot(); await Promise.resolve();
  assert.deepEqual(payloads[1].priorityThreadIds, [id, other]);
  assert.equal(payloads[1].rotation, 1, 'only real collections advance the probe rotation');
  finish(result(now, 'idle')); await fresh;
  now += 30000;
  const expired = service.snapshot(); await Promise.resolve();
  assert.deepEqual(payloads[2].priorityThreadIds, [], 'unrefreshed hints expire independently of status caching');
  finish(result(now)); await expired;
  service.stop();
});

test('hints remain UUID-only, bounded, machine-local, and eligible after catalog changes', async () => {
  let now = 10000, rows = [thread, { ...thread, id: other }];
  const blocked = new Set(), payloads = [];
  const service = new TaskStatusService({ codexHome: '/fixture', threads: () => rows, excluded: () => blocked, now: () => now,
    read: payload => { payloads.push(payload); return result(now); } });
  await service.snapshot({ priorityThreadIds: [id.toUpperCase(), id, 'not-a-thread', other, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'] });
  assert.deepEqual(payloads[0].priorityThreadIds, [id, other]);
  rows = [thread, { ...thread, id: other, archived: true }];
  blocked.add(id);
  now += 8000;
  await service.snapshot({ priorityThreadIds: `${id},${other}` });
  assert.deepEqual(payloads[1].priorityThreadIds, [], 'old hints cannot bypass an archive or lifecycle exclusion');
  assert.deepEqual(payloads[1].threadIds, []);
  const ids = Array.from({ length: 40 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  rows = ids.map(id => ({ ...thread, id }));
  now += 8000;
  await service.snapshot({ priorityThreadIds: ids.join(',') });
  assert.deepEqual(payloads[2].priorityThreadIds, ids.slice(0, 32));
  now += 8000;
  await service.snapshot({ priorityThreadIds: ids.slice(32) });
  assert.equal(payloads[3].priorityThreadIds.length, 32);
  assert.deepEqual(payloads[3].priorityThreadIds.slice(0, 8), ids.slice(32), 'merging clients also respects the total bound');
  const isolated = new TaskStatusService({ codexHome: '/other-machine', threads: () => rows, now: () => now,
    read: payload => { assert.deepEqual(payload.priorityThreadIds, []); return result(now); } });
  await isolated.snapshot();
  isolated.stop(); service.stop();
});

test('failed observations share their cache even when a different hot hint arrives', async () => {
  let calls = 0;
  const service = new TaskStatusService({ codexHome: '/fixture', threads: () => [thread, { ...thread, id: other }], now: () => 10000,
    read: () => { calls++; throw new Error('fixture unavailable'); } });
  assert.equal((await service.snapshot({ priorityThreadIds: id })).available, false);
  assert.equal((await service.snapshot({ priorityThreadIds: other })).available, false);
  assert.equal(calls, 1);
  service.stop();
});

test('only current, eligible native state is exposed and no capability or transcript fields escape', async () => {
  const excluded = new Set([other]);
  let payload;
  const service = new TaskStatusService({ codexHome: '/fixture', threads: () => [thread, { ...thread, id: other }, { ...thread, id: 'archived', archived: true }],
    excluded: () => excluded, now: () => 10000, read: input => {
      payload = input;
      return { ...result(10000), messages: ['private'], states: [
        { threadId: id, status: 'running', checkedAt: 10000, canSend: true, history: 'private' },
        { threadId: other, status: 'running', checkedAt: 10000 },
        { threadId: 'foreign', status: 'running', checkedAt: 10000 },
      ] };
    } });
  assert.deepEqual(await service.snapshot(), result(10000));
  assert.deepEqual(payload.threadIds, [id]); assert.deepEqual(payload.excludedThreadIds, [other]);
  excluded.add(id); assert.deepEqual((await service.snapshot()).states, [], 'new exclusions also filter a cached response');
  service.stop();
});

test('old observations and failed reads cannot preserve a previously running badge', async () => {
  let now = 10000, value = result(now);
  const service = new TaskStatusService({ codexHome: '/fixture', threads: () => [thread], now: () => now, read: () => value });
  assert.equal((await service.snapshot()).states[0].status, 'running');
  now += 9000; assert.equal((await service.snapshot()).available, false, 'old whole-response timestamps are rejected');
  now += 9000; value = { available: true, checkedAt: now, states: [{ threadId: id, status: 'running', checkedAt: 1 }] };
  assert.equal((await service.snapshot()).states[0].status, 'unknown');
  now += 9000; value = { available: false, checkedAt: now, states: result(now).states };
  assert.deepEqual((await service.snapshot()).states, []);
  service.stop();
});

test('archival invalidation aborts an observation and discards a late successful response', async () => {
  let finish, signal;
  const service = new TaskStatusService({ codexHome: '/fixture', threads: () => [thread], now: () => 10000,
    read: (_, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  const pending = service.snapshot(); await Promise.resolve();
  service.invalidate(); assert.equal(signal.aborted, true);
  finish(result(10000)); assert.equal((await pending).available, false);
  service.stop(); assert.equal((await service.snapshot()).available, false);
});

test('the authenticated status endpoint stays independent of catalog and never opens a task', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-status-http-'));
  let observations = 0, opens = 0, payload;
  const app = makeApp({ dataDir: dir, codexHome: dir,
    readSource: () => ({ threads: [thread], projects: [], sourceInfo: {} }),
    desktopRequest: async () => ({ ok: false, code: 'fixture' }), readHistory: () => ({ messages: [] }),
    openThread: async () => { opens++; }, notifications: { send: async () => {} },
    taskStatuses: { read: value => { payload = value; observations++; return result(Date.now()); } } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const endpoint = base + `/api/task-statuses?priorityThreadIds=${id},invalid,${other}`;
  const anonymous = await fetch(endpoint); assert.equal(anonymous.status, 401); assert.equal(observations, 0);
  const headers = { Authorization: `Bearer ${app.auth.localToken}` };
  const responses = await Promise.all([1, 2].map(() => fetch(endpoint, { headers })));
  for (const response of responses) {
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).states[0].status, 'running');
  }
  assert.equal(observations, 1); assert.equal(opens, 0);
  assert.deepEqual(payload.priorityThreadIds, [id], 'the authenticated query only prioritizes an eligible local ID');
  assert.equal((await fetch(base + '/api/task-statuses', { headers })).status, 200, 'clients without hints remain compatible');
  assert.equal(observations, 1);
  const catalog = await fetch(base + '/api/catalog', { headers }).then(response => response.json());
  assert.equal(catalog.threads[0].runtimeStatus, undefined, 'transient state is not persisted in catalog annotations');
});

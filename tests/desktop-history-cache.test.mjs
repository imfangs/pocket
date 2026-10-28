import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { NavigatorStore } from '../server/store.mjs';
import { DesktopService } from '../server/desktop.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-history-cache-'));
  const store = new NavigatorStore(directory);
  const ids = Array.from({ length: 120 }, (_, index) => `aaaaaaaa-aaaa-7aaa-8aaa-${String(index).padStart(12, '0')}`);
  store.sync({ threads: ids.map(id => ({ id, title: 'Synthetic thread', cwd: directory, archived: false })), projects: [], sourceInfo: {} });
  const calls = [];
  const service = new DesktopService(store, directory, async payload => {
    calls.push(payload.threadId);
    return { ok: true, source: 'desktop', resumeState: 'resumed', runtime: 'idle', canSend: true,
      messages: [{ id: 'message', role: 'assistant', text: `History for ${payload.threadId}` }] };
  }, () => ({ source: 'rollout', messages: [] }), { openThread: async () => assert.fail('A resumed owner must not be opened') });
  const connect = async id => {
    service.connect(id, { open: false });
    await setImmediate();
    assert.equal(service.connection(id).status, 'connected');
  };
  t.after(() => { service.stopQueue(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { service, ids, calls, connect };
}

test('connections retain only the ten latest history snapshots even after connection records are evicted', async t => {
  const { service, ids, calls, connect } = fixture(t);
  for (const id of ids) await connect(id);
  assert.equal(service.connections.size, 100);
  assert.equal(service.cache.size, 10);
  assert.deepEqual([...service.cache.keys()], ids.slice(-10));
  const history = await service.history(ids.at(-1));
  assert.equal(history.messages[0].text, `History for ${ids.at(-1)}`);
  assert.equal(calls.length, ids.length, 'a connected snapshot is reused without another IPC read');
});

test('ordinary reads and connections share the same bound and preserve refreshed snapshots', async t => {
  const { service, ids, calls, connect } = fixture(t);
  for (const [index, id] of ids.slice(0, 12).entries()) {
    if (index % 2) await connect(id);
    else await service.history(id);
    assert.ok(service.cache.size <= 10);
  }
  assert.deepEqual([...service.cache.keys()], ids.slice(2, 12));
  service.cache.get(ids[2]).at = 0;
  await service.history(ids[2]);
  await connect(ids[12]);
  assert.equal(service.cache.size, 10);
  const reads = calls.length;
  await service.history(ids[2]);
  assert.equal(calls.length, reads, 'refreshing an old snapshot makes it recent enough to retain');
  await service.history(ids[3]);
  assert.equal(calls.length, reads + 1, 'the oldest unrefreshed snapshot was evicted');
  assert.equal(service.cache.size, 10);
});

test('an evicted in-flight read cannot replace a newer connected snapshot when it finishes', async t => {
  const { service, ids, connect } = fixture(t);
  const request = service.request;
  let finish;
  service.request = () => {
    service.request = request;
    return new Promise(resolve => { finish = resolve; });
  };
  const oldRead = service.history(ids[0]);
  for (const id of ids.slice(1, 12)) await connect(id);
  await connect(ids[0]);
  finish({ ok: false, code: 'desktop_unavailable', sent: false });
  await oldRead;
  assert.equal(service.cache.size, 10);
  const history = await service.history(ids[0]);
  assert.equal(history.source, 'desktop');
  assert.equal(history.messages[0].text, `History for ${ids[0]}`);
});

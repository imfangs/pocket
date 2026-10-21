import './helpers/block-native-open.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp } from '../server/index.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const missing = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

test('authenticated catalog exposes only schedule counts; details use the exact known thread and never write plans', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-automation-http-'));
  const path = join(dir, 'automations', 'fixture', 'automation.toml');
  mkdirSync(join(dir, 'automations', 'fixture'), { recursive: true });
  const input = `version = 1\nid = "fixture"\nkind = "heartbeat"\nname = "Daily fixture"\nstatus = "ACTIVE"\ntarget_thread_id = "${id}"\nrrule = "FREQ=DAILY;BYHOUR=6;BYMINUTE=15"\nprompt = "Private synthetic instructions"\n`;
  writeFileSync(path, input);
  const app = makeApp({ dataDir: join(dir, 'data'), codexHome: dir,
    readSource: () => ({ threads: [id, other].map(id => ({ id, title: 'Fixture', archived: false })), projects: [], sourceInfo: {} }),
    openThread: async () => { throw Error('Unexpected native open'); },
    desktopRequest: async () => { throw Error('Unexpected desktop request'); },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: `Bearer ${app.auth.localToken}` };
  assert.equal((await fetch(`${base}/api/tasks/${id}/automations`)).status, 401);
  const catalog = await fetch(base + '/api/catalog', { headers }).then(response => response.json());
  assert.deepEqual(catalog.threads.find(thread => thread.id === id).automationSummary,
    { count: 1, activeCount: 1, pausedCount: 0, stale: false });
  assert.equal(catalog.threads.find(thread => thread.id === other).automationSummary, undefined);
  assert.doesNotMatch(JSON.stringify(catalog), /Private synthetic instructions|FREQ=|Daily fixture/);
  const response = await fetch(`${base}/api/tasks/${id}/automations`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const details = await response.json();
  assert.equal(details.available, true); assert.equal(details.automations[0].prompt, 'Private synthetic instructions');
  assert.equal(details.automations[0].scheduleLabel, '每天 06:15');
  assert.doesNotMatch(JSON.stringify(details), /FREQ=|RRULE/);
  const unrelated = await fetch(`${base}/api/tasks/${other}/automations`, { headers }).then(response => response.json());
  assert.deepEqual(unrelated.automations, []);
  assert.equal((await fetch(`${base}/api/tasks/${missing}/automations`, { headers })).status, 404);
  assert.equal(readFileSync(path, 'utf8'), input);
});

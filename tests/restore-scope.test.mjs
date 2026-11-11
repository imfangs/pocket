import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDefaultRestoreScope } from '../server/lifecycle.mjs';
import { makeApp } from '../server/index.mjs';

const rootId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const childId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function nativeGraph(t, { linked = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-restore-scope-'));
  const home = join(directory, 'home'); mkdirSync(home);
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT); CREATE TABLE threads(id TEXT,archived INTEGER);');
  db.prepare('INSERT INTO threads VALUES(?,1)').run(rootId);
  if (linked) db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?)').run(rootId, childId);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, home, db };
}

test('default graph preflight observes direct children without requiring any descendant rollout', t => {
  const f = nativeGraph(t);
  const previous = process.env.CODEX_SQLITE_HOME; delete process.env.CODEX_SQLITE_HOME;
  try {
    assert.equal(readDefaultRestoreScope(f.home, rootId), true);
    assert.equal(readDefaultRestoreScope(f.home, childId), false, 'an ancestor relationship does not make a leaf wider than its own scope');
    assert.equal(f.db.prepare('SELECT archived FROM threads WHERE id=?').get(rootId).archived, 1);
  } finally { if (previous === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = previous; }
});

test('custom, escaped or ambiguous SQLite layouts defer to the configured Python guard', t => {
  const f = nativeGraph(t), previous = process.env.CODEX_SQLITE_HOME;
  try {
    process.env.CODEX_SQLITE_HOME = join(f.directory, 'other');
    assert.equal(readDefaultRestoreScope(f.home, rootId), null);
    delete process.env.CODEX_SQLITE_HOME;
    for (const config of ['sqlite_home="/synthetic/other"\n', '"\\u0073qlite_home"="/synthetic/other"\n']) {
      writeFileSync(join(f.home, 'config.toml'), config);
      assert.equal(readDefaultRestoreScope(f.home, rootId), null, 'a different selected database cannot borrow the default graph answer');
    }
    writeFileSync(join(f.home, 'config.toml'), '');
    const second = new DatabaseSync(join(f.home, 'state_6.sqlite')); second.close();
    assert.equal(readDefaultRestoreScope(f.home, rootId), null);
  } finally { if (previous === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = previous; }
});

test('an unknown graph schema does not grant a standalone scope', t => {
  const f = nativeGraph(t), previous = process.env.CODEX_SQLITE_HOME; delete process.env.CODEX_SQLITE_HOME;
  try { f.db.exec('DROP TABLE thread_spawn_edges'); assert.equal(readDefaultRestoreScope(f.home, rootId), null); }
  finally { if (previous === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = previous; }
});

test('known linked restore is refused before reservation, owner suspension or native calls', async t => {
  const f = nativeGraph(t), previous = process.env.CODEX_SQLITE_HOME; delete process.env.CODEX_SQLITE_HOME;
  let calls = 0, suspensions = 0;
  const app = makeApp({ dataDir: join(f.directory, 'pocket'), codexHome: f.home,
    readSource: () => ({ threads: [{ id: rootId, title: 'Synthetic root', archived: true }], projects: [], sourceInfo: {} }),
    desktopRequest: async () => { calls++; throw new Error('A refused restore cannot read or activate an owner'); },
    lifecycle: { archive: async () => { calls++; throw new Error('A refused restore cannot enter the bridge'); } },
  });
  app.lifecycle.desktop.suspendConnection = () => { suspensions++; };
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    if (previous === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = previous;
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, headers = { Authorization: `Bearer ${app.auth.localToken}` };
  const catalog = await fetch(base + '/api/catalog', { headers }).then(response => response.json());
  const response = await fetch(base + `/api/tasks/${rootId}/archive`, { method: 'POST',
    headers: { ...headers, Origin: base, 'Content-Type': 'application/json', 'X-Navigator-Token': catalog.csrfToken },
    body: JSON.stringify({ requestId, archived: false }) });
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.status, 'rejected'); assert.equal(receipt.code, 'restore_scope_conflict');
  assert.equal(calls, 0); assert.equal(suspensions, 0); assert.equal(app.lifecycle.blocked.has(rootId), false);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM lifecycle_operations').get().n, 0);
  assert.equal(f.db.prepare('SELECT archived FROM threads WHERE id=?').get(rootId).archived, 1);
});

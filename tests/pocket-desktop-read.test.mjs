import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { NavigatorStore } from '../server/store.mjs';
import { readCodexSource } from '../server/source.mjs';
import { PocketContentService } from '../server/pocket-content.mjs';
import { readPersistedHistory } from '../server/history.mjs';
import { makeApp } from '../server/index.mjs';

const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const identity = hash(['execution-storage', 'apikey']), host = 'local:' + hash(['local', 'local', null]);
const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const event = (type, turn_id = 'turn') => ({ type: 'event_msg', payload: { type, turn_id } });
const message = text => ({ type: 'response_item', payload: { type: 'message', id: 'reply', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] } });
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pocket-desktop-read-'));
  const home = join(root, 'codex'), file = join(home, 'sessions', 'fixture.jsonl');
  fs.mkdirSync(join(home, 'sessions'), { recursive: true });
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,archived INTEGER,created_at INTEGER,updated_at INTEGER,source TEXT,rollout_path TEXT)');
  db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)').run(id, 'Fixture', root, 0, 1, 2, 'app', file);
  db.close();
  fs.writeFileSync(file, lines([{ type: 'session_meta', payload: { id } }, event('task_started'), message('Answer'), event('task_complete')]));
  fs.writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'apikey' }));
  const native = (ids = [], extra) => fs.writeFileSync(join(home, '.codex-global-state.json'), JSON.stringify({
    'pinned-thread-ids': [], 'electron-thread-read-state-v1': { version: 1, unreadByIdentity: { [identity]: { [host]: ids } } }, ...extra,
  }));
  native();
  const store = new NavigatorStore(join(root, 'pocket'));
  let now = 10000;
  const ledger = new PocketContentService(store, home, { now: () => now });
  const scan = () => { const data = ledger.source(readCodexSource(home)); store.sync(data); return data.threads[0]; };
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { home, file, ledger, store, native, scan, advance: (ms = 2001) => now += ms,
    append: (...rows) => fs.appendFileSync(file, lines(rows)) };
}

test('desktop-read reconciliation needs two settled observations and emits only the exact content version', t => {
  const f = fixture(t);
  const first = f.scan();
  assert.equal(first.desktopReadContent, undefined);
  assert.equal(f.scan().desktopReadContent, undefined, 'back-to-back scans cannot bypass settling');
  f.advance();
  const settled = f.scan();
  assert.deepEqual(settled.desktopReadContent, settled.pocketContent);
  assert.equal(settled.desktopReadContent.known, true);
  assert.doesNotMatch(JSON.stringify(settled), /fixture\.jsonl|unreadByIdentity|source\.file/);
});

test('new reply before native unread catches up is never acknowledged by an old false', t => {
  const f = fixture(t);
  f.scan(); f.advance();
  const old = f.scan().desktopReadContent;
  f.append(event('task_started', 'next'), message('New answer'), event('task_complete', 'next'));
  const next = f.scan();
  assert.equal(next.desktopReadContent, undefined);
  assert.ok(next.pocketContent.revision > old.revision);
  f.native([id]); f.advance();
  assert.equal(f.scan().desktopReadContent, undefined);
  f.native([]);
  assert.equal(f.scan().desktopReadContent, undefined, 'reading starts a new confirmation window');
  f.advance();
  assert.deepEqual(f.scan().desktopReadContent, next.pocketContent);
});

test('catalog never relabels a saved desktop-read hint with a newer transcript revision', t => {
  const f = fixture(t);
  f.scan(); f.advance(); const before = f.scan();
  f.append(message('More text in the same reply'));
  const current = f.ledger.transcript(id, readPersistedHistory(f.home, id)).pocketContent;
  const catalog = f.ledger.catalog(f.store.catalog()).threads[0];
  assert.ok(current.revision > before.desktopReadContent.revision);
  assert.deepEqual(catalog.pocketContent, current);
  assert.deepEqual(catalog.desktopReadContent, before.desktopReadContent);
});

test('running, unknown and restarted turns cannot grant a desktop-read hint', t => {
  const f = fixture(t);
  f.scan();
  f.append(event('task_started', 'new'));
  f.advance(); assert.equal(f.scan().desktopReadContent, undefined);
  f.append(event('task_complete', 'new'));
  assert.equal(f.scan().desktopReadContent, undefined);
  f.advance(); assert.ok(f.scan().desktopReadContent);
  f.append(event('task_started', 'again'));
  f.advance(); assert.equal(f.scan().desktopReadContent, undefined);
});

test('missing identity/host, unknown schemas, other accounts and legacy false are not positive read evidence', t => {
  const f = fixture(t);
  for (const unreadByIdentity of [{}, { [identity]: {} }, { [identity]: { [host]: null } }, { other: { [host]: [] } }]) {
    f.native([], { 'electron-thread-read-state-v1': { version: 1, unreadByIdentity } });
    f.scan(); f.advance(); assert.equal(f.scan().desktopReadContent, undefined);
  }
  f.native([], { 'electron-thread-read-state-v1': undefined, 'electron-persisted-atom-state': { 'unread-thread-ids-by-host-v1': { local: [] } } });
  f.scan(); f.advance(); assert.equal(f.scan().desktopReadContent, undefined);
  f.native(); fs.writeFileSync(join(f.home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  f.scan(); f.advance(); assert.equal(f.scan().desktopReadContent, undefined);
});

test('native changes during a source scan cannot be combined with the content read afterwards', t => {
  const f = fixture(t);
  const original = fs.readSync;
  let changed = false;
  const mock = t.mock.method(fs, 'readSync', (...args) => {
    const result = original(...args);
    if (!changed) { changed = true; f.native([id]); }
    return result;
  });
  f.scan(); mock.mock.restore();
  f.native([]); f.advance();
  assert.equal(f.scan().desktopReadContent, undefined, 'the raced sample did not start the settle window');
  f.advance(); assert.ok(f.scan().desktopReadContent);
});

test('stale source evidence and serialized catalogs cannot generate a new read hint', t => {
  const f = fixture(t);
  const old = readCodexSource(f.home);
  f.ledger.source(old); f.advance();
  assert.equal(f.ledger.source(old).threads[0].desktopReadContent, undefined, 'replaying the same evidence is not a fresh observation');
  f.append(message('Updated'));
  assert.equal(f.ledger.source(old).threads[0].desktopReadContent, undefined);
  const copied = JSON.parse(JSON.stringify(readCodexSource(f.home)));
  f.ledger.source(copied); f.advance();
  assert.equal(f.ledger.source(copied).threads[0].desktopReadContent, undefined);
});

test('server restart rechecks desktop-read evidence instead of inheriting an in-memory candidate', t => {
  const f = fixture(t);
  f.scan(); f.advance();
  let now = 20000;
  const restart = new PocketContentService(f.store, f.home, { now: () => now });
  assert.equal(restart.source(readCodexSource(f.home)).threads[0].desktopReadContent, undefined);
  now += 2001;
  assert.ok(restart.source(readCodexSource(f.home)).threads[0].desktopReadContent);
});

test('one client sync absorbs settled desktop reading without native writes or a second manual refresh', async t => {
  const f = fixture(t);
  let nativeWrites = 0;
  const app = makeApp({ codexHome: f.home, dataDir: join(f.home, '..', 'api'),
    openThread: () => { throw Error('must not open'); },
    desktopRequest: async () => ({ ok: false, code: 'desktop_unavailable' }),
    readState: { write: async () => { nativeWrites++; throw Error('must not write'); } },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const headers = { Authorization: `Bearer ${app.auth.localToken}` };
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const initial = await (await fetch(base + '/api/catalog', { headers })).json();
  assert.equal(initial.threads[0].desktopReadContent, undefined);
  const result = await fetch(base + '/api/sync', { method: 'POST', headers: { ...headers, Origin: base, 'X-Navigator-Token': initial.csrfToken } });
  assert.equal(result.status, 200);
  const updated = (await result.json()).threads[0];
  assert.deepEqual(updated.desktopReadContent, updated.pocketContent);
  assert.equal(nativeWrites, 0);
});

test('a failed source scan resets unsettled candidates before recovery can acknowledge content', async t => {
  const f = fixture(t);
  let failed = false, now = 10000;
  const app = makeApp({ codexHome: f.home, dataDir: join(f.home, '..', 'failed-api'),
    pocketContent: { now: () => now },
    readSource: () => { if (failed) throw Error('source unavailable'); return readCodexSource(f.home); },
    openThread: () => { throw Error('must not open'); },
    desktopRequest: async () => ({ ok: false, code: 'desktop_unavailable' }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  failed = true; now += 1000;
  assert.throws(() => app.sync(), /source unavailable/);
  failed = false; now += 3000; app.sync();
  assert.equal(app.store.catalog().threads[0].desktopReadContent, undefined,
    'failure cannot count towards the two fresh settled observations');
  now += 2001; app.sync();
  assert.ok(app.store.catalog().threads[0].desktopReadContent);
});

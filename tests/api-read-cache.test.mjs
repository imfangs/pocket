import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api.ts';
import { createReadResponseCache } from '../src/readResponseCache.ts';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const versionA = `W/"pocket-read-v1-${'a'.repeat(64)}"`;
const versionB = `W/"pocket-read-v1-${'b'.repeat(64)}"`;
const catalog = (title = 'Saved catalog') => ({ csrfToken: 'csrf', sourceInfo: { syncedAt: 1000 }, threads: [{ id, title }] });
const transcript = (text = 'Saved reply') => ({ source: 'rollout', checkedAt: 1000,
  messages: [{ id: 'reply', role: 'assistant', text }] });
const history = () => ({ ...transcript(), source: 'desktop', canSend: false,
  turnTiming: { turnId: 'turn', status: 'inProgress', startedAt: 500, durationMs: null, observedAt: 1000 } });
const reply = (data, { status = 200, version = versionA, machine = 'ged', headers = {} } = {}) =>
  new Response(status === 204 || status === 304 ? null : JSON.stringify(data), { status,
    headers: { 'Content-Type': 'application/json', ...(machine === null ? {} : { 'X-Pocket-Machine': machine }),
      ...(version === null ? {} : { ETag: version }), ...headers } });
const unchanged = (headers, options = {}) => reply(null, { status: 304, headers, ...options });

function fixture(steps, scope = () => 'ged') {
  const calls = [], expired = [];
  const client = createApiClient(scope, async (url, options = {}) => {
    const call = { url, ...options, headers: new Headers(options.headers) }; calls.push(call);
    assert.ok(steps.length, `unexpected request ${url}`);
    const step = steps.shift();
    return typeof step === 'function' ? step(call) : step;
  }, machine => expired.push(machine));
  return { client, calls, expired };
}
const assertUnconditional = call => {
  assert.equal(call.headers.get('If-None-Match'), null);
  assert.equal(call.headers.get('X-Pocket-Read-Version'), null);
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('catalog 200 then 304 hydrates only the exact source observation time', async () => {
  const data = catalog(), { client, calls } = fixture([
    reply(data), unchanged({ 'X-Pocket-Source-Synced-At': '2200' }),
  ]);
  assert.deepEqual(await client.api('/api/catalog'), data);
  const repeated = await client.api('/api/catalog');
  assert.deepEqual(repeated, { ...data, sourceInfo: { syncedAt: 2200 } });
  assertUnconditional(calls[0]);
  assert.equal(calls[1].headers.get('If-None-Match'), versionA);
  assert.equal(calls[1].cache, 'no-store');
});

test('history 304 hydrates checkedAt and desktop turn observedAt without changing permissions or elapsed facts', async () => {
  const data = history(), { client, calls } = fixture([
    reply(data), unchanged({ 'X-Pocket-Checked-At': '2200', 'X-Pocket-Turn-Observed-At': '2100' }),
  ]);
  const path = `/api/tasks/${id}/history`;
  await client.api(path);
  const repeated = await client.api(path);
  assert.deepEqual(repeated, { ...data, checkedAt: 2200, turnTiming: { ...data.turnTiming, observedAt: 2100 } });
  assert.equal(repeated.canSend, false);
  assert.equal(calls[1].headers.get('If-None-Match'), versionA);
});

test('transcript 304 updates its checkedAt while retained message content stays exact', async () => {
  const data = transcript(), { client } = fixture([
    reply(data), unchanged({ 'X-Pocket-Checked-At': '2000' }),
  ]);
  const path = `/api/tasks/${id}/transcript`;
  await client.api(path);
  assert.deepEqual(await client.api(path), { ...data, checkedAt: 2000 });
});

test('sync uses its explicit request version header and 204 observation hydration', async () => {
  const data = catalog(), { client, calls } = fixture([
    reply(data), unchanged({ 'X-Pocket-Source-Synced-At': '2000' }, { status: 204 }),
  ]);
  client.setToken('current-csrf');
  await client.api('/api/sync', 'POST', {});
  assert.deepEqual(await client.api('/api/sync', 'POST', {}), { ...data, sourceInfo: { syncedAt: 2000 } });
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers.get('If-None-Match'), null);
  assert.equal(calls[1].headers.get('X-Pocket-Read-Version'), versionA);
  assert.equal(calls[1].headers.get('X-Navigator-Token'), 'current-csrf');
});

test('a bodyless response without a saved body retries once without conditionals', async () => {
  for (const [path, method, status] of [['/api/catalog', 'GET', 304], ['/api/sync', 'POST', 204]]) {
    const data = catalog('Full fallback'), { client, calls } = fixture([unchanged({}, { status }), reply(data)]);
    assert.deepEqual(await client.api(path, method), data);
    assert.equal(calls.length, 2); calls.forEach(assertUnconditional);
  }
});

test('missing, malformed or mismatched metadata causes one full fallback', async () => {
  const path = `/api/tasks/${id}/history`;
  const bad = [
    { headers: {} },
    { headers: { 'X-Pocket-Checked-At': '2000' } },
    { headers: { 'X-Pocket-Checked-At': 'broken', 'X-Pocket-Turn-Observed-At': '2000' } },
    { headers: { 'X-Pocket-Checked-At': '2000', 'X-Pocket-Turn-Observed-At': '-1' } },
    { headers: { 'X-Pocket-Checked-At': '2000', 'X-Pocket-Turn-Observed-At': '2000' }, version: versionB },
    { headers: { 'X-Pocket-Checked-At': '2000', 'X-Pocket-Turn-Observed-At': '2000' }, version: null },
  ];
  for (const options of bad) {
    const fresh = { ...history(), canSend: true, checkedAt: 3000 }, { client, calls } = fixture([
      reply(history()), reply(null, { status: 304, ...options }), reply(fresh, { version: versionB }),
    ]);
    await client.api(path);
    assert.deepEqual(await client.api(path), fresh);
    assert.equal(calls.length, 3); assertUnconditional(calls[2]);
  }
});

test('a second bodyless fallback fails with no loop and never guesses a response', async () => {
  const { client, calls } = fixture([unchanged({}), unchanged({})]);
  await assert.rejects(client.api('/api/catalog'), /读取版本尚未同步/);
  assert.equal(calls.length, 2); calls.forEach(assertUnconditional);
});

test('CSRF recovery refreshes catalog then retries sync without a conditional version', async () => {
  const final = catalog('After CSRF rotation');
  const { client, calls } = fixture([
    reply(catalog()), reply({ error: '请求已过期，请刷新页面' }, { status: 403, version: null }),
    reply({ csrfToken: 'fresh-csrf' }, { version: null }), reply(final, { version: versionB }),
    unchanged({ 'X-Pocket-Source-Synced-At': '3000' }, { status: 204, version: versionB }),
  ]);
  client.setToken('old-csrf');
  await client.api('/api/sync', 'POST');
  assert.deepEqual(await client.api('/api/sync', 'POST'), final);
  assert.equal(calls[1].headers.get('X-Pocket-Read-Version'), versionA);
  assert.equal(calls[2].url, '/api/catalog'); assertUnconditional(calls[2]);
  assert.equal(calls[3].headers.get('X-Navigator-Token'), 'fresh-csrf'); assertUnconditional(calls[3]);
  assert.equal((await client.api('/api/sync', 'POST')).sourceInfo.syncedAt, 3000);
  assert.equal(calls[4].headers.get('X-Pocket-Read-Version'), versionB);
});

test('401 during CSRF refresh clears saved read responses and identifies the expired machine', async () => {
  const { client, calls, expired } = fixture([
    reply(catalog()), reply({ error: '请求已过期，请刷新页面' }, { status: 403, version: null }),
    reply({ error: 'expired' }, { status: 401, version: null }), reply(catalog('Relogged')),
  ]);
  await client.api('/api/sync', 'POST');
  await assert.rejects(client.api('/api/sync', 'POST'), /请求已过期/);
  assert.deepEqual(expired, ['ged']);
  await client.api('/api/sync', 'POST'); assertUnconditional(calls[3]);
});

test('ordinary 401 and successful login/logout clear their read-cache ownership', async () => {
  for (const [path, status] of [['/api/catalog', 401], ['/api/auth/logout', 200], ['/api/auth/login', 200]]) {
    const { client, calls, expired } = fixture([
      reply(catalog()), reply(status === 401 ? { error: 'expired' } : { authenticated: path.endsWith('login') }, { status, version: null }),
      reply(catalog('Fresh session')),
    ]);
    await client.api('/api/catalog');
    if (status === 401) await assert.rejects(client.api(path), /expired/);
    else await client.api(path, 'POST');
    await client.api('/api/catalog'); assertUnconditional(calls[2]);
    assert.deepEqual(expired, status === 401 ? ['ged'] : []);
  }
});

test('execution, receipt, state and attachment routes never acquire a read validator', async () => {
  for (const [path, method] of [[`/api/tasks/${id}/messages`, 'POST'], [`/api/tasks/${id}/messages/${id}`, 'GET'],
    ['/api/tasks', 'POST'], ['/api/task-statuses', 'GET'], [`/api/tasks/${id}/connection`, 'GET'],
    [`/api/tasks/${id}/attachments`, 'GET'], [`/api/tasks/${id}/model-settings`, 'GET']]) {
    const { client, calls } = fixture([reply({ status: 'unknown' }), reply({ status: 'pending' })]);
    await client.api(path, method);
    assert.deepEqual(await client.api(path, method), { status: 'pending' });
    calls.forEach(assertUnconditional);
  }
});

test('same-path bodies remain isolated across machines while returning to one reuses only its own version', async () => {
  let machine = 'ged';
  const { client, calls } = fixture([
    reply(catalog('Ged')), reply(catalog('Wandou'), { machine: 'wandou', version: versionB }),
    unchanged({ 'X-Pocket-Source-Synced-At': '2000' }),
  ], () => machine);
  await client.api('/api/catalog'); machine = 'wandou';
  assert.equal((await client.api('/api/catalog')).threads[0].title, 'Wandou');
  assert.equal(calls[1].url, '/api/machines/wandou/catalog'); assertUnconditional(calls[1]);
  machine = 'ged';
  assert.equal((await client.api('/api/catalog')).threads[0].title, 'Ged');
  assert.equal(calls[2].headers.get('If-None-Match'), versionA);
});

test('wrong-machine 200 and 304 are rejected before body access, cache reuse or fallback', async () => {
  for (const status of [200, 304]) {
    let reads = 0;
    const wrong = { status, ok: status === 200, headers: new Headers({ 'X-Pocket-Machine': 'ged', ETag: versionA }),
      json: async () => { reads++; return catalog('Wrong machine'); } };
    const { client, calls } = fixture([reply(catalog('Wandou'), { machine: 'wandou' }), wrong], () => 'wandou');
    await client.api('/api/catalog');
    await assert.rejects(client.api('/api/catalog'), /来源不匹配/);
    assert.equal(reads, 0); assert.equal(calls.length, 2);
  }
});

test('clearing during a pending 200 prevents that late response from repopulating the cache', async () => {
  const pending = deferred(), { client, calls } = fixture([() => pending.promise, reply(catalog('New session'))]);
  const old = client.api('/api/catalog');
  client.clearReadResponses('ged'); pending.resolve(reply(catalog('Old session')));
  await old;
  assert.equal((await client.api('/api/catalog')).threads[0].title, 'New session');
  assertUnconditional(calls[1]);
});

test('clearing during pending 304 forces a full read and neither late response revives cleared cache ownership', async () => {
  const pending = deferred(), { client, calls } = fixture([
    reply(catalog('Old session')), () => pending.promise, reply(catalog('Fallback'), { version: versionB }),
    reply(catalog('Next current request'), { version: versionB }),
  ]);
  await client.api('/api/catalog');
  const old = client.api('/api/catalog'); client.clearReadResponses('ged');
  pending.resolve(unchanged({ 'X-Pocket-Source-Synced-At': '2000' }));
  assert.equal((await old).threads[0].title, 'Fallback'); assertUnconditional(calls[2]);
  assert.equal((await client.api('/api/catalog')).threads[0].title, 'Next current request'); assertUnconditional(calls[3]);
});

test('a previous session 401 cannot expire a successful login or clear its new read responses', async () => {
  const pending = deferred(), { client, calls, expired } = fixture([
    () => pending.promise, reply({ authenticated: true }, { version: null }), reply(catalog('New session'), { version: versionB }),
    unchanged({ 'X-Pocket-Source-Synced-At': '2000' }, { version: versionB }),
    reply({ error: 'current session expired' }, { status: 401, version: null }),
  ]);
  const old = client.api('/api/catalog');
  await client.api('/api/auth/login', 'POST', { passphrase: 'fixture' });
  await client.api('/api/catalog');
  pending.resolve(reply({ error: 'previous session expired' }, { status: 401, version: null }));
  await assert.rejects(old, error => error.status === 401);
  assert.deepEqual(expired, []);
  assert.equal((await client.api('/api/catalog')).threads[0].title, 'New session');
  assert.equal(calls[3].headers.get('If-None-Match'), versionB);
  await assert.rejects(client.api('/api/catalog'), /current session expired/);
  assert.deepEqual(expired, ['ged']);
});

test('late 401 responses do not repeat an already completed logout or explicit auth invalidation', async () => {
  for (const action of ['logout', 'invalidate']) {
    const pending = deferred(), { client, expired } = fixture([
      () => pending.promise, ...(action === 'logout' ? [reply({ authenticated: false }, { version: null })] : []),
    ]);
    const old = client.api('/api/catalog');
    if (action === 'logout') await client.api('/api/auth/logout', 'POST', {});
    else client.invalidateAuthentication('ged');
    pending.resolve(reply({ error: 'previous session expired' }, { status: 401, version: null }));
    await assert.rejects(old, error => error.status === 401);
    assert.deepEqual(expired, [], action);
  }
});

test('an old 403 is not replayed with a newly logged in session', async () => {
  const pending = deferred(), { client, calls, expired } = fixture([
    () => pending.promise, reply({ authenticated: true }, { version: null }),
  ]);
  const old = client.api(`/api/tasks/${id}/messages`, 'POST', { requestId: id, text: 'fixture' });
  await client.api('/api/auth/login', 'POST', { passphrase: 'fixture' });
  pending.resolve(reply({ error: '请求已过期，请刷新页面' }, { status: 403, version: null }));
  await assert.rejects(old, error => error.status === 403);
  assert.equal(calls.length, 2, 'stale mutation must not refresh credentials or retry');
  assert.deepEqual(expired, []);
});

test('login and logout revoke preceding requests before their response bodies finish', async () => {
  for (const action of ['login', 'logout']) for (const status of [401, 403]) {
    const pending = deferred(), bodyStarted = deferred(), body = deferred();
    const authResponse = reply(null, { version: null });
    authResponse.json = () => { bodyStarted.resolve(); return body.promise; };
    const { client, calls, expired } = fixture([() => pending.promise, authResponse]);
    const old = client.api(`/api/tasks/${id}/messages`, 'POST', { requestId: id, text: 'fixture' });
    const changing = client.api(`/api/auth/${action}`, 'POST', { passphrase: 'fixture' });
    await bodyStarted.promise;
    // Fetch already exposed the headers, so Set-Cookie can have taken effect
    // while the authentication response body is still being transferred.
    pending.resolve(reply({ error: status === 403 ? '请求已过期，请刷新页面' : 'old session expired' }, { status, version: null }));
    await assert.rejects(old, error => error.status === status);
    assert.equal(calls.length, 2, `${action}: do not refresh or replay the old mutation`);
    assert.deepEqual(expired, [], `${action}: old 401 must not expire the auth action in progress`);
    body.resolve({ authenticated: action === 'login' });
    assert.equal((await changing).authenticated, action === 'login');
  }
});

test('failed authentication actions do not reactivate preceding requests or suppress current expiry', async () => {
  for (const [action, status] of [['login', 401], ['logout', 503]]) {
    const pending = deferred(), { client, expired } = fixture([
      () => pending.promise, reply({ error: 'auth action failed' }, { status, version: null }),
      reply({ error: 'current session expired' }, { status: 401, version: null }),
    ]);
    const old = client.api('/api/catalog');
    await assert.rejects(client.api(`/api/auth/${action}`, 'POST', { passphrase: 'fixture' }), error => error.status === status);
    const failures = status === 401 ? ['ged'] : [];
    assert.deepEqual(expired, failures);
    pending.resolve(reply({ error: 'old session expired' }, { status: 401, version: null }));
    await assert.rejects(old, error => error.status === 401);
    assert.deepEqual(expired, failures, 'the earlier request remains superseded after failure');
    await assert.rejects(client.api('/api/catalog'), /current session expired/);
    assert.deepEqual(expired, [...failures, 'ged']);
  }
});

test('authentication changes preserve successful prior results without restoring their cached bodies', async () => {
  for (const [path, method, result] of [['/api/catalog', 'GET', catalog('Old session')],
    [`/api/tasks/${id}/messages`, 'POST', { requestId: id, status: 'accepted' }]]) {
    const pending = deferred(), { client, calls, expired } = fixture([
      () => pending.promise, reply({ authenticated: true }, { version: null }), reply(catalog('New session'), { version: versionB }),
    ]);
    const old = client.api(path, method);
    await client.api('/api/auth/login', 'POST', { passphrase: 'fixture' });
    pending.resolve(reply(result));
    assert.deepEqual(await old, result, 'already dispatched work still returns its actual result');
    assert.deepEqual(expired, []);
    await client.api('/api/catalog'); assertUnconditional(calls[2]);
  }
});

test('a late CSRF refresh cannot expire a new session, replace its token or replay the old mutation', async () => {
  for (const status of [200, 401]) {
    const refreshStarted = deferred(), refresh = deferred();
    const { client, calls, expired } = fixture([
      reply({ error: '请求已过期，请刷新页面' }, { status: 403, version: null }),
      () => { refreshStarted.resolve(); return refresh.promise; },
      reply({ authenticated: true }, { version: null }), reply({ status: 'accepted' }, { version: null }),
    ]);
    client.setToken('old-token');
    const old = client.api(`/api/tasks/${id}/messages`, 'POST', { requestId: id, text: 'fixture' });
    await refreshStarted.promise;
    await client.api('/api/auth/login', 'POST', { passphrase: 'fixture' });
    client.setToken('new-token');
    refresh.resolve(reply(status === 200 ? { csrfToken: 'late-old-token' } : { error: 'old session expired' }, { status, version: null }));
    await assert.rejects(old, error => error.status === 403);
    assert.deepEqual(expired, []);
    await client.api(`/api/tasks/${id}/messages`, 'POST', { requestId: 'new-request', text: 'next' });
    assert.equal(calls.length, 4, 'only the new mutation may use the current session');
    assert.equal(calls[3].headers.get('X-Navigator-Token'), 'new-token');
  }
});

test('authentication generations are machine scoped and independent of read-cache invalidation', async () => {
  let machine = 'ged';
  const pending = deferred(), { client, expired } = fixture([
    () => pending.promise, reply({ authenticated: true }, { machine: 'wandou', version: null }),
  ], () => machine);
  const ged = client.api('/api/catalog');
  machine = 'wandou'; await client.api('/api/auth/login', 'POST', { passphrase: 'fixture' });
  client.clearReadResponses('ged');
  pending.resolve(reply({ error: 'ged session expired' }, { status: 401, version: null }));
  await assert.rejects(ged, error => error.status === 401);
  assert.deepEqual(expired, ['ged']);
});

test('mutating either a full or hydrated returned object cannot corrupt the saved body', async () => {
  const { client } = fixture([
    reply(history()), unchanged({ 'X-Pocket-Checked-At': '2000', 'X-Pocket-Turn-Observed-At': '2000' }),
    unchanged({ 'X-Pocket-Checked-At': '3000', 'X-Pocket-Turn-Observed-At': '3000' }),
  ]);
  const path = `/api/tasks/${id}/history`, first = await client.api(path);
  first.messages[0].text = 'Mutated'; first.turnTiming.status = 'changed'; first.canSend = true;
  const second = await client.api(path);
  assert.equal(second.messages[0].text, 'Saved reply'); assert.equal(second.turnTiming.status, 'inProgress');
  assert.equal(second.canSend, false); second.messages.pop(); second.turnTiming.startedAt = 9999;
  const third = await client.api(path);
  assert.equal(third.messages[0].text, 'Saved reply'); assert.equal(third.turnTiming.startedAt, 500);
  assert.equal(third.checkedAt, 3000);
});

test('responses from older servers without a validator remain ordinary full reads', async () => {
  const { client, calls } = fixture([reply(catalog(), { version: null }), reply(catalog('Old server refresh'), { version: null })]);
  await client.api('/api/catalog');
  assert.equal((await client.api('/api/catalog')).threads[0].title, 'Old server refresh');
  calls.forEach(assertUnconditional);
});

test('read-response storage bounds count, bytes and lifetime and clones across every ownership boundary', t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const cache = createReadResponseCache(), original = { nested: { text: 'Original' } };
  cache.put('ged:GET:/api/catalog', versionA, original); original.nested.text = 'Caller changed';
  const copy = cache.get('ged:GET:/api/catalog'); assert.equal(copy.data.nested.text, 'Original');
  copy.data.nested.text = 'Reader changed'; assert.equal(cache.get('ged:GET:/api/catalog').data.nested.text, 'Original');
  now += 300001; assert.equal(cache.get('ged:GET:/api/catalog'), undefined);
  for (let index = 0; index < 33; index++) cache.put(`ged:${index}`, versionA, { index });
  assert.equal(cache.get('ged:0'), undefined); assert.equal(cache.get('ged:32').data.index, 32);
  cache.put('ged:too-large', versionA, 'x'.repeat(4 * 1024 * 1024)); assert.equal(cache.get('ged:too-large'), undefined);
  cache.put('wandou:only', versionB, {}); cache.clear('ged');
  assert.equal(cache.get('ged:32'), undefined); assert.deepEqual(cache.get('wandou:only').data, {});
});

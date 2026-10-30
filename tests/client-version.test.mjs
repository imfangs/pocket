import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER, clientVersionHeaders } from '../src/clientVersion.ts';
import { createApiClient } from '../src/api.ts';
import { createRequestActivity } from '../src/requestActivity.ts';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const readVersion = `W/"pocket-read-v1-${'a'.repeat(64)}"`;
const helperSource = ts.transpileModule(readFileSync(new URL('../src/clientVersion.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function helper(build, supplied = true) {
  const module = { exports: {} };
  runInNewContext(helperSource, { module, exports: module.exports, ...(supplied ? { __POCKET_BUILD_ID__: build } : {}) });
  return module.exports;
}
const reply = (data, status = 200, headers = {}, machine = 'ged') => new Response([204, 304].includes(status) ? null : JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'X-Pocket-Machine': machine, ...headers },
});
function fixture(steps, machine = 'ged') {
  const calls = [], expired = [];
  const client = createApiClient(() => machine, async (url, options) => {
    calls.push({ url, ...options, headers: new Headers(options.headers) });
    assert.ok(steps.length, `Unexpected request ${url}`);
    return steps.shift();
  }, value => expired.push(value), createRequestActivity());
  const carry = () => calls.forEach(call => assert.equal(call.headers.get(CLIENT_VERSION_HEADER), CLIENT_VERSION));
  return { client, calls, expired, carry };
}

test('one safe frontend build identifier produces fresh headers and has a Node fallback', () => {
  assert.equal(CLIENT_VERSION, 'development');
  assert.deepEqual(clientVersionHeaders(), { 'X-Pocket-Client-Version': 'development' });
  assert.equal(helper(undefined, false).CLIENT_VERSION, 'development');
  for (const build of ['c'.repeat(64), 'development', '1.2.3+abcdef', 'synthetic-reading-cache']) {
    const value = helper(build), first = value.clientVersionHeaders();
    assert.equal(value.CLIENT_VERSION, build);
    first[value.CLIENT_VERSION_HEADER] = 'caller mutation';
    assert.equal(value.clientVersionHeaders()[value.CLIENT_VERSION_HEADER], build);
  }
  for (const invalid of ['', 'x'.repeat(161), 'version\r\nX-Injected: yes', ' space', '版本', {}, 123, null])
    assert.equal(helper(invalid).CLIENT_VERSION, 'development');
});

test('normal JSON, authentication and raw attachment APIs all carry the controlled version', async () => {
  for (const machine of ['ged', 'wandou']) for (const [path, method, body, options] of [
    ['/api/auth/status', 'GET'], ['/api/auth/login', 'POST', { passphrase: 'synthetic' }], ['/api/auth/logout', 'POST', {}],
    ['/api/catalog', 'GET'], ['/api/sync', 'POST', {}], ['/api/feedback', 'POST', { frontendVersion: 'caller-body-value' }],
    [`/api/tasks/${id}/messages`, 'POST', { requestId: id, text: 'synthetic', clientVersion: 'cannot-override-header' }],
    [`/api/tasks/${id}/attachments/${id}?name=synthetic.png`, 'PUT', new Blob(['synthetic bytes']), { raw: true, contentType: 'image/png' }],
  ]) {
    const result = { ok: true }, f = fixture([reply(result, 200, {}, machine)], machine);
    f.client.setToken('synthetic-csrf');
    assert.deepEqual(await f.client.api(path, method, body, options), result); f.carry();
    const call = f.calls[0], expected = machine === 'ged' ? path : '/api/machines/wandou' + path.slice(4);
    assert.equal(call.url, expected, 'version is not appended to the URL or cache identity');
    assert.equal(call.cache, 'no-store'); assert.equal(call.headers.get('Content-Type'), options?.contentType ?? 'application/json');
    assert.equal(call.body, body === undefined ? undefined : options?.raw ? body : JSON.stringify(body));
  }
});

test('CSRF catalog recovery and the original retry carry the same version on either machine', async () => {
  for (const machine of ['ged', 'wandou']) {
    const f = fixture([reply({ error: '请求已过期，请刷新页面' }, 403, {}, machine),
      reply({ csrfToken: 'new-token' }, 200, {}, machine), reply({ status: 'accepted' }, 200, {}, machine)], machine);
    f.client.setToken('old-token'); const controller = new AbortController(), body = { requestId: id, text: 'same original input' };
    assert.deepEqual(await f.client.api(`/api/tasks/${id}/messages`, 'POST', body, { signal: controller.signal }), { status: 'accepted' });
    assert.equal(f.calls.length, 3); f.carry();
    assert.equal(f.calls[0].headers.get('X-Navigator-Token'), 'old-token');
    assert.equal(f.calls[1].headers.get('X-Navigator-Token'), null);
    assert.equal(f.calls[2].headers.get('X-Navigator-Token'), 'new-token');
    assert.equal(f.calls[0].body, f.calls[2].body); assert.ok(f.calls.every(call => call.signal === controller.signal));
  }
});

test('conditional GET and sync keep version headers through cached and full-body fallback responses', async () => {
  for (const [path, method, body, emptyStatus] of [['/api/catalog', 'GET', undefined, 304], ['/api/sync', 'POST', {}, 204]]) {
    const data = { threads: [], sourceInfo: { syncedAt: 1000 } };
    const f = fixture([reply(data, 200, { ETag: readVersion }),
      reply(null, emptyStatus, { ETag: readVersion, 'X-Pocket-Source-Synced-At': '2000' }),
      reply(null, emptyStatus, { ETag: readVersion }), reply(data, 200, { ETag: readVersion })]);
    await f.client.api(path, method, body);
    assert.equal((await f.client.api(path, method, body)).sourceInfo.syncedAt, 2000);
    await f.client.api(path, method, body); assert.equal(f.calls.length, 4); f.carry();
    const validator = method === 'GET' ? 'If-None-Match' : 'X-Pocket-Read-Version';
    assert.equal(f.calls[0].headers.get(validator), null); assert.equal(f.calls[1].headers.get(validator), readVersion);
    assert.equal(f.calls[2].headers.get(validator), readVersion); assert.equal(f.calls[3].headers.get(validator), null);
  }
});

test('bodyless first responses and failed refreshes also carry headers without extra retries', async () => {
  const missing = fixture([reply(null, 304, { ETag: readVersion }), reply({ threads: [] })]);
  await missing.client.api('/api/catalog'); assert.equal(missing.calls.length, 2); missing.carry();
  const expired = fixture([reply({ error: '请求已过期，请刷新页面' }, 403), reply({ error: 'expired' }, 401)]);
  await assert.rejects(expired.client.api(`/api/tasks/${id}/messages`, 'POST', {}), error => error.status === 403);
  assert.equal(expired.calls.length, 2); assert.deepEqual(expired.expired, ['ged']); expired.carry();
});

test('an injected production build hash reaches the actual API module rather than only the helper', () => {
  const hash = 'd'.repeat(64), apiUrl = new URL('../src/api.ts', import.meta.url).href;
  const script = `globalThis.__POCKET_BUILD_ID__=${JSON.stringify(hash)};
    const {createApiClient}=await import(${JSON.stringify(apiUrl)});
    const headers=[];
    const client=createApiClient(()=> 'ged',async (_url,options)=>{headers.push(new Headers(options.headers).get('X-Pocket-Client-Version'));return new Response('{}',{headers:{'X-Pocket-Machine':'ged'}});},()=>{});
    await client.api('/api/catalog');await client.api('/api/auth/login','POST',{});
    process.stdout.write(JSON.stringify(headers));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [hash, hash]);
});

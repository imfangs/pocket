import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseImageFailure, imageReadPermissionMessage } from '../src/imageFailureDiagnostic.ts';
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from '../src/clientVersion.ts';

const src = `/api/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/images/${'a'.repeat(64)}`;
const permissionBody = JSON.stringify({ error: imageReadPermissionMessage });
const permissionResponse = (body = permissionBody, headers = {}) => new Response(body, { status: 403,
  headers: { 'Content-Type': 'application/json', 'X-Pocket-Machine': 'ged', ...headers } });
const diagnose = response => diagnoseImageFailure(src, 'ged', new AbortController().signal, async () => response);

test('image diagnostics read only the registered capability with current machine, same origin and version', async () => {
  const calls = [];
  const result = await diagnoseImageFailure(src, 'ged', new AbortController().signal, async (path, options) => {
    calls.push({ path, options }); return permissionResponse();
  });
  assert.equal(result, 'permission'); assert.equal(calls.length, 1); assert.equal(calls[0].path, src);
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.mode, 'same-origin'); assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers[CLIENT_VERSION_HEADER], CLIENT_VERSION);
  assert.equal(calls[0].options.headers.Accept, 'application/json');
});
test('external URLs, paths, queries, file routes and unselected machines never start a diagnostic', async () => {
  let reads = 0; const request = async () => { reads++; return permissionResponse(); };
  for (const value of ['https://external.invalid' + src, '/Users/example/Documents/private.png', src + '?file=/private',
    src.replace('/images/', '/files/'), src.replace('/images/', '/images/../images/'), '/api/machines/wandou' + src.slice(4)])
    assert.equal(await diagnoseImageFailure(value, 'ged', new AbortController().signal, request), null);
  for (const machine of [null, 'other', 'wandou']) assert.equal(await diagnoseImageFailure(src, machine, new AbortController().signal, request), null);
  const controller = new AbortController(); controller.abort();
  assert.equal(await diagnoseImageFailure(src, 'ged', controller.signal, request), null); assert.equal(reads, 0);
});
test('only the fixed 403 JSON permission reason can become a permission message', async () => {
  for (const response of [new Response(permissionBody, { status: 404, headers: { 'Content-Type': 'application/json' } }),
    new Response(permissionBody, { status: 401, headers: { 'Content-Type': 'application/json' } }),
    permissionResponse(JSON.stringify({ error: 'Unexpected private server detail' })), permissionResponse('{invalid'),
    permissionResponse(permissionBody, { 'Content-Type': 'text/html' }),
    permissionResponse(permissionBody, { 'X-Pocket-Machine': 'wandou' }),
    permissionResponse(permissionBody, { 'Content-Length': '1025' }), permissionResponse(' '.repeat(1025) + permissionBody)])
    assert.equal(await diagnose(response), null);
});
test('success and unrecognized status cancel the body without reading or retaining image bytes', async () => {
  for (const status of [200, 404]) {
    let reads = 0, cancelled = false;
    const body = new ReadableStream({ pull() { reads++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
    assert.equal(await diagnose(new Response(body, { status, headers: { 'Content-Type': 'image/png' } })), null);
    assert.equal(reads, 0); assert.equal(cancelled, true);
  }
});
test('a JSON stream without Content-Length stops at the byte limit and cancels unread data', async () => {
  let reads = 0, cancelled = false;
  const body = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(700)); },
    cancel() { cancelled = true; } }, { highWaterMark: 0 });
  assert.equal(await diagnose(permissionResponse(body)), null); assert.equal(reads, 2); assert.equal(cancelled, true);
});
test('leaving or retrying cancels a stalled diagnostic body without waiting for new bytes', async () => {
  let cancelled = false, start;
  const started = new Promise(done => { start = done; });
  const body = new ReadableStream({ pull() { start(); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const controller = new AbortController();
  const result = diagnoseImageFailure(src, 'ged', controller.signal, async () => permissionResponse(body));
  await started; controller.abort(); assert.equal(await result, null); assert.equal(cancelled, true);
});
test('a stalled diagnostic has a finite deadline and cancels its response body', { timeout: 5000 }, async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const started = Date.now(); assert.equal(await diagnose(permissionResponse(body)), null);
  assert.equal(cancelled, true); assert.ok(Date.now() - started < 4500);
});
test('the selected nondefault machine uses its exact route and requires a matching response header', async () => {
  const previous = global.window;
  global.window = { location: { search: '?machine=wandou' }, localStorage: { getItem: () => null } };
  try {
    let path;
    assert.equal(await diagnoseImageFailure(src, 'wandou', new AbortController().signal, async value => {
      path = value; return permissionResponse(permissionBody, { 'X-Pocket-Machine': 'wandou' });
    }), 'permission');
    assert.equal(path, '/api/machines/wandou' + src.slice(4));
    assert.equal(await diagnoseImageFailure(src, 'wandou', new AbortController().signal, async () =>
      new Response(permissionBody, { status: 403, headers: { 'Content-Type': 'application/json' } })), null);
  } finally { global.window = previous; }
});

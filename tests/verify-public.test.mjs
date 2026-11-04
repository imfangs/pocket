import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { publicCheckGet } from '../bin/public-check-http.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../bin/verify-public.mjs', import.meta.url));
const policy = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
  .match(/Content-Security-Policy: (.+)/)[1];
const analyticsEnabled = JSON.parse(readFileSync(new URL('../config/usage-analytics.json', import.meta.url), 'utf8')).enabled === true;

async function serve(t, handler, tls) {
  const requests = [];
  const listener = (req, res) => { requests.push({ path: req.url, method: req.method, headers: req.headers }); handler(req, res); };
  const server = tls ? https.createServer(tls, listener) : http.createServer(listener);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, requests, base: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}` };
}

function validResponse(req, res) {
  if (req.url === '/') {
    res.writeHead(200, { 'content-security-policy': policy });
    res.end('<!doctype html><title>Pocket fixture</title>');
  } else if (req.url === '/api/catalog' || req.url === '/api/export') {
    res.writeHead(401); res.end('{"error":"authentication required"}');
  } else if (req.url === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(gzipSync('{"display":"standalone"}'));
  } else { res.writeHead(404); res.end(); }
}

const verify = (base, env = process.env) => execute(process.execPath, [script, base], { env, timeout: 10_000 });

test('the real CLI reads four anonymous GETs, ignores curlrc credentials, and decodes compressed JSON', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'pocket-public-curlrc-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(join(temp, '.curlrc'), 'header = "Authorization: Bearer private-canary"\nheader = "Cookie: session=private-canary"\ninsecure\nlocation\n');
  const fixture = await serve(t, validResponse);
  const { stdout } = await verify(fixture.base, { ...process.env, CURL_HOME: temp });
  assert.deepEqual(JSON.parse(stdout), { ok: true, anonymousProtected: true, manifest: true, documentCsp: true, analyticsConnections: analyticsEnabled ? 'allowed' : 'disabled' });
  assert.deepEqual(fixture.requests.map(r => r.path), ['/', '/api/catalog', '/api/export', '/manifest.webmanifest']);
  assert.ok(fixture.requests.every(r => r.method === 'GET' && !r.headers.authorization && !r.headers.cookie));
});

test('unsafe origins, credentials and unlisted paths fail before making any request and do not echo input', async () => {
  for (const base of ['not-a-url-secret', 'http://example.invalid', 'https://person:private-canary@example.invalid', 'https://example.invalid/?token=private-canary', 'https://example.invalid/#private-canary', 'file:///private-canary', 'https://{one,two}.example.invalid']) {
    await assert.rejects(publicCheckGet(base, '/'), error => !error.message.includes('private-canary') && !error.message.includes('not-a-url-secret'));
  }
  for (const path of ['https://other.invalid/', '//other.invalid/', '/api/catalog?token=private-canary', '/api/health'])
    await assert.rejects(publicCheckGet('https://example.invalid', path), /path is not allowed/);
});

test('home policy, API authentication and manifest assertions reject bad responses without retrying', async t => {
  const cases = [
    { path: '/', status: 503, headers: { 'content-security-policy': policy }, body: '<title>unavailable</title>', error: /CSP does not match/ },
    { path: '/', status: 200, headers: { 'content-security-policy': "default-src 'none'" }, body: '', error: /CSP does not match/ },
    { path: '/api/catalog', status: 200, body: '{}', error: /must require authentication: 200/ },
    { path: '/api/export', status: 500, body: '{}', error: /must require authentication: 500/ },
    { path: '/manifest.webmanifest', status: 500, body: '{"display":"standalone"}', error: /Manifest must return HTTP 200: 500/ },
    { path: '/manifest.webmanifest', status: 200, body: '{"display":"browser"}', error: /Manifest unavailable/ },
    { path: '/manifest.webmanifest', status: 200, body: 'null', error: /Manifest unavailable/ },
    { path: '/manifest.webmanifest', status: 200, body: 'private-canary: invalid JSON', error: /Manifest response is not valid JSON/ },
  ];
  for (const item of cases) await t.test(`${item.path} ${item.status} ${item.error}`, async t => {
    const fixture = await serve(t, (req, res) => {
      if (req.url !== item.path) return validResponse(req, res);
      res.writeHead(item.status, item.headers); res.end(item.body);
    });
    await assert.rejects(verify(fixture.base), error => item.error.test(error.stderr) && !error.stderr.includes('private-canary'));
    assert.equal(fixture.requests.filter(r => r.path === item.path).length, 1);
  });
});

test('a redirect is rejected even with valid manifest JSON, and its destination is never requested', async t => {
  const destination = await serve(t, validResponse);
  const fixture = await serve(t, (req, res) => {
    if (req.url !== '/manifest.webmanifest') return validResponse(req, res);
    res.writeHead(302, { location: `${destination.base}/manifest.webmanifest` });
    res.end('{"display":"standalone"}');
  });
  await assert.rejects(verify(fixture.base), error => /does not follow redirects/.test(error.stderr));
  assert.equal(destination.requests.length, 0);
  assert.equal(fixture.requests.filter(r => r.path === '/manifest.webmanifest').length, 1);
});

test('known empty-response failures retry the same GET at most three times', async t => {
  let attempts = 0;
  const recovering = await serve(t, (req, res) => {
    if (++attempts < 3) return req.socket.destroy();
    res.writeHead(200, { 'x-fixture': 'actual-response' }); res.end('recovered');
  });
  const response = await publicCheckGet(recovering.base, '/', { retryDelayMs: 0 });
  assert.equal(attempts, 3);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-fixture'), 'actual-response');
  assert.equal(await response.text(), 'recovered');
  const failing = await serve(t, req => req.socket.destroy());
  await assert.rejects(publicCheckGet(failing.base, '/', { retryDelayMs: 0 }), /3 attempts/);
  assert.equal(failing.requests.length, 3);
});

test('an interrupted HTTP rejection is not retried as a transport failure', async t => {
  const fixture = await serve(t, (_req, res) => {
    res.writeHead(503, { 'content-length': '1000' });
    res.flushHeaders(); res.write('partial');
    setTimeout(() => res.destroy(), 10);
  });
  await assert.rejects(publicCheckGet(fixture.base, '/', { retryDelayMs: 0 }), /HTTP 503/);
  assert.equal(fixture.requests.length, 1);
});

test('an interrupted successful response retries without mixing its partial body into the result', async t => {
  let attempts = 0;
  const fixture = await serve(t, (_req, res) => {
    if (++attempts > 1) { res.end('complete response'); return; }
    res.writeHead(200, { 'content-length': '1000' });
    res.flushHeaders(); res.write('partial body');
    setTimeout(() => res.destroy(), 10);
  });
  const response = await publicCheckGet(fixture.base, '/', { retryDelayMs: 0 });
  assert.equal(await response.text(), 'complete response');
  assert.equal(attempts, 2);
});

test('request time and decoded body size are bounded', async t => {
  const stalled = await serve(t, () => {});
  const start = Date.now();
  await assert.rejects(publicCheckGet(stalled.base, '/', { timeoutMs: 180, retryDelayMs: 0 }), /3 attempts/);
  assert.equal(stalled.requests.length, 3);
  assert.ok(Date.now() - start < 3000);
  const oversized = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end(gzipSync('a'.repeat(5000)));
  });
  await assert.rejects(publicCheckGet(oversized.base, '/', { maxBodyBytes: 100, retryDelayMs: 0 }), /body limit|transport unavailable|curl 63/);
  assert.equal(oversized.requests.length, 1);
});

test('interim headers do not replace final response headers and excessive headers fail closed', async t => {
  const hints = await serve(t, (_req, res) => {
    res.writeEarlyHints({ link: '</style.css>; rel=preload; as=style', 'content-security-policy': 'default-src *' });
    res.writeHead(200, { 'content-security-policy': policy }); res.end('final body');
  });
  const response = await publicCheckGet(hints.base, '/');
  assert.equal(response.headers.get('content-security-policy'), policy);
  assert.equal(await response.text(), 'final body');
  const largeHeaders = await serve(t, (_req, res) => {
    res.writeHead(200, { 'x-oversized': 'a'.repeat(70_000) }); res.end('body');
  });
  await assert.rejects(publicCheckGet(largeHeaders.base, '/', { retryDelayMs: 0 }), /oversized HTTP headers/);
  assert.equal(largeHeaders.requests.length, 1);
});

test('TLS certificate verification is retained and certificate failures are not retried', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'pocket-public-tls-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const key = join(temp, 'key.pem'), cert = join(temp, 'cert.pem');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { timeout: 10_000 });
  const fixture = await serve(t, validResponse, { key: await readFile(key), cert: await readFile(cert) });
  let handshakes = 0;
  fixture.server.on('tlsClientError', () => { handshakes++; });
  await assert.rejects(publicCheckGet(fixture.base, '/', { retryDelayMs: 0 }), /curl 60, 1 attempt/);
  assert.equal(fixture.requests.length, 0);
  assert.equal(handshakes, 1);
});

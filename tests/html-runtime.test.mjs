import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import worker from '../edge/worker.mjs';
import { buildWorkerSource, preparePages } from '../bin/prepare-pages.mjs';
import { htmlPreviewShellPath, htmlPreviewShellAlias, interactiveHtmlPolicy, htmlPreviewSandbox, maxInteractiveHtmlChars } from '../shared/html-runtime-policy.mjs';
import { makeApp } from '../server/index.mjs';

const nonce = 'a'.repeat(32), origin = 'https://pocket.example.com';
const runtime = readFileSync(new URL('../public/html-preview-runtime.js', import.meta.url), 'utf8');
const strict = "default-src 'self'; script-src 'self'; frame-ancestors 'none'";
function bootstrap(hash = '#' + nonce, standalone = false) {
  const listeners = new Map(), events = [], writes = [];
  let dialogOpen = false;
  const parent = { postMessage: (...args) => events.push(args) };
  const window = { setTimeout, addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); } };
  runInNewContext(runtime, { parent: standalone ? window : parent, window, location: { hash, href: origin + htmlPreviewShellPath + hash }, URL, queueMicrotask,
    document: { open: () => writes.push('open'), write: html => writes.push(html), close: () => writes.push('close'),
      addEventListener: (type, listener) => listeners.set('document:' + type, listener), querySelector: () => dialogOpen ? {} : null } });
  return { parent, window, events, writes, listeners, send: event => listeners.get('message')?.(event),
    key: event => listeners.get('document:keydown')?.(event), dialog: open => { dialogOpen = open; } };
}

test('runtime handoff requires parent identity, exact origin, nonce, bounded HTML and one initialization', () => {
  const h = bootstrap();
  assert.equal(h.events.length, 1); assert.equal(h.events[0][0].type, 'pocket-html-preview-ready'); assert.equal(h.events[0][0].nonce, nonce); assert.equal(h.events[0][1], origin);
  const event = { source: h.parent, origin, data: { type: 'pocket-html-preview-init', nonce, html: '<h1>Private in-memory page</h1>' } };
  for (const bad of [
    { ...event, source: {} }, { ...event, origin: 'null' }, { ...event, origin: origin + '.other' },
    { ...event, data: { ...event.data, nonce: 'b'.repeat(32) } }, { ...event, data: { ...event.data, type: 'unknown' } },
    { ...event, data: { ...event.data, html: {} } }, { ...event, data: { ...event.data, html: 'x'.repeat(maxInteractiveHtmlChars + 1) } },
  ]) h.send(bad);
  assert.equal(h.writes.length, 0);
  h.send(event); assert.deepEqual(h.writes, ['open', event.data.html, 'close']);
  h.send({ ...event, data: { ...event.data, html: 'replace' } }); assert.equal(h.writes.length, 3);
  assert.equal(h.listeners.has('message'), false);
});

test('the Escape bridge respects author dialogs, late preventDefault and IME before closing only its preview', async () => {
  const h = bootstrap(); h.send({ source: h.parent, origin, data: { type: 'pocket-html-preview-init', nonce, html: '<p>preview</p>' } });
  const event = extra => ({ key: 'Escape', defaultPrevented: false, isComposing: false, keyCode: 27, composedPath: () => [], ...extra });
  for (const extra of [{ key: 'Enter' }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) h.key(event(extra));
  h.dialog(true); h.key(event()); h.dialog(false);
  h.key(event({ composedPath: () => [{ matches: () => true }] }));
  const cancelled = event(); h.key(cancelled); cancelled.defaultPrevented = true;
  await new Promise(done => setTimeout(done, 5)); assert.equal(h.events.length, 1);
  h.key(event()); await new Promise(done => setTimeout(done, 5));
  assert.equal(h.events.length, 2); assert.equal(h.events[1][0].type, 'pocket-html-preview-close');
  assert.equal(h.events[1][0].nonce, nonce); assert.equal(h.events[1][1], origin);
});

test('invalid and standalone shell URLs cannot request or accept private HTML', () => {
  for (const hash of ['', '#short', '#' + 'z'.repeat(32), '#' + nonce + '?html=private']) {
    const h = bootstrap(hash); assert.equal(h.events.length, 0); assert.equal(h.listeners.size, 0);
  }
  const h = bootstrap('#' + nonce, true); assert.equal(h.events.length, 0); assert.equal(h.listeners.size, 0);
  const shell = readFileSync(new URL('../public/html-preview-shell.html', import.meta.url), 'utf8');
  assert.match(shell, /src="\/html-preview-runtime\.js"/); assert.doesNotMatch(shell, /srcdoc|api\/|authorization|private-/i);
  assert.ok(!htmlPreviewSandbox.includes('allow-same-origin') && !htmlPreviewSandbox.includes('allow-top-navigation'));
});

test('the shell Worker replaces strict static CSP without loosening ordinary Pocket assets', async () => {
  const assets = { fetch: async request => new Response(request.url.endsWith(htmlPreviewShellPath) ? '<body>public bootstrap</body>' : 'ordinary', {
    headers: { 'Content-Security-Policy': strict, 'X-Frame-Options': 'DENY', 'Content-Type': 'text/html' },
  }) };
  const shell = await worker.fetch(new Request(origin + htmlPreviewShellPath), { ASSETS: assets });
  assert.equal(shell.headers.get('content-security-policy'), interactiveHtmlPolicy);
  assert.equal(shell.headers.get('x-frame-options'), null); assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer'); assert.equal(shell.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await shell.text(), '<body>public bootstrap</body>');
  const ordinary = await worker.fetch(new Request(origin + '/index.html'), { ASSETS: assets });
  assert.equal(ordinary.headers.get('content-security-policy'), strict); assert.equal(ordinary.headers.get('x-frame-options'), 'DENY');
  assert.equal((await worker.fetch(new Request(origin + htmlPreviewShellPath, { method: 'POST' }), { ASSETS: assets })).status, 405);
  assert.equal((await worker.fetch(new Request(origin + htmlPreviewShellPath + '?html=never'), { ASSETS: assets })).status, 400);
  const head = await worker.fetch(new Request(origin + htmlPreviewShellPath, { method: 'HEAD' }), { ASSETS: assets });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('canonical .html redirection remains an internal same-origin shell read', async () => {
  const calls = [];
  const env = { ASSETS: { fetch: async request => {
    calls.push(request.url);
    return new URL(request.url).pathname === htmlPreviewShellPath
      ? new Response(null, { status: 301, headers: { Location: htmlPreviewShellAlias } })
      : new Response('canonical bootstrap', { headers: { 'Content-Security-Policy': strict } });
  } } };
  const response = await worker.fetch(new Request(origin + htmlPreviewShellPath), env);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'canonical bootstrap');
  assert.equal(response.headers.get('content-security-policy'), interactiveHtmlPolicy); assert.equal(calls.length, 2);
  for (const target of ['https://elsewhere.invalid' + htmlPreviewShellAlias, '/index.html', htmlPreviewShellAlias + '?html=secret']) {
    const rejected = await worker.fetch(new Request(origin + htmlPreviewShellPath), { ASSETS: { fetch: async () => new Response(null, { status: 301, headers: { Location: target } }) } });
    assert.equal(rejected.status, 502);
  }
});

test('prepared Worker is standalone, has the exact shared policy and routes only the isolated shell additionally', async t => {
  const source = buildWorkerSource(); assert.doesNotMatch(source, /import .*html-runtime-policy/);
  assert.ok(source.includes(JSON.stringify(interactiveHtmlPolicy)));
  const compiled = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
  const reply = await compiled.fetch(new Request(origin + htmlPreviewShellPath), { ASSETS: { fetch: async () => new Response('bootstrap', { headers: { 'Content-Security-Policy': strict } }) } });
  assert.equal(reply.headers.get('content-security-policy'), interactiveHtmlPolicy);
  const folder = mkdtempSync(join(tmpdir(), 'pocket-html-worker-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  preparePages({ directory: folder });
  assert.deepEqual(JSON.parse(readFileSync(join(folder, '_routes.json'))), { version: 1, include: ['/api/*', htmlPreviewShellPath, htmlPreviewShellAlias], exclude: [] });
});

test('Node static shell and its alias share the isolated policy while app, runtime assets and authenticated APIs remain strict', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'pocket-node-html-shell-'));
  const shell = readFileSync(new URL('../public/html-preview-shell.html', import.meta.url));
  writeFileSync(join(folder, htmlPreviewShellPath.slice(1)), shell);
  writeFileSync(join(folder, 'html-preview-runtime.js'), runtime); writeFileSync(join(folder, 'index.html'), '<h1>ordinary</h1>');
  writeFileSync(join(folder, 'other-shell.html'), shell);
  const app = makeApp({ dist: folder, dataDir: join(folder, 'data'), codexHome: folder,
    readSource: () => ({ threads: [], projects: [], sourceInfo: {} }), openThread: async () => { throw new Error('No native owner'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { app.server.closeAllConnections(); await new Promise(done => app.server.close(done)); rmSync(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const path of [htmlPreviewShellPath, htmlPreviewShellAlias]) {
    const response = await fetch(base + path); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-security-policy'), interactiveHtmlPolicy); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(await response.text(), shell.toString());
  }
  for (const path of ['/', '/other-shell.html', '/html-preview-runtime.js', '/api/health']) {
    const response = await fetch(base + path); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self';/);
    assert.doesNotMatch(response.headers.get('content-security-policy'), /unsafe-eval/);
  }
  assert.equal((await fetch(base + '/api/catalog')).status, 401);
  assert.equal((await fetch(base + htmlPreviewShellPath + '?html=never')).status, 400);
  const head = await fetch(base + htmlPreviewShellAlias, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

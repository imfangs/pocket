import './helpers/block-native-open.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { makeApp } from '../server/index.mjs';
import { MessageFiles } from '../server/message-files.mjs';
import { MAX_MESSAGE_AUDIO_BYTES } from '../server/message-audio-stream.mjs';
import { wav, mp3, m4a, aac, ogg, flac } from './helpers/audio-fixtures.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
async function fixture(t, { messageFiles, machineId = 'ged' } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), 'pocket-audio-http-')), cwd = join(baseDir, 'project'); mkdirSync(cwd);
  const contents = new Map([['sound.wav', wav(100000)], ['sound.mp3', mp3()], ['sound.m4a', m4a()],
    ['sound.aac', aac()], ['sound.ogg', ogg()], ['sound.oga', ogg('vorbis')], ['lossless.ogg', ogg('flac')], ['sound.flac', flac()],
    ['fake.mp3', Buffer.from('<html>private synthetic data</html>')], ['drawing.svg', Buffer.from('<svg onload="alert(1)"/>')],
    ['wrong.mp3', wav()], ['large.m4a', m4a()]]);
  for (const [name, bytes] of contents) writeFileSync(join(cwd, name), bytes);
  truncateSync(join(cwd, 'large.m4a'), MAX_MESSAGE_AUDIO_BYTES + 1);
  const outside = join(baseDir, 'outside.wav'); writeFileSync(outside, wav()); symlinkSync(outside, join(cwd, 'escape.wav'));
  const text = [...contents.keys(), 'missing.wav', 'escape.wav'].map(name => `[${name}](<${join(cwd, name)}>)`).join('\n\n');
  const message = { id: 'audio-file-message', role: 'assistant', phase: 'final', text };
  let currentCwd = cwd, now = 10000, opens = 0;
  const app = makeApp({ dataDir: join(baseDir, 'data'), codexHome: baseDir, machineId,
    readSource: () => ({ threads: [id, other].map(id => ({ id, cwd: currentCwd, title: 'Audio fixture', updatedAt: 1 })), projects: [], sourceInfo: {} }),
    readHistory: () => ({ source: 'rollout', messages: [message] }),
    desktopRequest: async () => ({ ok: true, source: 'desktop', runtime: 'idle', messages: [message] }),
    openThread: async () => { opens++; throw new Error('No native opening'); },
    messageFiles: { now: () => now, ...messageFiles },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); rmSync(baseDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, auth = { Authorization: `Bearer ${app.auth.localToken}` };
  const read = (path, options = {}) => fetch(base + path, { ...options, headers: { ...auth, ...options.headers } });
  const history = await (await read(`/api/tasks/${id}/history`)).json(), files = history.messages[0].files;
  return { app, baseDir, cwd, base, read, auth, contents, history, files, text,
    audio: name => files[join(cwd, name)].url + '/audio', download: name => files[join(cwd, name)].url,
    advance: () => { now += 3600000; }, setCwd: value => { currentCwd = value; app.sync(); }, opens: () => opens };
}
async function jsonError(response, status, f, expected) {
  assert.equal(response.status, status); assert.match(response.headers.get('content-type'), /^application\/json\b/);
  const raw = await response.text(), body = JSON.parse(raw); assert.deepEqual(Object.keys(body), ['error']);
  if (expected) assert.equal(body.error, expected);
  for (const value of [f.baseDir, 'EPERM', 'EACCES', 'TCC']) assert.equal(raw.includes(value), false);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('authenticated audio GET serves all strict container types and preserves ordinary file download bytes', async t => {
  const f = await fixture(t);
  assert.equal(f.history.messages[0].text, f.text); assert.deepEqual(f.history.messages[0].images, {});
  for (const [name, type] of [['sound.wav', 'audio/wav'], ['sound.mp3', 'audio/mpeg'], ['sound.m4a', 'audio/mp4'],
    ['sound.aac', 'audio/aac'], ['sound.ogg', 'audio/ogg'], ['sound.oga', 'audio/ogg'], ['lossless.ogg', 'audio/ogg'], ['sound.flac', 'audio/flac']]) {
    const response = await f.read(f.audio(name)); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), type);
    assert.equal(response.headers.get('content-length'), String(f.contents.get(name).length));
    for (const [key, value] of Object.entries({ 'cache-control': 'no-store', 'accept-ranges': 'bytes',
      'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'x-pocket-machine': 'ged' })) assert.equal(response.headers.get(key), value);
    assert.match(response.headers.get('content-disposition'), /^inline;/);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.contents.get(name));
    const download = await f.read(f.download(name)); assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), f.contents.get(name));
  }
  assert.equal(f.opens(), 0);
});

test('audio HTTP HEAD, Range, If-Range and unsatisfiable ranges retain exact byte boundaries', async t => {
  const f = await fixture(t, { machineId: 'wandou' }), url = f.audio('sound.wav'), bytes = f.contents.get('sound.wav');
  let response = await f.read(url, { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), String(bytes.length));
  assert.equal((await response.arrayBuffer()).byteLength, 0); const etag = response.headers.get('etag'); assert.match(etag, /^"audio-/);
  for (const [range, first, last] of [['bytes=0-43', 0, 43], ['bytes=190000-', 190000, bytes.length - 1], ['bytes=-20', bytes.length - 20, bytes.length - 1]]) {
    response = await f.read(url, { headers: { Range: range, 'If-Range': etag } }); assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${first}-${last}/${bytes.length}`);
    assert.equal(response.headers.get('x-pocket-machine'), 'wandou'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(first, last + 1));
  }
  response = await f.read(url, { headers: { Range: 'bytes=999999-', 'If-Range': '"older"' } });
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  for (const range of ['bytes=999999-', 'bytes=4-2', 'bytes=0-1,4-5']) {
    response = await f.read(url, { headers: { Range: range } }); assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`); assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test('audio route rejects anonymous, cross-site, bad Host, foreign capabilities, query parameters and writes', async t => {
  const f = await fixture(t), url = f.audio('sound.wav');
  await jsonError(await fetch(f.base + url), 401, f);
  for (const headers of [{ Origin: 'https://other.test' }, { 'Sec-Fetch-Site': 'cross-site' }]) await jsonError(await f.read(url, { headers }), 403, f);
  const hostile = await new Promise((resolve, reject) => {
    const call = httpRequest(f.base + url, { headers: { ...f.auth, Host: 'unauthorized.invalid' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers }))); response.on('error', reject);
    }); call.on('error', reject); call.end();
  }); await jsonError(hostile, 403, f);
  await jsonError(await f.read(url.replace(id, other)), 404, f);
  await jsonError(await f.read(`/api/tasks/${id}/files/${'0'.repeat(64)}/audio`), 404, f);
  for (const query of ['?path=/etc/passwd', '?download=1', '?audio=1', '?x=1&x=2']) await jsonError(await f.read(url + query), 400, f);
  const catalog = await (await f.read('/api/catalog')).json();
  for (const method of ['POST', 'PUT', 'DELETE']) await jsonError(await f.read(url, { method, headers: { Origin: f.base, 'X-Navigator-Token': catalog.csrfToken } }), 405, f);
  assert.equal(f.opens(), 0);
});

test('audio HTTP format/size/path/cwd/lifetime failures remain private JSON responses', async t => {
  const f = await fixture(t);
  for (const [name, status] of [['fake.mp3', 415], ['wrong.mp3', 415], ['drawing.svg', 415], ['large.m4a', 413], ['missing.wav', 404], ['escape.wav', 403]])
    await jsonError(await f.read(f.audio(name)), status, f);
  const url = f.audio('sound.wav'); f.setCwd(f.baseDir); await jsonError(await f.read(url), 404, f);
  f.setCwd(f.cwd); f.advance(); await jsonError(await f.read(url), 404, f);
});

for (const code of ['EPERM', 'EACCES']) {
  test(`audio HTTP ${code} uses fixed permission text without exposing native failure fields`, async t => {
    let opened = false, closed = false;
    const f = await fixture(t, { messageFiles: { openFile: async (path, flags) => {
      const file = await open(path, flags); opened = true;
      return { stat: options => file.stat(options), read: () => { throw Object.assign(new Error(`${code}: '${path}'`), { code, path }); },
        close: async () => { closed = true; await file.close(); } };
    } } });
    await jsonError(await f.read(f.audio('sound.wav')), 403, f, 'Mac 服务无权读取这个音频，请在电脑上检查文件访问权限');
    assert.equal(opened, true); assert.equal(closed, true);
  });
}

test('audio client cancellation closes the real streaming descriptor while a subsequent chunk is pending', { timeout: 5000 }, async t => {
  let reads = 0, closes = 0, release, finished;
  const gate = new Promise(resolve => { release = resolve; }), closed = new Promise(resolve => { finished = resolve; });
  const f = await fixture(t, { messageFiles: { openFile: async (path, flags) => {
    const file = await open(path, flags);
    return { stat: options => file.stat(options), read: async (...args) => { if (++reads >= 3) await gate; return file.read(...args); },
      close: async () => { closes++; await file.close(); finished(); } };
  } } });
  const controller = new AbortController(), response = await f.read(f.audio('sound.wav'), { signal: controller.signal });
  const reader = response.body.getReader(); assert.ok((await reader.read()).value.length > 0);
  controller.abort(); await closed; release(); await assert.rejects(reader.read());
  assert.equal(closes, 1);
});

test('shutdown cancels active audio and rejects new media streams while preserving ordinary downloads', { timeout: 5000 }, async t => {
  const f = await fixture(t); let first = true, closes = 0, finished;
  const closed = new Promise(resolve => { finished = resolve; });
  const stream = new Readable({ read() { if (first) { first = false; this.push(Buffer.alloc(1024)); } } });
  t.mock.method(MessageFiles.prototype, 'openAudio', async () => ({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Content-Length': '100000' }, stream,
    close: async () => { closes++; stream.destroy(); finished(); } }));
  const response = await f.read(f.audio('sound.wav')), reader = response.body.getReader(); await reader.read();
  f.app.stopVideoStreams(); await closed; await assert.rejects(reader.read()); assert.equal(closes, 1);
  await jsonError(await f.read(f.audio('sound.wav')), 503, f);
  const download = await f.read(f.download('sound.wav')); assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), f.contents.get('sound.wav'));
});

test('shutdown during an audio HEAD preparation closes a result that resolves after cancellation', { timeout: 5000 }, async t => {
  const f = await fixture(t); let entered, release, finished, closes = 0;
  const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; }), closed = new Promise(resolve => { finished = resolve; });
  t.mock.method(MessageFiles.prototype, 'openAudio', async () => { entered(); await gate; return { status: 200, headers: { 'Content-Type': 'audio/wav', 'Content-Length': '100' }, stream: null,
    close: async () => { closes++; finished(); } }; });
  const pending = assert.rejects(f.read(f.audio('sound.wav'), { method: 'HEAD' })); await ready;
  f.app.stopVideoStreams(); release(); await pending; await closed; assert.equal(closes, 1);
});

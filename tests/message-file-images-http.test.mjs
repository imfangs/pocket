import './helpers/block-native-open.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, truncateSync, rmSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { makeApp } from '../server/index.mjs';

const a = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
// These JPEG/WebP samples exercise byte-signature transport, not browser decoding.
const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 255, 217]);
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const webp = Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 synthetic payload', 'latin1');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const permissionMessage = 'Mac 服务无权读取这张图片，请在电脑上检查文件访问权限';

async function fixture(t, options = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), 'pocket-file-image-http-')), cwd = join(baseDir, 'project');
  mkdirSync(cwd);
  const contents = new Map([
    ['image.png', png], ['photo.JPG', jpeg], ['photo.jpeg', jpeg], ['animation.gif', gif], ['picture.webp', webp],
    ['fake.jpg', Buffer.from('<html>private synthetic data</html>')], ['wrong-signature.jpg', png],
    ['drawing.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ['page.html', Buffer.from('<script>throw new Error("must not preview")</script>')],
    ['large.jpg', jpeg], ['empty.jpg', Buffer.alloc(0)], ['short.jpg', Buffer.from([255, 216, 255])],
  ]);
  for (const [name, bytes] of contents) writeFileSync(join(cwd, name), bytes);
  truncateSync(join(cwd, 'large.jpg'), 8 * 1024 * 1024 + 1);
  mkdirSync(join(cwd, 'directory.jpg'));
  const outside = join(baseDir, 'outside.jpg'); writeFileSync(outside, jpeg);
  symlinkSync(outside, join(cwd, 'escape.jpg'));
  symlinkSync(baseDir, join(cwd, 'linked-directory'));
  const names = [...contents.keys(), 'missing.jpg', 'directory.jpg', 'escape.jpg', 'linked-directory/outside.jpg'];
  const text = names.map(name => `[${name}](<${join(cwd, name)}>)`).join('\n\n') + `\n\n[outside](<${outside}>)`;
  const assistant = { id: 'file-image-final', role: 'assistant', phase: 'final', text };
  let currentCwd = cwd, now = 10000, opens = 0;
  const fileOptions = typeof options.messageFiles === 'function' ? options.messageFiles({ baseDir, cwd }) : options.messageFiles;
  const app = makeApp({ dataDir: join(baseDir, 'data'), codexHome: baseDir,
    readSource: () => ({ threads: [a, b].map(id => ({ id, cwd: currentCwd, title: 'Image file fixture', archived: false, updatedAt: 1000 })), projects: [], sourceInfo: {} }),
    openThread: async () => { opens++; throw new Error('Unexpected owner open'); },
    desktopRequest: async () => ({ ok: true, source: 'desktop', runtime: 'idle', canSend: true, messages: [assistant] }),
    readHistory: () => ({ source: 'rollout', messages: [assistant] }),
    messageFiles: { now: () => now, ...fileOptions },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    rmSync(baseDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (path, { headers = {}, method = 'GET' } = {}) => fetch(base + path, {
    method, headers: { Authorization: `Bearer ${app.auth.localToken}`, ...headers },
  });
  // Undici derives Host from the URL. A raw loopback request tests the server's
  // actual hostile Host boundary rather than assuming fetch preserved a header.
  const requestHost = (path, host) => new Promise((resolve, reject) => {
    const call = httpRequest(base + path, { headers: { Authorization: `Bearer ${app.auth.localToken}`, Host: host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      response.on('error', reject);
    });
    call.on('error', reject); call.end();
  });
  const historyResponse = await request(`/api/tasks/${a}/history`);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  const files = history.messages[0].files;
  return { baseDir, cwd, outside, contents, text, history, files, base, request, requestHost, app,
    url: name => files[join(cwd, name)].url + '/image',
    setCwd: value => { currentCwd = value; app.sync(); },
    advance: milliseconds => { now += milliseconds; }, opens: () => opens };
}

async function assertJsonError(response, status, f, expectedMessage) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type'), /^application\/json\b/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = await response.text(), error = JSON.parse(body);
  assert.deepEqual(Object.keys(error), ['error']);
  assert.equal(typeof error.error, 'string');
  if (expectedMessage) assert.equal(error.error, expectedMessage);
  for (const privateValue of [f.baseDir, f.cwd, 'EPERM', 'EACCES', 'TCC']) assert.equal(body.includes(privateValue), false);
}

test('ordinary image file links gain an image preview without reminting Markdown image references or changing downloads', async t => {
  const f = await fixture(t);
  assert.equal(f.history.messages[0].text, f.text);
  assert.deepEqual(f.history.messages[0].images, {});
  assert.equal(f.files[f.outside], undefined, 'cwd-external links remain unregistered');
  for (const [name, type] of [['image.png', 'image/png'], ['photo.JPG', 'image/jpeg'], ['photo.jpeg', 'image/jpeg'],
    ['animation.gif', 'image/gif'], ['picture.webp', 'image/webp']]) {
    const ref = f.files[join(f.cwd, name)];
    assert.match(ref.url, new RegExp(`^/api/tasks/${a}/files/[a-f0-9]{64}$`));
    const preview = await f.request(ref.url + '/image');
    assert.equal(preview.status, 200, name);
    assert.equal(preview.headers.get('content-type'), type);
    assert.equal(preview.headers.get('content-disposition'), 'inline');
    assert.equal(preview.headers.get('content-length'), String(f.contents.get(name).length));
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(preview.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(preview.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(preview.headers.get('x-pocket-machine'), 'ged');
    assert.equal(digest(Buffer.from(await preview.arrayBuffer())), digest(f.contents.get(name)));
    const download = await f.request(ref.url);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(download.headers.get('content-disposition').split("UTF-8''")[1]), name);
    assert.equal(digest(Buffer.from(await download.arrayBuffer())), digest(f.contents.get(name)));
  }
  assert.equal(f.opens(), 0);
});

test('image file preview rejects fake signatures, unsupported formats, invalid sizes, missing and escaping targets as private JSON', async t => {
  const f = await fixture(t);
  for (const [name, status] of [['fake.jpg', 415], ['wrong-signature.jpg', 415], ['drawing.svg', 415], ['page.html', 415],
    ['large.jpg', 415], ['empty.jpg', 415], ['short.jpg', 415], ['directory.jpg', 415], ['missing.jpg', 404],
    ['escape.jpg', 403], ['linked-directory/outside.jpg', 403]]) {
    await assertJsonError(await f.request(f.url(name)), status, f);
  }
  for (const name of ['drawing.svg', 'page.html']) {
    const download = await f.request(f.files[join(f.cwd, name)].url);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition'), /^attachment;/);
    assert.equal(digest(Buffer.from(await download.arrayBuffer())), digest(readFileSync(join(f.cwd, name))));
  }
});

test('image file previews retain authentication, origin, host, exact capability and GET-only request boundaries', async t => {
  const f = await fixture(t), url = f.url('photo.JPG');
  for (const [headers, status] of [[{ Authorization: '' }, 401], [{ Origin: 'https://other.example' }, 403],
    [{ 'Sec-Fetch-Site': 'cross-site' }, 403]]) {
    await assertJsonError(await f.request(url, { headers }), status, f);
  }
  await assertJsonError(await f.requestHost(url, 'other.example'), 403, f);
  await assertJsonError(await f.request(url.replace(a, b)), 404, f);
  await assertJsonError(await f.request(`/api/tasks/${a}/files/${'0'.repeat(64)}/image`), 404, f);
  await assertJsonError(await f.request(`/api/tasks/${a}/files/${'0'.repeat(64)}/image?path=${encodeURIComponent(join(f.cwd, 'photo.JPG'))}`), 400, f);
  for (const query of ['?path=' + encodeURIComponent(f.outside), '?download=1', '?video=1', '?image=1', '?path=one&path=two'])
    await assertJsonError(await f.request(url + query), 400, f);
  const catalog = await f.request('/api/catalog').then(response => response.json());
  const headers = { Origin: f.base, 'X-Navigator-Token': catalog.csrfToken };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
    await assertJsonError(await f.request(url, { method, headers }), 405, f);
  const head = await f.request(url, { method: 'HEAD' });
  assert.equal(head.status, 405);
  assert.equal((await head.text()).length, 0);
  assert.equal(f.opens(), 0);
});

test('file image capability expires and cannot follow a changed thread cwd', async t => {
  const f = await fixture(t), url = f.url('photo.JPG');
  const alternate = join(f.baseDir, 'other-project'); mkdirSync(alternate);
  f.setCwd(alternate);
  await assertJsonError(await f.request(url), 404, f);
  f.setCwd(f.cwd);
  const restored = await f.request(url);
  assert.equal(restored.status, 200); await restored.arrayBuffer();
  f.advance(60 * 60 * 1000);
  await assertJsonError(await f.request(url), 404, f);
  assert.equal(f.opens(), 0);
});

for (const stage of ['realpath', 'open', 'read']) {
  for (const code of ['EPERM', 'EACCES']) {
    test(`file image HTTP ${code} at ${stage} preserves the fixed permission response and closes any descriptor`, async t => {
      let opened = false, closed = false;
      const f = await fixture(t, { messageFiles: ({ cwd }) => {
        const path = join(cwd, 'photo.JPG');
        const denied = () => Object.assign(new Error(`${code}: operation denied '${path}'`), { code, path });
        return {
          realpathFile: value => stage === 'realpath' && value === path ? Promise.reject(denied()) : realpath(value),
          openFile: async (value, flags) => {
            assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            if (stage === 'open') throw denied();
            const file = await open(value, flags); opened = true;
            return { stat: options => file.stat(options), read: (...args) => stage === 'read' ? Promise.reject(denied()) : file.read(...args),
              close: async () => { closed = true; await file.close(); } };
          },
        };
      } });
      await assertJsonError(await f.request(f.url('photo.JPG')), 403, f, permissionMessage);
      assert.equal(closed, opened);
      assert.equal(f.opens(), 0);
    });
  }
}

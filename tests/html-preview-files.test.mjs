import './helpers/block-native-open.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { once } from 'node:events';
import { MessageFiles } from '../server/message-files.mjs';
import { HTML_PREVIEW_LIMITS, relativePreviewImage } from '../server/html-preview.mjs';
import { makeApp } from '../server/index.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ0cAAAAASUVORK5CYII=', 'base64');
const assistant = text => ({ id: 'preview-message', role: 'assistant', phase: 'final', text });
const citation = path => `:codex-file-citation{path=${JSON.stringify(path)} purpose="output"}`;
const imageBytes = size => Buffer.concat([png.subarray(0, 8), Buffer.alloc(size - 8)]);
function fixture(t, html = '<h1>Static page</h1>', options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'pocket-html-preview-')), cwd = join(base, 'project'), folder = join(cwd, 'document');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, 'index.html'); writeFileSync(path, html);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const thread = { id, cwd }, service = new MessageFiles(options);
  const grant = (target = path) => service.attach(thread, { messages: [assistant(citation(target))] }).messages[0].files[target];
  const reference = grant(), key = reference.url.split('/').at(-1);
  return { base, cwd, folder, path, thread, service, reference, key, grant };
}
function wrappedFile(file, hooks = {}) {
  return {
    stat: (...args) => file.stat(...args),
    async read(...args) { await hooks.beforeRead?.(); const result = await file.read(...args); await hooks.afterRead?.(); return result; },
    async close() { await file.close(); hooks.afterClose?.(); },
  };
}

test('preview relative paths decode once without admitting URLs or document-directory escapes', () => {
  for (const source of ['image.png', './assets/图片.jpg', 'assets/with%20space.JPEG', 'assets/a.gif', 'assets/a.webp'])
    assert.ok(relativePreviewImage(source));
  for (const source of ['../secret.png', 'a/../../secret.jpg', '%2e%2e/secret.png', '%252e%252e/secret.png',
    '/absolute.png', '//elsewhere/image.png', 'https://example.invalid/photo.jpg', 'file:photo.jpg', 'data:image/png;base64,AA==',
    'file%3Aphoto.jpg', 'a\\image.png', 'a%5cimage.png', 'image.png?version=1', 'image.png#one', '%00image.jpg', 'photo.svg', 'file.txt'])
    assert.equal(relativePreviewImage(source), null, source);
});

test('a granted HTML preview preserves original bytes and embeds only actual document-relative raster images', async t => {
  const html = '<!doctype html><html lang="zh-CN"><style>h1{color:#123456}</style><h1>合成页面</h1>'
    + '<img src="assets/with%20space.png"><img src="assets/with%20space.png">'
    + '<script>const example="<img src=assets/not-an-image.png>"</script>'
    + '<template><img src="assets/template.png"></template><div data-source="assets/data.png"></div></html>';
  const f = fixture(t, html);
  mkdirSync(join(f.folder, 'assets')); writeFileSync(join(f.folder, 'assets', 'with space.png'), png);
  const result = await f.service.readHtmlPreview(f.thread, f.key);
  assert.equal(result.schemaVersion, 1); assert.equal(result.name, 'index.html');
  assert.deepEqual(Buffer.from(result.sourceBase64, 'base64'), readFileSync(f.path));
  assert.deepEqual(Object.keys(result.images), ['assets/with%20space.png']);
  assert.equal(result.images['assets/with%20space.png'].type, 'image/png');
  assert.deepEqual(Buffer.from(result.images['assets/with%20space.png'].base64, 'base64'), png);
  assert.equal(result.omittedImages, 0); assert.equal(f.service.activeHtmlPreviews, 0);
  assert.deepEqual((await f.service.read(f.thread, f.key)).bytes, readFileSync(f.path), 'The original download remains exact');
});

test('the preview preserves UTF-16 source bytes and rejects invalid encoding without lossy replacement', async t => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<h1>标题</h1><img src="image.png">', 'utf16le')]);
  const f = fixture(t, bytes); writeFileSync(join(f.folder, 'image.png'), png);
  const result = await f.service.readHtmlPreview(f.thread, f.key);
  assert.deepEqual(Buffer.from(result.sourceBase64, 'base64'), bytes); assert.equal(result.omittedImages, 0);
  writeFileSync(f.path, Buffer.from([0xc0, 0xaf]));
  await assert.rejects(f.service.readHtmlPreview(f.thread, f.key), failure => failure.status === 415);
  assert.equal(f.service.activeHtmlPreviews, 0);
});

test('raster filename extensions do not mislabel a valid image representation', async t => {
  const f = fixture(t, '<img src="downloaded.jpg"><img src="unknown.jpg">');
  writeFileSync(join(f.folder, 'downloaded.jpg'), png);
  writeFileSync(join(f.folder, 'unknown.jpg'), '<html>not a raster image</html>');
  const result = await f.service.readHtmlPreview(f.thread, f.key);
  assert.deepEqual(Object.keys(result.images), ['downloaded.jpg']);
  assert.equal(result.images['downloaded.jpg'].type, 'image/png');
  assert.deepEqual(Buffer.from(result.images['downloaded.jpg'].base64, 'base64'), png);
  assert.equal(result.omittedImages, 1);
});

test('preview capabilities retain thread, cwd, service identity and expiry boundaries', async t => {
  let at = 100;
  const f = fixture(t, undefined, { now: () => at });
  for (const thread of [{ ...f.thread, id: other }, { ...f.thread, cwd: f.folder }, { ...f.thread, cwd: '' }])
    await assert.rejects(f.service.readHtmlPreview(thread, f.key), failure => failure.status === 404);
  await assert.rejects(new MessageFiles().readHtmlPreview(f.thread, f.key), failure => failure.status === 404);
  at += 3600000;
  await assert.rejects(f.service.readHtmlPreview(f.thread, f.key), failure => failure.status === 404);
});

test('only HTML/HTM files preview, and source size/structure limits preserve the original download', async t => {
  const f = fixture(t);
  const svg = join(f.folder, 'image.svg'); writeFileSync(svg, '<svg/>');
  await assert.rejects(f.service.readHtmlPreview(f.thread, f.grant(svg).url.split('/').at(-1)), failure => failure.status === 415);
  writeFileSync(f.path, Buffer.alloc(HTML_PREVIEW_LIMITS.source + 1, 32));
  await assert.rejects(f.service.readHtmlPreview(f.thread, f.key), failure => failure.status === 413);
  assert.equal((await f.service.read(f.thread, f.key)).bytes.length, HTML_PREVIEW_LIMITS.source + 1);
  writeFileSync(f.path, '<div>'.repeat(300) + 'deep' + '</div>'.repeat(300));
  await assert.rejects(f.service.readHtmlPreview(f.thread, f.key), failure => failure.status === 415 && !failure.message.includes(f.base));
  assert.ok((await f.service.read(f.thread, f.key)).bytes.length);
});

test('missing, unsupported, traversal and escaping resources are omitted without granting more filesystem access', async t => {
  const html = '<img src="safe.png"><img src="missing.png"><img src="../outside.png"><img src="%2e%2e/outside.png">'
    + '<img src="escape.png"><img src="fake.png"><img src="other.svg"><img src="https://example.invalid/remote.png">';
  const f = fixture(t, html), outside = join(f.base, 'private.png');
  writeFileSync(join(f.folder, 'safe.png'), png); writeFileSync(outside, png);
  symlinkSync(outside, join(f.folder, 'escape.png')); writeFileSync(join(f.folder, 'fake.png'), '<html>not a PNG</html>');
  const result = await f.service.readHtmlPreview(f.thread, f.key);
  assert.deepEqual(Object.keys(result.images), ['safe.png']); assert.equal(result.omittedImages, 6);
  assert.equal(JSON.stringify(result).includes(f.base), false);
});

test('resource counts, per-image size and total bytes are independently bounded', async t => {
  const f = fixture(t, Array.from({ length: 33 }, (_, n) => `<img src="${n}.png">`).join(''));
  for (let n = 0; n < 33; n++) writeFileSync(join(f.folder, `${n}.png`), png);
  const count = await f.service.readHtmlPreview(f.thread, f.key);
  assert.equal(Object.keys(count.images).length, 32); assert.equal(count.omittedImages, 1);
  writeFileSync(f.path, '<img src="large.png">'); writeFileSync(join(f.folder, 'large.png'), imageBytes(HTML_PREVIEW_LIMITS.image + 1));
  const large = await f.service.readHtmlPreview(f.thread, f.key);
  assert.equal(Object.keys(large.images).length, 0); assert.equal(large.omittedImages, 1);
  writeFileSync(f.path, Array.from({ length: 5 }, (_, n) => `<img src="big${n}.png">`).join(''));
  for (let n = 0; n < 5; n++) writeFileSync(join(f.folder, `big${n}.png`), imageBytes(HTML_PREVIEW_LIMITS.image));
  const total = await f.service.readHtmlPreview(f.thread, f.key);
  assert.equal(Object.keys(total.images).length, 4); assert.equal(total.omittedImages, 1);
  assert.equal(Object.values(total.images).reduce((sum, image) => sum + Buffer.from(image.base64, 'base64').length, 0), HTML_PREVIEW_LIMITS.imageTotal);
});

test('an image parent-directory swap is detected before reading confidential replacement bytes', async t => {
  let f, imageReads = 0, imageCloses = 0;
  const outside = mkdtempSync(join(tmpdir(), 'pocket-preview-private-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'photo.png'), png);
  f = fixture(t, '<img src="assets/photo.png">', { openFile: async (path, flags) => {
    if (path.endsWith('/assets/photo.png')) {
      renameSync(join(f.folder, 'assets'), join(f.folder, 'old-assets'));
      symlinkSync(outside, join(f.folder, 'assets'), 'dir');
      return wrappedFile(await open(path, flags), { beforeRead: () => imageReads++, afterClose: () => imageCloses++ });
    }
    return open(path, flags);
  } });
  mkdirSync(join(f.folder, 'assets')); writeFileSync(join(f.folder, 'assets', 'photo.png'), png);
  const result = await f.service.readHtmlPreview(f.thread, f.key);
  assert.deepEqual(Object.keys(result.images), []); assert.equal(result.omittedImages, 1);
  assert.equal(imageReads, 0); assert.equal(imageCloses, 1);
});

test('a resource change during its FD read is omitted and a primary change rejects the whole bundle', async t => {
  let f, mutatePrimary = false, closes = 0;
  f = fixture(t, '<h1>Snapshot</h1><img src="photo.png">', { openFile: async (path, flags) => {
    const file = await open(path, flags);
    return path.endsWith('/photo.png') ? wrappedFile(file, { afterRead: () => {
      writeFileSync(mutatePrimary ? f.path : path, mutatePrimary ? '<h1>Changed source</h1>' : png);
    }, afterClose: () => closes++ }) : file;
  } });
  writeFileSync(join(f.folder, 'photo.png'), png);
  const changedImage = await f.service.readHtmlPreview(f.thread, f.key);
  assert.equal(changedImage.omittedImages, 1); assert.deepEqual(Object.keys(changedImage.images), []);
  mutatePrimary = true;
  await assert.rejects(f.service.readHtmlPreview(f.thread, f.key), failure => failure.status === 409);
  assert.equal(closes, 2); assert.equal(f.service.activeHtmlPreviews, 0);
});

test('expiring the original capability while assembling resources cannot return a bundle', async t => {
  let at = 100;
  const f = fixture(t, '<img src="photo.png">', { now: () => at, openFile: async (path, flags) => {
    const file = await open(path, flags);
    return path.endsWith('/photo.png') ? wrappedFile(file, { afterRead: () => { at += 3600000; } }) : file;
  } });
  writeFileSync(join(f.folder, 'photo.png'), png);
  await assert.rejects(f.service.readHtmlPreview(f.thread, f.key), failure => failure.status === 404);
});

test('concurrent bundle admission and cancellation release every held descriptor and slot', async t => {
  let release, closes = 0;
  const gate = new Promise(done => { release = done; });
  const f = fixture(t, '<h1>Cancelled preview</h1>', { openFile: async (path, flags) => {
    await gate; assert.ok(flags & constants.O_NOFOLLOW);
    return wrappedFile(await open(path, flags), { afterClose: () => closes++ });
  } });
  const controller = new AbortController();
  const one = f.service.readHtmlPreview(f.thread, f.key, { signal: controller.signal });
  const two = f.service.readHtmlPreview(f.thread, f.key);
  assert.equal(f.service.activeHtmlPreviews, 2);
  await assert.rejects(f.service.readHtmlPreview(f.thread, f.key), failure => failure.status === 503);
  controller.abort(); release();
  const result = await Promise.allSettled([one, two]);
  assert.equal(result[0].status, 'rejected'); assert.equal(result[0].reason.name, 'AbortError');
  assert.equal(result[1].status, 'fulfilled'); assert.equal(f.service.activeHtmlPreviews, 0);
  assert.ok(closes >= 1);
});

test('cancelling after the source descriptor opens discards its result and closes it', async t => {
  let enter, release, closes = 0;
  const entered = new Promise(done => { enter = done; }), gate = new Promise(done => { release = done; });
  const f = fixture(t, '<h1>Held read</h1>', { openFile: async (path, flags) => wrappedFile(await open(path, flags), {
    beforeRead: async () => { enter(); await gate; }, afterClose: () => closes++,
  }) });
  const controller = new AbortController(), request = f.service.readHtmlPreview(f.thread, f.key, { signal: controller.signal });
  await entered; controller.abort(); release();
  await assert.rejects(request, failure => failure.name === 'AbortError');
  assert.equal(closes, 1); assert.equal(f.service.activeHtmlPreviews, 0);
});

async function appFixture(t) {
  const f = fixture(t, '<h1>Protected HTML</h1><img src="photo.png">');
  writeFileSync(join(f.folder, 'photo.png'), png);
  let opens = 0;
  const text = citation(f.path), app = makeApp({ dataDir: join(f.base, 'data'), codexHome: f.base,
    readSource: () => ({ threads: [id, other].map(id => ({ id, cwd: f.cwd, title: 'Preview fixture', archived: false, updatedAt: 1000 })), projects: [], sourceInfo: {} }),
    openThread: async () => { opens++; throw new Error('Unexpected native owner'); },
    desktopRequest: async () => ({ ok: true, source: 'desktop', runtime: 'idle', canSend: true, messages: [assistant(text)] }),
    readHistory: () => ({ source: 'rollout', messages: [assistant(text)] }),
  });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(done => app.server.close(done)); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers: { Authorization: `Bearer ${app.auth.localToken}`, ...headers } });
  const history = await get(`/api/tasks/${id}/transcript`).then(response => response.json());
  return { ...f, app, base, get, url: history.messages[0].files[f.path].url, opens: () => opens };
}

test('HTTP preview is authenticated JSON while the original file remains a sandboxed attachment', async t => {
  const f = await appFixture(t), response = await f.get(f.url + '/preview');
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(response.headers.get('x-pocket-machine'), 'ged');
  const result = await response.json(); assert.equal(result.images['photo.png'].type, 'image/png');
  assert.deepEqual(Buffer.from(result.sourceBase64, 'base64'), readFileSync(f.path));
  const download = await f.get(f.url); assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment;/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), readFileSync(f.path));
  assert.equal(f.opens(), 0);
});

test('HTTP preview rejects anonymous, cross-site, foreign-thread and client path/query requests', async t => {
  const f = await appFixture(t), path = f.url + '/preview';
  assert.equal((await f.get(path, { Authorization: '' })).status, 401);
  assert.equal((await f.get(path, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await f.get(path, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.get(path.replace(id, other))).status, 404);
  assert.equal((await f.get(path + '?path=' + encodeURIComponent(f.path))).status, 400);
  assert.equal((await f.get(path + '?resource=photo.png')).status, 400);
  assert.equal((await f.get(`/api/tasks/${id}/files/${'0'.repeat(64)}/preview`)).status, 404);
  assert.equal(f.opens(), 0);
});

test('slow HTTP previews keep bounded response slots until drain or cancellation, and shutdown rejects new previews', async t => {
  const f = await appFixture(t);
  writeFileSync(f.path, Array.from({ length: 4 }, (_, n) => `<img src="large${n}.png">`).join(''));
  for (let n = 0; n < 4; n++) writeFileSync(join(f.folder, `large${n}.png`), imageBytes(HTML_PREVIEW_LIMITS.image));
  const port = f.app.server.address().port, sockets = [];
  t.after(() => sockets.forEach(socket => socket.destroy()));
  const paused = async () => {
    const socket = connect({ host: '127.0.0.1', port }); sockets.push(socket);
    const connected = once(socket, 'connect'); await connected;
    const first = once(socket, 'data');
    socket.write(`GET ${f.url}/preview HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${f.app.auth.localToken}\r\nConnection: close\r\n\r\n`);
    const [data] = await first; socket.pause();
    assert.match(data.toString('ascii', 0, 64), /^HTTP\/1.1 200 /);
    return socket;
  };
  await paused(); await paused();
  const denied = await f.get(f.url + '/preview'); assert.equal(denied.status, 503); await denied.arrayBuffer();
  const closed = sockets.map(socket => once(socket, 'close')); f.app.stopVideoStreams();
  sockets.forEach(socket => socket.destroy()); await Promise.all(closed);
  const stopped = await f.get(f.url + '/preview'); assert.equal(stopped.status, 503); await stopped.arrayBuffer();
  const download = await f.get(f.url); assert.equal(download.status, 200); await download.arrayBuffer();
});

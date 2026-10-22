import './helpers/block-native-open.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, truncateSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MessageFiles } from '../server/message-files.mjs';
import { makeApp } from '../server/index.mjs';

const a = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const citation = path => `:codex-file-citation{path=${JSON.stringify(path)} purpose="output"}`;
const link = path => `[下载文件](<${path}>)`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const assistant = text => ({ id: 'assistant-message', role: 'assistant', phase: 'final', text });
const fileKey = reference => reference.url.split('/').at(-1);
function directory(t) {
  const baseDir = mkdtempSync(join(tmpdir(), 'pocket-message-file-')), cwd = join(baseDir, 'project');
  mkdirSync(cwd);
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  return { baseDir, cwd, thread: { id: a, cwd } };
}
function grant(service, thread, path) {
  return service.attach(thread, { messages: [assistant(citation(path))] }).messages[0].files[path];
}

test('only complete visible assistant references grant files; prose, code and user examples do not', () => {
  const service = new MessageFiles(), cwd = '/synthetic/project', thread = { id: a, cwd };
  const path = join(cwd, '报告.docx'), markdownPath = join(cwd, 'review notes.pdf');
  const text = [citation(path), link(markdownPath), '[reference][report]', `[report]: <${join(cwd, 'report.csv')}>`,
    '`' + citation(join(cwd, 'inline.docx')) + '`', '```text\n' + citation(join(cwd, 'code.docx')) + '\n```',
    `[example](${encodeURI('/' + citation(join(cwd, 'target.docx')))})`,
    `Unlinked path: ${join(cwd, 'plain.docx')}`, '![image](/synthetic/project/image.png)',
    '[remote](https://example.test/document.docx)', link('/synthetic/elsewhere.docx')].join('\n\n');
  const history = { messages: [assistant(text), { ...assistant(citation(path)), role: 'user' },
    { ...assistant(citation(path)), role: 'system' }, { ...assistant(citation(path)), phase: 'analysis' },
    { ...assistant(citation(path)), truncated: true }, assistant(citation(path) + 'x'.repeat(128 * 1024))] };
  const original = structuredClone(history);
  const result = service.attach(thread, history);
  assert.deepEqual(Object.keys(result.messages[0].files), [path, markdownPath, join(cwd, 'report.csv')]);
  assert.ok(result.messages.slice(1).every(message => Object.keys(message.files).length === 0));
  assert.deepEqual(history, original, 'granting files never rewrites text or supplied messages');
  assert.equal(result.messages[0].text, text);
});

test('path keys preserve literal directive percent signs and decode Markdown URLs once', () => {
  const service = new MessageFiles(), thread = { id: a, cwd: '/synthetic/project' };
  const literal = '/synthetic/project/rate%20report.csv', decoded = '/synthetic/project/预算 总结.docx';
  const result = service.attach(thread, { messages: [assistant(`${citation(literal)}\n\n[doc](${encodeURI(decoded)})`)] });
  assert.deepEqual(Object.keys(result.messages[0].files), [literal, decoded]);
  assert.equal(result.messages[0].files[literal].name, 'rate%20report.csv');
  assert.equal(result.messages[0].files[decoded].name, '预算 总结.docx');
});

test('references are capped per history, stable on refresh and bounded in memory', async () => {
  let now = 10000;
  const service = new MessageFiles({ now: () => now }), thread = { id: a, cwd: '/synthetic/project' };
  const history = { messages: [assistant(Array.from({ length: 20 }, (_, index) => citation(`/synthetic/project/${index}.txt`)).join('\n')),
    assistant(Array.from({ length: 20 }, (_, index) => citation(`/synthetic/project/${20 + index}.txt`)).join('\n'))] };
  const first = service.attach(thread, history);
  assert.equal(Object.keys(first.messages[0].files).length, 20);
  assert.equal(Object.keys(first.messages[1].files).length, 12);
  assert.deepEqual(service.attach(thread, history), first);
  const oldKey = fileKey(Object.values(first.messages[0].files)[0]);
  for (let index = 0; index < 300; index++) grant(service, thread, `/synthetic/project/new-${index}.txt`);
  assert.equal(service.entries.size, 256);
  assert.equal(service.parsed.size, 128);
  await assert.rejects(service.read(thread, oldKey), error => error.status === 404);
  now += 3600000;
  grant(service, thread, '/synthetic/project/fresh.txt');
  assert.equal(service.entries.size, 1, 'expired capabilities are removed while minting a fresh history');
});

test('capabilities bind thread, current cwd, service identity and one-hour lifetime', async t => {
  const f = directory(t), path = join(f.cwd, 'document.txt');
  writeFileSync(path, 'synthetic document');
  let now = 10000;
  const service = new MessageFiles({ now: () => now }), reference = grant(service, f.thread, path), key = fileKey(reference);
  const original = (await service.read(f.thread, key)).bytes;
  assert.equal(original.toString(), 'synthetic document');
  for (const thread of [{ ...f.thread, id: b }, { ...f.thread, cwd: join(f.cwd, 'other') }, { ...f.thread, cwd: '' }])
    await assert.rejects(service.read(thread, key), error => error.status === 404);
  await assert.rejects(new MessageFiles().read(f.thread, key), error => error.status === 404);
  now += 3600000;
  await assert.rejects(service.read(f.thread, key), error => error.status === 404);
  assert.equal(readFileSync(path, 'utf8'), 'synthetic document');
});

test('root, relative cwd and lexical directory escapes cannot mint a capability', () => {
  const service = new MessageFiles(), path = '/synthetic/project/document.txt';
  for (const cwd of ['/', '', 'relative/project']) {
    const result = service.attach({ id: a, cwd }, { messages: [assistant(citation(path))] });
    assert.deepEqual(result.messages[0].files, {});
  }
  const result = service.attach({ id: a, cwd: '/synthetic/project' }, { messages: [assistant([
    citation('/synthetic/project/../secret.txt'), citation('/synthetic/project-neighbor/secret.txt'),
    citation('/synthetic/project'), citation('//server/share/private.txt')].join('\n'))] });
  assert.deepEqual(result.messages[0].files, {});
});

test('missing, non-regular, oversized and escaping symlink files fail without leaking paths', async t => {
  const f = directory(t), service = new MessageFiles();
  const outside = join(f.baseDir, 'outside.txt'); writeFileSync(outside, 'outside synthetic data');
  symlinkSync(outside, join(f.cwd, 'escape.txt'));
  symlinkSync(f.baseDir, join(f.cwd, 'linked-directory'));
  mkdirSync(join(f.cwd, 'directory'));
  writeFileSync(join(f.cwd, 'large.bin'), 'x'); truncateSync(join(f.cwd, 'large.bin'), 20 * 1024 * 1024 + 1);
  for (const [name, status] of [['missing.txt', 404], ['directory', 415], ['large.bin', 413],
    ['escape.txt', 403], ['linked-directory/outside.txt', 403]]) {
    const key = fileKey(grant(service, f.thread, join(f.cwd, name)));
    await assert.rejects(service.read(f.thread, key), error => error.status === status && !error.message.includes(f.baseDir), name);
  }
});

test('reads use NOFOLLOW and NONBLOCK and reject replacement between open and path verification', async t => {
  const f = directory(t), path = join(f.cwd, 'document.txt'); writeFileSync(path, 'original');
  let closed = false;
  const service = new MessageFiles({ openFile: async (value, flags) => {
    assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
    assert.equal(flags & constants.O_NONBLOCK, constants.O_NONBLOCK);
    const file = await open(value, flags);
    renameSync(path, join(f.cwd, 'old.txt')); writeFileSync(path, 'replaced');
    return { stat: options => file.stat(options), read: (...args) => file.read(...args),
      close: async () => { closed = true; await file.close(); } };
  } });
  await assert.rejects(service.read(f.thread, fileKey(grant(service, f.thread, path))), error => error.status === 409);
  assert.equal(closed, true);
});

test('growth during reading cannot expand the checked buffer or return a partial file', async t => {
  const f = directory(t), path = join(f.cwd, 'document.txt'); writeFileSync(path, 'original');
  let allocated = 0, closed = false;
  const service = new MessageFiles({ openFile: async (value, flags) => {
    const file = await open(value, flags);
    return { stat: options => file.stat(options), read: async (...args) => {
      allocated = args[0].length;
      const result = await file.read(...args);
      truncateSync(path, 20 * 1024 * 1024 + 1);
      return result;
    }, close: async () => { closed = true; await file.close(); } };
  } });
  await assert.rejects(service.read(f.thread, fileKey(grant(service, f.thread, path))), error => error.status === 409);
  assert.equal(allocated, Buffer.byteLength('original'));
  assert.equal(closed, true);
});

test('replacing the path while reading is rejected even when the open descriptor stays unchanged', async t => {
  const f = directory(t), path = join(f.cwd, 'document.txt'); writeFileSync(path, 'original');
  const service = new MessageFiles({ openFile: async (value, flags) => {
    const file = await open(value, flags);
    return { stat: options => file.stat(options), read: async (...args) => {
      const result = await file.read(...args);
      renameSync(path, join(f.cwd, 'old.txt')); writeFileSync(path, 'replaced');
      return result;
    }, close: () => file.close() };
  } });
  await assert.rejects(service.read(f.thread, fileKey(grant(service, f.thread, path))), error => error.status === 409);
});

test('empty regular files remain valid downloads', async t => {
  const f = directory(t), path = join(f.cwd, 'empty.txt'); writeFileSync(path, '');
  const service = new MessageFiles(), result = await service.read(f.thread, fileKey(grant(service, f.thread, path)));
  assert.equal(result.bytes.length, 0);
  assert.equal(result.type, 'application/octet-stream');
  assert.match(result.disposition, /^attachment;/);
});

async function appFixture(t) {
  const baseDir = mkdtempSync(join(tmpdir(), 'pocket-message-file-http-')), cwd = join(baseDir, 'project');
  mkdirSync(cwd);
  const f = { baseDir, cwd, thread: { id: a, cwd } }, name = "设计稿 '最终'.docx", documentPath = join(f.cwd, name);
  const contents = Buffer.from('PK\x03\x04synthetic document content');
  writeFileSync(documentPath, contents);
  const htmlPath = join(f.cwd, 'page.html'), svgPath = join(f.cwd, 'drawing.svg');
  writeFileSync(htmlPath, '<script>throw new Error("must download")</script>');
  writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  const text = [citation(documentPath), link(htmlPath), citation(svgPath)].join('\n\n');
  let opens = 0;
  const app = makeApp({ dataDir: join(f.baseDir, 'data'), codexHome: f.baseDir,
    readSource: () => ({ threads: [a, b].map(id => ({ id, cwd: f.cwd, title: 'File fixture', archived: false, updatedAt: 1000 })), projects: [], sourceInfo: {} }),
    openThread: async () => { opens++; throw new Error('Unexpected owner open'); },
    desktopRequest: async () => ({ ok: true, source: 'desktop', runtime: 'idle', canSend: true, messages: [assistant(text)] }),
    readHistory: () => ({ source: 'rollout', messages: [assistant(text)] }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    rmSync(baseDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers: { Authorization: `Bearer ${app.auth.localToken}`, ...headers } });
  return { ...f, name, documentPath, contents, htmlPath, svgPath, text, app, base, get, opens: () => opens };
}

test('history and transcript return the same protected file entry while keeping message text', async t => {
  const f = await appFixture(t);
  const history = await f.get(`/api/tasks/${a}/history`).then(response => response.json());
  const transcript = await f.get(`/api/tasks/${a}/transcript`).then(response => response.json());
  assert.equal(history.messages[0].text, f.text); assert.equal(transcript.messages[0].text, f.text);
  assert.deepEqual(history.messages[0].files, transcript.messages[0].files);
  assert.deepEqual(history.messages[0].images, {});
  const reference = history.messages[0].files[f.documentPath];
  assert.equal(reference.name, f.name);
  assert.match(reference.url, new RegExp(`^/api/tasks/${a}/files/[a-f0-9]{64}$`));
  assert.equal(f.opens(), 0);
});

test('file GET returns exact bytes and UTF-8 attachment headers; HTML and SVG never render inline', async t => {
  const f = await appFixture(t);
  const history = await f.get(`/api/tasks/${a}/history`).then(response => response.json());
  for (const path of [f.documentPath, f.htmlPath, f.svgPath]) {
    const reference = history.messages[0].files[path], response = await f.get(reference.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('content-length'), String(readFileSync(path).length));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox");
    assert.equal(response.headers.get('x-pocket-machine'), 'ged');
    assert.match(response.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(response.headers.get('content-disposition').split("UTF-8''")[1]), reference.name);
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(readFileSync(path)));
  }
});

test('file URLs reject anonymous/cross-site/foreign-thread requests and never accept an arbitrary path', async t => {
  const f = await appFixture(t);
  const history = await f.get(`/api/tasks/${a}/history`).then(response => response.json());
  const url = history.messages[0].files[f.documentPath].url;
  assert.equal((await f.get(url, { Authorization: '' })).status, 401);
  assert.equal((await f.get(url, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.get(url, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.get(url.replace(a, b))).status, 404);
  assert.equal((await f.get(`/api/tasks/${a}/files/${'0'.repeat(64)}?path=${encodeURIComponent(f.documentPath)}`)).status, 404);
  const response = await f.get(url + `?path=${encodeURIComponent(f.htmlPath)}`);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(f.contents), 'query parameters cannot replace a bound path');
  rmSync(f.documentPath);
  const missing = await f.get(url);
  assert.equal(missing.status, 404); assert.equal((await missing.text()).includes(f.baseDir), false);
  assert.equal(f.opens(), 0);
});

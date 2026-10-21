import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { makeApp } from '../server/index.mjs';
import { MessageImages, referencedImages } from '../server/message-images.mjs';

const a = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('Markdown grants only actual local image nodes, including reference images and encoded paths', () => {
  const text = ['![plain](/workspace/a.png)', '![space](</workspace/a b.jpg>)', '![ref][plot]', '[plot]: /workspace/c.webp',
    '`![code](/workspace/no.png)`', '```', '![code](/workspace/no2.jpg)', '```',
    '[file](/workspace/no3.png)', '![remote](https://example.com/image.png)', '![svg](/workspace/no.svg)', '![network](//example.com/a.png)'].join('\n\n');
  assert.deepEqual(referencedImages(text), ['/workspace/a.png', '/workspace/a b.jpg', '/workspace/c.webp']);
});

async function fixture(t) {
  const baseDir = mkdtempSync(join(tmpdir(), 'pocket-image-test-')), cwd = join(baseDir, 'project');
  mkdirSync(cwd);
  const names = ['a b.png', 'pretend.png', 'large.png', 'gone.jpg', 'linked.png'];
  writeFileSync(join(cwd, names[0]), png);writeFileSync(join(cwd, names[1]), '<html>private data</html>');
  writeFileSync(join(cwd, names[2]), png);truncateSync(join(cwd, names[2]), 8 * 1024 * 1024 + 1);
  writeFileSync(join(baseDir, 'outside.png'), png);symlinkSync(join(baseDir, 'outside.png'), join(cwd, names[4]));
  const text = names.map(n => `![${n}](<${join(cwd, n)}>)`).join('\n\n') + `\n\n![outside](${join(baseDir, 'outside.png')})`;
  const app = makeApp({ dataDir: join(baseDir, 'data'), codexHome: baseDir, readSource: () => ({ threads: [a,b].map(id => ({ id, cwd, title: '图片测试', archived: false, updatedAt: 1000 })), projects: [], sourceInfo: {} }),
    desktopRequest: async () => ({ ok: true, source: 'desktop', runtime: 'idle', canSend: true, messages: [{ id: 'message', role: 'assistant', text }] }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve));rmSync(baseDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = (path, headers = {}) => fetch(base + path, { headers: { Authorization: `Bearer ${app.auth.localToken}`, ...headers } });
  const data = await (await get(`/api/tasks/${a}/history`)).json();
  return { get, cwd, baseDir, refs: data.messages[0].images };
}

test('image GET serves the referenced bytes with private same-origin headers and no arbitrary path', async t => {
  const f = await fixture(t), url = f.refs[join(f.cwd, 'a b.png')];
  assert.match(url, new RegExp(`^/api/tasks/${a}/images/[a-f0-9]{64}$`));
  assert.equal(Object.keys(f.refs).length, 5);
  const r = await f.get(url);
  assert.equal(r.status, 200);assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('cache-control'), 'no-store');assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.equal(hash(Buffer.from(await r.arrayBuffer())), hash(png));
  assert.equal((await f.get(url.replace(a,b))).status, 404);
  assert.equal((await f.get(`/api/tasks/${a}/images/${'0'.repeat(64)}?path=${encodeURIComponent(join(f.cwd,'a b.png'))}`)).status, 404);
});

test('image access rejects anonymous, cross-site, oversized, missing, fake and escaping symlink targets', async t => {
  const f = await fixture(t), url = f.refs[join(f.cwd, 'a b.png')];
  assert.equal((await f.get(url, { Authorization: '' })).status, 401);
  assert.equal((await f.get(url, { Origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await f.get(url, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const [name,status] of [['pretend.png',415],['large.png',415],['gone.jpg',404],['linked.png',403]]) {
    const r = await f.get(f.refs[join(f.cwd,name)]);assert.equal(r.status,status,name);
    assert.equal((await r.text()).includes(f.baseDir), false);
  }
});

test('references are bounded, stable during history refresh, and tied to the current workspace', async () => {
  const service = new MessageImages(), thread = {id:a,cwd:'/workspace/project'};
  const history = {messages:[{id:'x',text:Array.from({length:40},(_,i)=>`![i](/workspace/project/${i}.jpg)`).join('\n')}]};
  const first = service.attach(thread, history).messages[0].images;
  assert.equal(Object.keys(first).length,32);assert.deepEqual(service.attach(thread,history).messages[0].images,first);
  assert.equal(history.messages[0].images, undefined);
  const key = Object.values(first)[0].split('/').at(-1);
  await assert.rejects(service.read({...thread,cwd:'/elsewhere'},key), e=>e.status===404);
  service.entries.get(key).at=0;
  await assert.rejects(service.read(thread,key), e=>e.status===404);
});

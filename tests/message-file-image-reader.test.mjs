import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, mkdtempSync, mkdirSync, writeFileSync, renameSync, truncateSync, rmSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageFiles } from '../server/message-files.mjs';
import { MessageImages } from '../server/message-images.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const permissionMessage = 'Mac 服务无权读取这张图片，请在电脑上检查文件访问权限';

function fixture(t) {
  const baseDir = mkdtempSync(join(tmpdir(), 'pocket-file-image-reader-')), cwd = join(baseDir, 'project');
  mkdirSync(cwd);
  const path = join(cwd, 'plot.png'); writeFileSync(path, png);
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  return { baseDir, path, thread: { id, cwd } };
}

const readers = [
  { name: 'file preview', create: options => new MessageFiles(options), text: path => `[plot](<${path}>)`,
    key: (message, path) => message.files[path].url.split('/').at(-1), read: (service, thread, key) => service.readImage(thread, key) },
  { name: 'Markdown image', create: options => new MessageImages(options), text: path => `![plot](<${path}>)`,
    key: (message, path) => message.images[path].split('/').at(-1), read: (service, thread, key) => service.read(thread, key) },
];
function grant(reader, service, f) {
  const message = service.attach(f.thread, { messages: [{ role: 'assistant', phase: 'final', text: reader.text(f.path) }] }).messages[0];
  return reader.key(message, f.path);
}

for (const reader of readers) {
  for (const change of ['replacement-before-read', 'replacement-during-read', 'growth', 'shrink', 'root-moved']) {
    test(`${reader.name} rejects ${change} with bounded reads and closes its descriptor`, async t => {
      const f = fixture(t); let closed = false, mutated = false, rootChecks = 0;
      const allocated = [];
      const service = reader.create({
        realpathFile: async value => {
          if (change === 'root-moved' && value === f.thread.cwd && ++rootChecks > 1) return f.baseDir;
          return realpath(value);
        },
        openFile: async (value, flags) => {
          assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const file = await open(value, flags);
          if (change === 'replacement-before-read') {
            renameSync(f.path, f.path + '.old'); writeFileSync(f.path, png); mutated = true;
          }
          return { stat: options => file.stat(options), read: async (...args) => {
            allocated.push(args[0].length);
            const result = await file.read(...args);
            if (!mutated) {
              if (change === 'replacement-during-read') { renameSync(f.path, f.path + '.old'); writeFileSync(f.path, png); mutated = true; }
              if (change === 'growth') { truncateSync(f.path, 8 * 1024 * 1024 + 1); mutated = true; }
              if (change === 'shrink') { truncateSync(f.path, 12); mutated = true; }
            }
            return result;
          }, close: async () => { closed = true; await file.close(); } };
        },
      });
      await assert.rejects(reader.read(service, f.thread, grant(reader, service, f)), error => {
        assert.equal(error.status, 409);
        assert.equal(error.message.includes(f.baseDir), false);
        return true;
      });
      assert.equal(closed, true);
      assert.ok(allocated.every(size => size <= png.length), 'growth never increases the checked allocation');
    });
  }

  test(`${reader.name} tolerates partial filesystem reads without weakening signature verification`, async t => {
    const f = fixture(t), service = reader.create({ openFile: async (value, flags) => {
      const file = await open(value, flags);
      return { stat: options => file.stat(options), read: (buffer, offset, length, position) => file.read(buffer, offset, Math.min(length, 3), position),
        close: () => file.close() };
    } });
    const result = await reader.read(service, f.thread, grant(reader, service, f));
    assert.equal(result.type, 'image/png'); assert.deepEqual(result.bytes, png);
  });
}

for (const stage of ['root-realpath', 'image-realpath', 'open', 'stat', 'read']) {
  test(`file image preview sanitizes permission and missing-file failures at ${stage}`, async t => {
    const f = fixture(t);
    for (const [code, status, message] of [['EPERM', 403, permissionMessage], ['EACCES', 403, permissionMessage], ['ENOENT', 404, '图片暂时无法读取']]) {
      await t.test(code, async () => {
        const native = Object.assign(new Error(`${code}: access denied at ${f.path}`), { code, path: f.path });
        let opened = false, closed = false, failed = false;
        const service = new MessageFiles({
          realpathFile: async value => {
            if (stage === 'root-realpath' && value === f.thread.cwd || stage === 'image-realpath' && value === f.path) {
              failed = true; throw native;
            }
            return realpath(value);
          },
          openFile: async (value, flags) => {
            if (stage === 'open') { failed = true; throw native; }
            const file = await open(value, flags); opened = true;
            return { stat: options => {
              if (stage === 'stat') { failed = true; throw native; }
              return file.stat(options);
            }, read: (...args) => {
              if (stage === 'read') { failed = true; throw native; }
              return file.read(...args);
            }, close: async () => { closed = true; await file.close(); } };
          },
        });
        await assert.rejects(service.readImage(f.thread, grant(readers[0], service, f)), error => {
          assert.equal(error.status, status); assert.equal(error.message, message);
          assert.equal(error.code, undefined); assert.equal(error.path, undefined); assert.equal(error.cause, undefined);
          assert.equal(error.message.includes(code), false); assert.equal(error.message.includes(f.path), false);
          return true;
        });
        assert.equal(failed, true); assert.equal(closed, opened);
      });
    }
  });
}

test('file image preview validates the existing capability before touching the filesystem', async t => {
  const f = fixture(t); let at = 10000, reads = 0;
  const service = new MessageFiles({ now: () => at, realpathFile: async value => { reads++; return realpath(value); } });
  const key = grant(readers[0], service, f);
  for (const thread of [{ ...f.thread, id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb' }, { ...f.thread, cwd: f.baseDir }, { ...f.thread, cwd: '' }])
    await assert.rejects(service.readImage(thread, key), error => error.status === 404);
  await assert.rejects(service.readImage(f.thread, '0'.repeat(64)), error => error.status === 404);
  at = 10000 + 3600000;
  await assert.rejects(service.readImage(f.thread, key), error => error.status === 404);
  at = 9999;
  await assert.rejects(service.readImage(f.thread, key), error => error.status === 404);
  assert.equal(reads, 0, 'invalid, foreign, expired and clock-reversed capabilities perform no file lookup');
});

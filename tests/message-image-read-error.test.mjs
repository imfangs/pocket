import test from 'node:test';
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageImages } from '../server/message-images.mjs';
import { messageImageReadError } from '../server/message-image-read-error.mjs';
import { AppError } from '../server/store.mjs';

const id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64');
const permissionMessage = 'Mac 服务无权读取这张图片，请在电脑上检查文件访问权限';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'pocket-image-read-error-'));
  const path = join(cwd, 'private-image.png');
  await writeFile(path, png);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { thread: { id, cwd }, path };
}

function reference(service, thread, path) {
  const message = service.attach(thread, { messages: [{ role: 'assistant', text: `![图示](${path})` }] }).messages[0];
  assert.ok(message.images[path], 'the test exercises a registered image read');
  return message.images[path].split('/').at(-1);
}

for (const stage of ['root-realpath', 'image-realpath', 'open', 'read']) {
  test(`native access failures at ${stage} retain a readable, private image error`, async t => {
    const { thread, path } = await fixture(t);
    for (const [code, status, message] of [
      ['EPERM', 403, permissionMessage],
      ['EACCES', 403, permissionMessage],
      ['ENOENT', 404, '图片暂时无法读取'],
    ]) {
      await t.test(code, async () => {
        const native = Object.assign(new Error(`${code}: filesystem operation denied, '${path}'`), { code, path });
        let failed = false, opened = false, closed = false;
        const service = new MessageImages({
          realpathFile: async value => {
            if (stage === 'root-realpath' && value === thread.cwd || stage === 'image-realpath' && value === path) {
              failed = true; throw native;
            }
            return realpath(value);
          },
          openFile: async (value, flags) => {
            assert.equal(value, await realpath(path));
            assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            if (stage === 'open') { failed = true; throw native; }
            const file = await open(value, flags);
            opened = true;
            return {
              stat: options => file.stat(options),
              read: (...args) => {
                if (stage === 'read') { failed = true; throw native; }
                return file.read(...args);
              },
              close: async () => { closed = true; await file.close(); },
            };
          },
        });
        await assert.rejects(service.read(thread, reference(service, thread, path)), error => {
          assert.equal(error.status, status);
          assert.equal(error.message, message);
          assert.equal(error.code, undefined);
          assert.equal(error.path, undefined);
          assert.equal(error.cause, undefined);
          assert.equal(error.message.includes(path), false);
          assert.equal(error.message.includes(code), false);
          assert.equal(error.message.includes('TCC'), false);
          return true;
        });
        assert.equal(failed, true, 'the injected filesystem boundary was reached');
        assert.equal(closed, opened, 'any opened descriptor is closed after the read failure');
      });
    }
  });
}

test('explicit image validation errors preserve their status and identity', () => {
  for (const [message, status] of [
    ['图片不在任务目录内', 403],
    ['图片格式暂不支持', 415],
    ['图片正在更新，请稍后重试', 409],
  ]) {
    const error = new AppError(message, status);
    assert.equal(messageImageReadError(error), error);
  }
});

test('a valid image still returns its original bytes through the default filesystem reader', async t => {
  const { thread, path } = await fixture(t), service = new MessageImages();
  const result = await service.read(thread, reference(service, thread, path));
  assert.equal(result.type, 'image/png');
  assert.deepEqual(result.bytes, png);
});
